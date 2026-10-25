import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDebouncedTask } from "./debounce";

describe("createDebouncedTask", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("Given a burst of calls, when the quiet window passes, then the task runs once after rearming on each call", () => {
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

  it("Given pending work, when cleaning up, then it is cancelled", () => {
    const task = vi.fn();
    const debounced = createDebouncedTask(task, 75);

    debounced.schedule();
    debounced.cancel();
    vi.runAllTimers();
    expect(task).not.toHaveBeenCalled();
  });
});
