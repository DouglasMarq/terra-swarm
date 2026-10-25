export type SpawnQueueStatus = "succeeded" | "failed" | "cancelled";

export type SpawnTaskContext = {
  id: string;
  signal: AbortSignal;
  isCancelled: () => boolean;
};

export type SpawnTaskRunner<Input, Output> = (
  input: Input,
  context: SpawnTaskContext,
) => Output | PromiseLike<Output>;

export type SpawnQueueItem<Input, Output> = {
  id: string;
  input: Input;
  run?: SpawnTaskRunner<Input, Output>;
};

export type SpawnQueueResult<Output> = {
  id: string;
  status: SpawnQueueStatus;
  value?: Output;
  error?: unknown;
  startedAt: number | null;
  finishedAt: number;
};

type SpawnOutcome<Output> = Pick<SpawnQueueResult<Output>, "status" | "value" | "error">;

export type SpawnQueueOptions<Input, Output> = {
  concurrency?: number;
  run?: SpawnTaskRunner<Input, Output>;
  now: () => number;
  onResult?: (result: SpawnQueueResult<Output>) => void;
};

export type SpawnQueue<Input, Output> = {
  enqueue: {
    (item: SpawnQueueItem<Input, Output>): Promise<SpawnQueueResult<Output>>;
    (
      id: string,
      input: Input,
      run?: SpawnTaskRunner<Input, Output>,
    ): Promise<SpawnQueueResult<Output>>;
  };
  add: SpawnQueue<Input, Output>["enqueue"];
  cancel: (id: string, reason?: unknown) => boolean;
  cancelAll: (reason?: unknown) => number;
  setConcurrency: (concurrency: number) => void;
  whenIdle: () => Promise<readonly SpawnQueueResult<Output>[]>;
  drain: () => Promise<readonly SpawnQueueResult<Output>[]>;
  results: () => readonly SpawnQueueResult<Output>[];
  pending: () => number;
  active: () => number;
};

type InternalItem<Input, Output> = SpawnQueueItem<Input, Output> & {
  controller: AbortController;
  status: "pending" | "running";
  startedAt: number | null;
  isCancelRequested: boolean;
  cancelReason?: unknown;
  resolve: (result: SpawnQueueResult<Output>) => void;
};

const DEFAULT_CONCURRENCY = 1;

function checkedConcurrency(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CONCURRENCY;
  if (!Number.isFinite(value) || value < 1) {
    throw new RangeError("spawn queue concurrency must be a positive number");
  }
  return Math.max(1, Math.floor(value));
}

function normalizeId(id: string): string {
  const normalized = id.trim();
  if (normalized.length === 0) throw new TypeError("spawn queue item id is required");
  return normalized;
}

function cancellationReason(reason: unknown): unknown {
  return reason ?? new Error("spawn task cancelled");
}

export function createSpawnQueue<Input, Output>(
  options: SpawnQueueOptions<Input, Output>,
): SpawnQueue<Input, Output> {
  let concurrency = checkedConcurrency(options.concurrency);
  let running = 0;
  let idleWaiters: Array<{
    ids: ReadonlySet<string>;
    resolve: (results: readonly SpawnQueueResult<Output>[]) => void;
  }> = [];

  const items = new Map<string, InternalItem<Input, Output>>();
  const settled = new Map<string, SpawnQueueResult<Output>>();

  const notifyIdle = (): void => {
    if (running !== 0 || [...items.values()].some((item) => item.status === "pending")) {
      return;
    }
    if (idleWaiters.length === 0) return;
    const results = [...settled.values()];
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const waiter of waiters) {
      waiter.resolve(results.filter((result) => waiter.ids.has(result.id)));
    }
  };

  const finish = (item: InternalItem<Input, Output>, outcome: SpawnOutcome<Output>): void => {
    const { status, value, error } = outcome;
    const result: SpawnQueueResult<Output> = {
      id: item.id,
      status,
      ...(value === undefined ? {} : { value }),
      ...(error === undefined ? {} : { error }),
      startedAt: item.startedAt,
      finishedAt: options.now(),
    };
    settled.set(item.id, result);
    items.delete(item.id);
    if (item.status === "running") running -= 1;
    try {
      options.onResult?.(result);
    } catch {}
    item.resolve(result);
    notifyIdle();
  };

  const startNext = (): void => {
    while (running < concurrency) {
      const item = [...items.values()].find((candidate) => candidate.status === "pending");
      if (!item) break;

      if (item.isCancelRequested) {
        finish(item, { status: "cancelled", error: item.cancelReason });
        continue;
      }

      item.status = "running";
      item.startedAt = options.now();
      running += 1;
      const runner = item.run ?? options.run;

      if (!runner) {
        finish(item, { status: "failed", error: new Error("spawn queue item has no runner") });
        continue;
      }

      Promise.resolve()
        .then(() =>
          runner(item.input, {
            id: item.id,
            signal: item.controller.signal,
            isCancelled: () => item.isCancelRequested,
          }),
        )
        .then(
          (value) => {
            if (item.isCancelRequested) {
              finish(item, { status: "cancelled", error: item.cancelReason });
            } else {
              finish(item, { status: "succeeded", value });
            }
            startNext();
          },
          (error: unknown) => {
            if (item.isCancelRequested) {
              finish(item, { status: "cancelled", error: item.cancelReason ?? error });
            } else {
              finish(item, { status: "failed", error });
            }
            startNext();
          },
        );
    }
    notifyIdle();
  };

  const enqueue = (
    itemOrId: SpawnQueueItem<Input, Output> | string,
    input?: Input,
    run?: SpawnTaskRunner<Input, Output>,
  ): Promise<SpawnQueueResult<Output>> => {
    const item: SpawnQueueItem<Input, Output> =
      typeof itemOrId === "string"
        ? { id: itemOrId, input: input as Input, run }
        : itemOrId;
    const id = normalizeId(item.id);
    if (items.has(id)) throw new Error(`spawn queue item already exists: ${id}`);

    let resolve!: (result: SpawnQueueResult<Output>) => void;
    const promise = new Promise<SpawnQueueResult<Output>>((next) => {
      resolve = next;
    });
    items.set(id, {
      ...item,
      id,
      controller: new AbortController(),
      status: "pending",
      startedAt: null,
      isCancelRequested: false,
      resolve,
    });
    startNext();
    return promise;
  };

  const cancel = (id: string, reason?: unknown): boolean => {
    const item = items.get(id);
    if (!item) return false;
    item.isCancelRequested = true;
    item.cancelReason = cancellationReason(reason);
    item.controller.abort(item.cancelReason);
    if (item.status === "pending") {
      finish(item, { status: "cancelled", error: item.cancelReason });
      startNext();
    }
    return true;
  };

  const cancelAll = (reason?: unknown): number => {
    const ids = [...items.keys()];
    for (const id of ids) cancel(id, reason);
    return ids.length;
  };

  const whenIdle = (): Promise<readonly SpawnQueueResult<Output>[]> => {
    const ids = new Set(items.keys());
    if (ids.size === 0) return Promise.resolve([...settled.values()]);
    return new Promise((resolve) => {
      idleWaiters.push({ ids, resolve });
      notifyIdle();
    });
  };

  const queue: SpawnQueue<Input, Output> = {
    enqueue: enqueue as SpawnQueue<Input, Output>["enqueue"],
    add: enqueue as SpawnQueue<Input, Output>["enqueue"],
    cancel,
    cancelAll,
    setConcurrency: (next) => {
      concurrency = checkedConcurrency(next);
      startNext();
    },
    whenIdle,
    drain: whenIdle,
    results: () => [...settled.values()],
    pending: () => [...items.values()].filter((item) => item.status === "pending").length,
    active: () => running,
  };
  return queue;
}
