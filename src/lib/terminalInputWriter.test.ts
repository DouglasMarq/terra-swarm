import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRetryingWriter } from "./terminalInputWriter";

const BUSY = new Error("busy");

describe("createRetryingWriter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("Given a busy backend, when writing, then it retries until the write succeeds", async () => {
    const write = vi.fn().mockRejectedValueOnce(BUSY).mockRejectedValueOnce(BUSY).mockResolvedValue(undefined);
    const onError = vi.fn();
    const send = createRetryingWriter({ write, shouldStop: () => false, isRetryable: (error) => error === BUSY, onError });

    send("ls");
    await vi.runAllTimersAsync();

    expect(write).toHaveBeenCalledTimes(3);
    expect(onError).not.toHaveBeenCalled();
  });

  it("Given a non-retryable failure, when writing, then it reports the error once without retrying", async () => {
    const failure = new Error("closed");
    const write = vi.fn().mockRejectedValue(failure);
    const onError = vi.fn();
    const send = createRetryingWriter({ write, shouldStop: () => false, isRetryable: (error) => error === BUSY, onError });

    send("ls");
    await vi.runAllTimersAsync();

    expect(write).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("Given several writes, when the first is still retrying, then the next waits for it", async () => {
    const written: string[] = [];
    const write = vi.fn(async (data: string) => {
      written.push(data);
    });
    write.mockRejectedValueOnce(BUSY);
    const send = createRetryingWriter({ write, shouldStop: () => false, isRetryable: (error) => error === BUSY, onError: vi.fn() });

    send("a");
    send("b");
    await vi.runAllTimersAsync();

    expect(written).toEqual(["a", "b"]);
  });

  it("Given the writer is stopped, when writing, then nothing is sent", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const send = createRetryingWriter({ write, shouldStop: () => true, isRetryable: () => true, onError: vi.fn() });

    send("ls");
    await vi.runAllTimersAsync();

    expect(write).not.toHaveBeenCalled();
  });
});
