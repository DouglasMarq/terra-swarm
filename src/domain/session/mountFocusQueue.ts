/**
 * Serializes mount/focus transitions. UI adapters can enqueue effects here;
 * this module itself has no dependency on a renderer or browser APIs.
 */

export type MountFocusPhase = "mount" | "focus";
export type MountFocusStatus = "completed" | "failed" | "cancelled";

export type MountFocusContext = {
  id: string;
  signal: AbortSignal;
  isCancelled: () => boolean;
};

export type MountFocusEffect = {
  id: string;
  mount?: (context: MountFocusContext) => unknown | PromiseLike<unknown>;
  focus?: (context: MountFocusContext) => unknown | PromiseLike<unknown>;
  /** Pending effects with the same key may be replaced by a newer request. */
  coalesceKey?: string;
};

export type MountFocusResult = {
  id: string;
  status: MountFocusStatus;
  phase?: MountFocusPhase;
  error?: unknown;
  startedAt: number;
  finishedAt: number;
};

type MountFocusOutcome = Pick<MountFocusResult, "status" | "phase" | "error">;

export type MountFocusQueue = {
  enqueue: (effect: MountFocusEffect) => Promise<MountFocusResult>;
  add: (effect: MountFocusEffect) => Promise<MountFocusResult>;
  cancel: (id: string, reason?: unknown) => boolean;
  cancelAll: (reason?: unknown) => number;
  whenIdle: () => Promise<readonly MountFocusResult[]>;
  drain: () => Promise<readonly MountFocusResult[]>;
  results: () => readonly MountFocusResult[];
  pending: () => number;
  active: () => number;
};

type InternalEffect = MountFocusEffect & {
  controller: AbortController;
  status: "pending" | "running";
  isCancelRequested: boolean;
  cancelReason?: unknown;
  startedAt: number;
  resolve: (result: MountFocusResult) => void;
};

function idFor(value: string): string {
  const id = value.trim();
  if (!id) throw new TypeError("mount/focus effect id is required");
  return id;
}

function reasonFor(reason: unknown): unknown {
  return reason ?? new Error("mount/focus effect cancelled");
}

/** `now` is the clock for `startedAt` / `finishedAt`, in milliseconds. */
export function createMountFocusQueue(now: () => number): MountFocusQueue {
  const effects = new Map<string, InternalEffect>();
  const settled = new Map<string, MountFocusResult>();
  let running = 0;
  let idleWaiters: Array<{
    ids: ReadonlySet<string>;
    resolve: (results: readonly MountFocusResult[]) => void;
  }> = [];

  const notifyIdle = (): void => {
    if (running !== 0 || [...effects.values()].some((effect) => effect.status === "pending")) {
      return;
    }
    const waiters = idleWaiters;
    idleWaiters = [];
    const all = [...settled.values()];
    for (const waiter of waiters) waiter.resolve(all.filter((result) => waiter.ids.has(result.id)));
  };

  const finish = (effect: InternalEffect, outcome: MountFocusOutcome): void => {
    const { status, phase, error } = outcome;
    const result: MountFocusResult = {
      id: effect.id,
      status,
      ...(phase === undefined ? {} : { phase }),
      ...(error === undefined ? {} : { error }),
      startedAt: effect.startedAt,
      finishedAt: now(),
    };
    settled.set(effect.id, result);
    effects.delete(effect.id);
    if (effect.status === "running") running -= 1;
    effect.resolve(result);
    notifyIdle();
  };

  const process = async (effect: InternalEffect): Promise<void> => {
    if (effect.isCancelRequested) {
      finish(effect, { status: "cancelled", error: effect.cancelReason });
      return;
    }

    const context: MountFocusContext = {
      id: effect.id,
      signal: effect.controller.signal,
      isCancelled: () => effect.isCancelRequested,
    };

    if (effect.mount) {
      try {
        await effect.mount(context);
      } catch (error) {
        if (effect.isCancelRequested) finish(effect, { status: "cancelled", phase: "mount", error: effect.cancelReason ?? error });
        else finish(effect, { status: "failed", phase: "mount", error });
        return;
      }
      if (effect.isCancelRequested) {
        finish(effect, { status: "cancelled", phase: "mount", error: effect.cancelReason });
        return;
      }
    }

    if (effect.focus) {
      try {
        await effect.focus(context);
      } catch (error) {
        if (effect.isCancelRequested) finish(effect, { status: "cancelled", phase: "focus", error: effect.cancelReason ?? error });
        else finish(effect, { status: "failed", phase: "focus", error });
        return;
      }
      if (effect.isCancelRequested) {
        finish(effect, { status: "cancelled", phase: "focus", error: effect.cancelReason });
        return;
      }
    }

    finish(effect, { status: "completed" });
  };

  const startNext = (): void => {
    if (running > 0) return;
    const effect = [...effects.values()].find((candidate) => candidate.status === "pending");
    if (!effect) {
      notifyIdle();
      return;
    }
    effect.status = "running";
    running = 1;
    void process(effect).then(startNext, (error: unknown) => {
      // Effect functions are already guarded, but keep a final safety net so
      // one malformed thenable cannot leave the serial queue blocked.
      finish(effect, { status: effect.isCancelRequested ? "cancelled" : "failed", error });
      startNext();
    });
  };

  const enqueue = (input: MountFocusEffect): Promise<MountFocusResult> => {
    const id = idFor(input.id);
    if (effects.has(id)) throw new Error(`mount/focus effect already exists: ${id}`);

    if (input.coalesceKey) {
      for (const current of effects.values()) {
        if (current.status === "pending" && current.coalesceKey === input.coalesceKey) {
          current.isCancelRequested = true;
          current.cancelReason = new Error("replaced by a newer mount/focus effect");
          current.controller.abort(current.cancelReason);
          finish(current, { status: "cancelled", error: current.cancelReason });
        }
      }
    }

    let resolve!: (result: MountFocusResult) => void;
    const promise = new Promise<MountFocusResult>((next) => {
      resolve = next;
    });
    effects.set(id, {
      ...input,
      id,
      controller: new AbortController(),
      status: "pending",
      isCancelRequested: false,
      startedAt: now(),
      resolve,
    });
    startNext();
    return promise;
  };

  const cancel = (id: string, reason?: unknown): boolean => {
    const effect = effects.get(id);
    if (!effect) return false;
    effect.isCancelRequested = true;
    effect.cancelReason = reasonFor(reason);
    effect.controller.abort(effect.cancelReason);
    if (effect.status === "pending") {
      finish(effect, { status: "cancelled", error: effect.cancelReason });
      startNext();
    }
    return true;
  };

  const cancelAll = (reason?: unknown): number => {
    const ids = [...effects.keys()];
    for (const id of ids) cancel(id, reason);
    return ids.length;
  };

  const whenIdle = (): Promise<readonly MountFocusResult[]> => {
    const ids = new Set(effects.keys());
    if (ids.size === 0) return Promise.resolve([...settled.values()]);
    return new Promise((resolve) => {
      idleWaiters.push({ ids, resolve });
      notifyIdle();
    });
  };

  return {
    enqueue,
    add: enqueue,
    cancel,
    cancelAll,
    whenIdle,
    drain: whenIdle,
    results: () => [...settled.values()],
    pending: () => [...effects.values()].filter((effect) => effect.status === "pending").length,
    active: () => running,
  };
}
