import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDebouncedTask } from "./debounce";

describe("createDebouncedTask", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("rearms on bursts and runs once after the quiet window", () => {
    const task = vi.fn();
    const debounced = createDebouncedTask(task, 75);

    debounced.schedule();
    vi.advanceTimersByTime(50);
    debounced.schedule();
    vi.advanceTimersByTime(74);
    expect(task).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(task).toHaveBeenCalledOnce();
  });

  it("cancels pending work during cleanup", () => {
    const task = vi.fn();
    const debounced = createDebouncedTask(task, 75);

    debounced.schedule();
    debounced.cancel();
    vi.runAllTimers();
    expect(task).not.toHaveBeenCalled();
  });
});
