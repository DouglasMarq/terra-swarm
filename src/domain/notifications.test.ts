import { describe, expect, it } from "vitest";
import type { NotificationItem } from "./notification.model";
import { latestUnreadPerAgent, shouldNotify } from "./notifications";

function item(key: number, terminalId: string, fields: Pick<NotificationItem, "ts"> & Partial<NotificationItem>): NotificationItem {
  return { key, terminalId, workspaceId: "ws-1", message: `message ${key}`, read: false, ...fields };
}

describe("latestUnreadPerAgent", () => {
  it("given several unread messages per agent, keeps the latest of each, newest first", () => {
    const latest = latestUnreadPerAgent([item(1, "t-1", { ts: 10 }), item(2, "t-1", { ts: 30 }), item(3, "t-2", { ts: 20 })]);
    expect(latest.map((entry) => entry.key)).toEqual([2, 3]);
  });

  it("given read and system messages, skips them", () => {
    const latest = latestUnreadPerAgent([
      item(1, "t-1", { ts: 10 }),
      item(2, "t-1", { ts: 30, read: true }),
      item(3, "t-2", { ts: 20, system: true }),
    ]);
    expect(latest.map((entry) => entry.key)).toEqual([1]);
  });

  it("given no messages, returns none", () => {
    expect(latestUnreadPerAgent([])).toEqual([]);
  });
});

describe("shouldNotify", () => {
  it("stays quiet while the app is focused", () => {
    expect(shouldNotify(new Map(), "t-1", { now: 0, isAppFocused: true })).toBe(false);
  });

  it("notifies once per agent per cooldown", () => {
    const shown = new Map<string, number>();
    expect(shouldNotify(shown, "t-1", { now: 1_000, isAppFocused: false })).toBe(true);
    expect(shouldNotify(shown, "t-1", { now: 20_000, isAppFocused: false })).toBe(false);
    expect(shouldNotify(shown, "t-2", { now: 20_000, isAppFocused: false })).toBe(true);
    expect(shouldNotify(shown, "t-1", { now: 31_001, isAppFocused: false })).toBe(true);
  });
});
