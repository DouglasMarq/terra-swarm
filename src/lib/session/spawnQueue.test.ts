import { describe, expect, it, vi } from "vitest";
import { createSpawnQueue } from "./spawnQueue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const clock = () => 0;

describe("spawn queue", () => {
  it("respects concurrency and reports one result per item", async () => {
    const gate = deferred<void>();
    let active = 0;
    let maximum = 0;
    const queue = createSpawnQueue<number, number>({
      concurrency: 2,
      now: clock,
      run: async (input) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await gate.promise;
        active -= 1;
        return input * 2;
      },
    });

    const first = queue.enqueue("one", 1);
    const second = queue.enqueue("two", 2);
    const third = queue.enqueue("three", 3);
    expect(queue.active()).toBe(2);
    expect(queue.pending()).toBe(1);

    gate.resolve();
    const results = await Promise.all([first, second, third]);
    expect(maximum).toBe(2);
    expect(results.map((result) => result.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(results.map((result) => result.value)).toEqual([2, 4, 6]);
  });

  it("cancels pending items immediately and aborts running items", async () => {
    const gate = deferred<void>();
    let signal!: AbortSignal;
    const queue = createSpawnQueue<string, string>({
      now: clock,
      run: async (input, context) => {
        signal = context.signal;
        await gate.promise;
        return input;
      },
    });

    const running = queue.enqueue("running", "a");
    const pending = queue.enqueue("pending", "b");
    expect(queue.cancel("pending")).toBe(true);
    expect((await pending).status).toBe("cancelled");
    expect(queue.cancel("running", "stop now")).toBe(true);
    expect(signal.aborted).toBe(true);
    gate.resolve();
    const result = await running;
    expect(result.status).toBe("cancelled");
    expect(result.error).toBe("stop now");
    expect(queue.cancel("missing")).toBe(false);
  });

  it("continues after a runner failure and exposes idle results", async () => {
    const onResult = vi.fn();
    const queue = createSpawnQueue<string, string>({
      now: clock,
      run: (input) => {
        if (input === "bad") throw new Error("broken");
        return input.toUpperCase();
      },
      onResult,
    });
    queue.enqueue("bad", "bad");
    queue.enqueue("good", "good");
    const results = await queue.drain();
    expect(results.map((result) => result.status)).toEqual(["failed", "succeeded"]);
    expect(onResult).toHaveBeenCalledTimes(2);
  });

  it("given a clock, stamps start and finish times from it", async () => {
    let time = 100;
    const queue = createSpawnQueue<string, string>({ now: () => time++, run: (input) => input });
    expect(await queue.enqueue("one", "a")).toMatchObject({ status: "succeeded", startedAt: 100, finishedAt: 101 });
  });
});

