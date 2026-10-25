const WRITE_BUDGET = 32768;
const BYTES_PER_KIB = 1024;
const MAX_BUFFERED_MIB = 8;
const MAX_BUFFERED = MAX_BUFFERED_MIB * BYTES_PER_KIB * BYTES_PER_KIB;
const KEPT_FRACTION_ON_OVERFLOW = 4;
const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;

export interface OutputBufferOptions {
  write: (data: string, done: () => void) => void;
  overflowNotice: () => string;
}

export interface OutputBuffer {
  enqueue: (data: string) => void;
  dispose: () => void;
}

function isHighSurrogate(code: number): boolean {
  return code >= HIGH_SURROGATE_START && code <= HIGH_SURROGATE_END;
}

function chunkEnd(buffer: string): number {
  const end = Math.min(buffer.length, WRITE_BUDGET);
  if (end >= buffer.length) return end;
  return isHighSurrogate(buffer.charCodeAt(end - 1)) ? end + 1 : end;
}

function overflowed(buffer: string, notice: string): string {
  return `${buffer.slice(-Math.floor(MAX_BUFFERED / KEPT_FRACTION_ON_OVERFLOW))}\r\n\x1b[33m${notice}\x1b[0m\r\n`;
}

export function createOutputBuffer(options: OutputBufferOptions): OutputBuffer {
  let buffer = "";
  let isWriting = false;
  let isDisposed = false;

  const drain = (): void => {
    if (isDisposed || isWriting || !buffer) return;
    isWriting = true;
    const end = chunkEnd(buffer);
    const data = buffer.slice(0, end);
    buffer = buffer.slice(end);
    options.write(data, () => {
      isWriting = false;
      drain();
    });
  };

  return {
    enqueue(data) {
      if (isDisposed || !data) return;
      if (buffer.length + data.length > MAX_BUFFERED) buffer = overflowed(buffer, options.overflowNotice());
      buffer += data;
      drain();
    },
    dispose() {
      isDisposed = true;
      buffer = "";
    },
  };
}
