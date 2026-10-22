import { describe, expect, it } from "vitest";
import { shouldNotify } from "./useSystemNotifications";

describe("shouldNotify", () => {
  it("stays quiet while the app is focused", () => {
    expect(shouldNotify(new Map(), "t-1", 0, true)).toBe(false);
  });

  it("notifies once per agent per cooldown", () => {
    const shown = new Map<string, number>();
    expect(shouldNotify(shown, "t-1", 1_000, false)).toBe(true);
    expect(shouldNotify(shown, "t-1", 20_000, false)).toBe(false);
    expect(shouldNotify(shown, "t-2", 20_000, false)).toBe(true);
    expect(shouldNotify(shown, "t-1", 31_001, false)).toBe(true);
  });
});
