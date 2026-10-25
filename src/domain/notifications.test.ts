import { describe, expect, it } from "vitest";
import type { NotificationItem } from "./notification.model";
import { latestUnreadPerAgent, shouldNotify } from "./notifications";

function item(key: number, terminalId: string, fields: Pick<NotificationItem, "ts"> & Partial<NotificationItem>): NotificationItem {
  return { key, terminalId, workspaceId: "ws-1", message: `message ${key}`, isRead: false, ...fields };
}

describe("latestUnreadPerAgent", () => {
  it("Given several unread messages per agent, when picking the latest, then the latest of each is kept, newest first", () => {
    const latest = latestUnreadPerAgent([item(1, "t-1", { ts: 10 }), item(2, "t-1", { ts: 30 }), item(3, "t-2", { ts: 20 })]);
    expect(latest.map((entry) => entry.key)).toEqual([2, 3]);
  });

  it("Given read and system messages, when picking the latest, then they are skipped", () => {
    const latest = latestUnreadPerAgent([
      item(1, "t-1", { ts: 10 }),
      item(2, "t-1", { ts: 30, isRead: true }),
      item(3, "t-2", { ts: 20, isSystem: true }),
    ]);
    expect(latest.map((entry) => entry.key)).toEqual([1]);
  });

  it("Given no messages, when picking the latest, then none is returned", () => {
    expect(latestUnreadPerAgent([])).toEqual([]);
  });
});

describe("shouldNotify", () => {
  it("Given the app is focused, when checking whether to notify, then it stays quiet", () => {
    expect(shouldNotify(new Map(), "t-1", { now: 0, isAppFocused: true })).toBe(false);
  });

  it("Given repeated alerts from one agent, when checking whether to notify, then it notifies once per cooldown", () => {
    const shown = new Map<string, number>();
    expect(shouldNotify(shown, "t-1", { now: 1_000, isAppFocused: false })).toBe(true);
    expect(shouldNotify(shown, "t-1", { now: 20_000, isAppFocused: false })).toBe(false);
    expect(shouldNotify(shown, "t-2", { now: 20_000, isAppFocused: false })).toBe(true);
    expect(shouldNotify(shown, "t-1", { now: 31_001, isAppFocused: false })).toBe(true);
  });
});
