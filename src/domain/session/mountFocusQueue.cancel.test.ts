import { describe, expect, it } from "vitest";
import { createMountFocusQueue } from "./mountFocusQueue";

function deferred() {
  let resolve: () => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const clock = () => 0;

describe("mount/focus queue cancellation", () => {
  it("Given a blank or duplicate id, when enqueuing, then it is rejected", () => {
    const queue = createMountFocusQueue(clock);
    const gate = deferred();
    void queue.add({ id: " busy ", mount: () => gate.promise });

    expect(() => queue.enqueue({ id: "   " })).toThrow(TypeError);
    expect(() => queue.enqueue({ id: "busy" })).toThrow("mount/focus effect already exists: busy");
    gate.resolve();
  });

  it("Given a pending effect, when cancelled, then it settles as cancelled with the default reason and never runs", async () => {
    const queue = createMountFocusQueue(clock);
    const gate = deferred();
    const events: string[] = [];
    const running = queue.enqueue({ id: "running", mount: () => gate.promise });
    const waiting = queue.enqueue({ id: "waiting", focus: () => events.push("waiting") });

    expect(queue.pending()).toBe(1);
    expect(queue.active()).toBe(1);
    expect(queue.cancel("waiting")).toBe(true);
    expect(queue.cancel("missing")).toBe(false);

    const result = await waiting;
    expect(result.status).toBe("cancelled");
    expect(result.error).toEqual(new Error("mount/focus effect cancelled"));
    gate.resolve();
    expect((await running).status).toBe("completed");
    expect(events).toEqual([]);
  });

  it("Given a running mount, when cancelled before it finishes, then focus is skipped and the abort signal fires", async () => {
    const queue = createMountFocusQueue(clock);
    const gate = deferred();
    const events: string[] = [];
    let signal: AbortSignal | null = null;
    const effect = queue.enqueue({
      id: "mounting",
      mount: (context) => {
        signal = context.signal;
        return gate.promise;
      },
      focus: () => events.push("focus"),
    });

    queue.cancel("mounting", "user closed it");
    gate.resolve();

    expect(await effect).toMatchObject({ status: "cancelled", phase: "mount", error: "user closed it" });
    expect(signal).toMatchObject({ aborted: true });
    expect(events).toEqual([]);
  });

  it("Given a running mount that rejects after being cancelled, when it settles, then it counts as cancelled with the reason", async () => {
    const queue = createMountFocusQueue(clock);
    const gate = deferred();
    const effect = queue.enqueue({ id: "mounting", mount: () => gate.promise });

    queue.cancel("mounting", "closed");
    gate.reject(new Error("aborted"));

    expect(await effect).toMatchObject({ status: "cancelled", phase: "mount", error: "closed" });
  });

  it("Given a running focus, when cancelled before it finishes, then it settles as cancelled in the focus phase", async () => {
    const queue = createMountFocusQueue(clock);
    const gate = deferred();
    const seen = { isCancelled: () => false };
    const effect = queue.enqueue({
      id: "focusing",
      focus: (context) => {
        seen.isCancelled = context.isCancelled;
        return gate.promise;
      },
    });
    await Promise.resolve();

    queue.cancel("focusing", "gone");
    gate.resolve();

    expect(await effect).toMatchObject({ status: "cancelled", phase: "focus", error: "gone" });
    expect(seen.isCancelled()).toBe(true);
  });

  it("Given focus that fails, when cancelled or not, then the failure is reported in the focus phase", async () => {
    const queue = createMountFocusQueue(clock);
    const failing = queue.enqueue({
      id: "failing",
      focus: () => {
        throw new Error("no element");
      },
    });
    expect(await failing).toMatchObject({ status: "failed", phase: "focus", error: new Error("no element") });

    const gate = deferred();
    const cancelled = queue.enqueue({ id: "cancelled", focus: () => gate.promise });
    await Promise.resolve();
    queue.cancel("cancelled", "stop");
    gate.reject(new Error("late"));
    expect(await cancelled).toMatchObject({ status: "cancelled", phase: "focus", error: "stop" });
  });

  it("Given a cancelled effect without a reason that rejects, when it settles, then the rejection is kept as the error", async () => {
    const queue = createMountFocusQueue(clock);
    const gate = deferred();
    const effect = queue.enqueue({ id: "mounting", mount: () => gate.promise });

    queue.cancel("mounting", null);
    gate.reject(new Error("late"));

    expect(await effect).toMatchObject({ status: "cancelled", error: new Error("mount/focus effect cancelled") });
  });

  it("Given several effects, when cancelling all, then each settles and the count is returned", async () => {
    const queue = createMountFocusQueue(clock);
    const gate = deferred();
    const running = queue.enqueue({ id: "one", mount: () => gate.promise });
    const pending = queue.enqueue({ id: "two" });

    expect(queue.cancelAll("reset")).toBe(2);
    gate.resolve();

    expect((await running).status).toBe("cancelled");
    expect((await pending).status).toBe("cancelled");
    expect(queue.results().map((result) => result.id).sort()).toEqual(["one", "two"]);
  });

  it("Given an idle queue, when waiting for idle, then the settled results come back at once", async () => {
    const queue = createMountFocusQueue(clock);
    await queue.enqueue({ id: "done" });

    expect((await queue.whenIdle()).map((result) => result.id)).toEqual(["done"]);
  });

  it("Given effects in flight, when draining, then it resolves with their results once all finish", async () => {
    const queue = createMountFocusQueue(clock);
    const gate = deferred();
    void queue.enqueue({ id: "first", mount: () => gate.promise });
    void queue.enqueue({ id: "second" });

    const drained = queue.drain();
    gate.resolve();

    expect((await drained).map((result) => result.id)).toEqual(["first", "second"]);
    expect(queue.pending()).toBe(0);
    expect(queue.active()).toBe(0);
  });
});
