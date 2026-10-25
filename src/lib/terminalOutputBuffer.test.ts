import { describe, expect, it } from "vitest";
import { createOutputBuffer } from "./terminalOutputBuffer";

const WRITE_BUDGET = 32768;
const MAX_BUFFERED = 8 * 1024 * 1024;

function recordingBuffer() {
  const writes: string[] = [];
  const pending: Array<() => void> = [];
  const buffer = createOutputBuffer({
    write: (data, done) => {
      writes.push(data);
      pending.push(done);
    },
    overflowNotice: () => "dropped",
  });
  const finishNext = (): void => pending.shift()?.();
  return { buffer, writes, finishNext };
}

describe("createOutputBuffer", () => {
  it("Given output larger than one write budget, when it is enqueued, then the next chunk waits for the previous write", () => {
    const { buffer, writes, finishNext } = recordingBuffer();

    buffer.enqueue("a".repeat(WRITE_BUDGET + 10));

    expect(writes.map((data) => data.length)).toEqual([WRITE_BUDGET]);
    finishNext();
    expect(writes.map((data) => data.length)).toEqual([WRITE_BUDGET, 10]);
  });

  it("Given a surrogate pair across the budget boundary, when it is written, then the pair stays in one chunk", () => {
    const { buffer, writes } = recordingBuffer();

    buffer.enqueue(`${"a".repeat(WRITE_BUDGET - 1)}😀b`);

    expect(writes[0]?.length).toBe(WRITE_BUDGET + 1);
    expect(writes[0]?.endsWith("😀")).toBe(true);
  });

  it("Given a full buffer, when more output arrives, then the oldest output is dropped and a notice is added", () => {
    const { buffer, writes, finishNext } = recordingBuffer();
    buffer.enqueue("x");
    buffer.enqueue("y".repeat(MAX_BUFFERED));

    buffer.enqueue("z");
    while (writes.join("").length < MAX_BUFFERED / 4) finishNext();
    for (let flushes = 0; flushes < 2; flushes += 1) finishNext();

    expect(writes.join("")).toBe(`x${"y".repeat(MAX_BUFFERED / 4)}\r\n\x1b[33mdropped\x1b[0m\r\nz`);
  });

  it("Given a disposed buffer, when output arrives, then nothing is written", () => {
    const { buffer, writes } = recordingBuffer();

    buffer.dispose();
    buffer.enqueue("late");

    expect(writes).toEqual([]);
  });
});
