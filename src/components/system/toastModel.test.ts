import { describe, expect, it } from "vitest";

import {
  DEFAULT_TOAST_DURATION_MS,
  getToastDismissDelay,
  getToastRole,
  getToastTone,
  removeToast,
  type ToastItem,
} from "./toastModel";

describe("toast model", () => {
  it("uses the safe default duration only when host auto-dismiss is enabled", () => {
    expect(getToastDismissDelay({}, true)).toBe(DEFAULT_TOAST_DURATION_MS);
    expect(getToastDismissDelay({}, false)).toBeNull();
    expect(getToastDismissDelay({ durationMs: 2_000 }, true)).toBe(2_000);
  });

  it("supports persistent notifications with zero or negative durations", () => {
    expect(getToastDismissDelay({ durationMs: 0 }, true)).toBeNull();
    expect(getToastDismissDelay({ durationMs: -1 }, true)).toBeNull();
  });

  it("derives accessible roles and defaults without mutating the item", () => {
    expect(getToastTone({})).toBe("info");
    expect(getToastRole({ tone: "error" })).toBe("alert");
    expect(getToastRole({ tone: "warning" })).toBe("status");
  });

  it("removes only the requested id", () => {
    const toasts: ToastItem[] = [
      { id: "one", title: "One" },
      { id: "two", title: "Two" },
    ];
    expect(removeToast(toasts, "one")).toEqual([{ id: "two", title: "Two" }]);
    expect(toasts).toHaveLength(2);
  });
});
