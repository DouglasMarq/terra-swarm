import { describe, expect, it, vi } from "vitest";
import {
  createFitScheduler,
  createTerminalResizeQueue,
  type TerminalDimensions,
} from "./terminalFitScheduler";

describe("terminal fit scheduler", () => {
  it("coalesces geometry signals into one animation frame", () => {
    const frames: Array<() => void> = [];
    const fit = vi.fn();
    const scheduler = createFitScheduler(fit, {
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: vi.fn(),
    });

    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();
    expect(frames).toHaveLength(1);
    expect(fit).not.toHaveBeenCalled();

    frames.shift()?.();
    expect(fit).toHaveBeenCalledTimes(1);
    scheduler.dispose();
    scheduler.schedule();
    expect(frames).toHaveLength(0);
  });

  it("serializes resize IPC and keeps only the latest pending dimensions", async () => {
    const sent: TerminalDimensions[] = [];
    const resolvers: Array<() => void> = [];
    const send = vi.fn((dimensions: TerminalDimensions) => {
      sent.push(dimensions);
      return new Promise<void>((resolve) => resolvers.push(resolve));
    });
    const queue = createTerminalResizeQueue(send);

    queue.request({ cols: 100, rows: 20 });
    queue.request({ cols: 120, rows: 24 });
    queue.request({ cols: 140, rows: 28 });
    expect(sent).toEqual([{ cols: 100, rows: 20 }]);

    resolvers.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toEqual([
      { cols: 100, rows: 20 },
      { cols: 140, rows: 28 },
    ]);

    resolvers.shift()?.();
    await Promise.resolve();
    queue.request({ cols: 140, rows: 28 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("invalidates an old geometry after a PTY lifecycle restart", async () => {
    const resolvers: Array<() => void> = [];
    const send = vi.fn((dimensions: TerminalDimensions) => new Promise<void>((resolve) => {
      void dimensions;
      resolvers.push(resolve);
    }));
    const queue = createTerminalResizeQueue(send);

    queue.request({ cols: 100, rows: 24 });
    queue.reset();
    queue.request({ cols: 100, rows: 24 });
    expect(send).toHaveBeenCalledTimes(1);

    resolvers.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
