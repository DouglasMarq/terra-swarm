import { describe, expect, it, vi } from "vitest";
import {
  createFitScheduler,
  createTerminalResizeQueue,
  isUsableDimensions,
  type TerminalDimensions,
} from "./terminalFitScheduler";

describe("isUsableDimensions", () => {
  it("Given finite dimensions of at least one cell, when checked, then they are usable", () => {
    expect(isUsableDimensions({ cols: 80, rows: 24 })).toBe(true);
  });

  it("Given missing, zero or non-finite dimensions, when checked, then they are not usable", () => {
    expect(isUsableDimensions(undefined)).toBe(false);
    expect(isUsableDimensions({ cols: 0, rows: 24 })).toBe(false);
    expect(isUsableDimensions({ cols: 80, rows: Number.NaN })).toBe(false);
    expect(isUsableDimensions({ cols: Number.POSITIVE_INFINITY, rows: 24 })).toBe(false);
  });
});

describe("terminal fit scheduler", () => {
  it("Given several geometry signals, when they arrive in one frame, then they are coalesced into one animation frame", () => {
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

  it("Given resizes while an IPC call is pending, when it completes, then resizes are serialized and only the latest pending dimensions are kept", async () => {
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

  it("Given a PTY lifecycle restart, when the geometry is requested again, then the old geometry is invalidated", async () => {
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
