import { describe, expect, it, vi } from "vitest";
import { attachOutputStream, type CumulativeChunk } from "./terminalOutputStream";

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function controlledSource() {
  const unlisten = vi.fn();
  const subscription = deferred<() => void>();
  const backlog = deferred<CumulativeChunk>();
  let emit: (chunk: CumulativeChunk) => void = () => undefined;
  const source = {
    subscribe: (onChunk: (chunk: CumulativeChunk) => void) => {
      emit = onChunk;
      return subscription.promise;
    },
    loadBacklog: () => backlog.promise,
  };
  return { source, unlisten, subscription, backlog, emit: (chunk: CumulativeChunk) => emit(chunk) };
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
}

describe("attachOutputStream", () => {
  it("Given chunks that arrive before the backlog, when the backlog loads, then only chunks newer than it follow it", async () => {
    const stream = controlledSource();
    const received: string[] = [];
    attachOutputStream(stream.source, (data) => received.push(data));
    stream.subscription.resolve(stream.unlisten);
    await settle();

    stream.emit({ data: "old", total: 3 });
    stream.emit({ data: "new", total: 6 });
    stream.backlog.resolve({ data: "backlog", total: 3 });
    await settle();
    stream.emit({ data: "live", total: 10 });

    expect(received).toEqual(["backlog", "new", "live"]);
  });

  it("Given the backlog fails, when chunks are pending, then every pending chunk is delivered", async () => {
    const stream = controlledSource();
    const received: string[] = [];
    attachOutputStream(stream.source, (data) => received.push(data));
    stream.subscription.resolve(stream.unlisten);
    await settle();

    stream.emit({ data: "first", total: 5 });
    stream.backlog.reject(new Error("gone"));
    await settle();

    expect(received).toEqual(["first"]);
  });

  it("Given the stream is detached before the subscription resolves, when it resolves, then it unsubscribes and delivers nothing", async () => {
    const stream = controlledSource();
    const received: string[] = [];
    const detach = attachOutputStream(stream.source, (data) => received.push(data));

    detach();
    stream.subscription.resolve(stream.unlisten);
    await settle();
    stream.emit({ data: "late", total: 4 });

    expect(stream.unlisten).toHaveBeenCalledTimes(1);
    expect(received).toEqual([]);
  });
});
