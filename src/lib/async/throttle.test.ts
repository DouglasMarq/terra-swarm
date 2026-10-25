import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { throttle } from "./throttle";

describe("throttle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("Given calls inside one interval, when they run, then only the first one reaches the task", () => {
    const task = vi.fn();
    const throttled = throttle(task, 2000);

    throttled("first");
    vi.advanceTimersByTime(1999);
    throttled("second");
    vi.advanceTimersByTime(1);
    throttled("third");

    expect(task.mock.calls).toEqual([["first"], ["third"]]);
  });
});
