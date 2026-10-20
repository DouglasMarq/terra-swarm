import { describe, expect, it } from "vitest";
import type { NotificationItem } from "../types";
import { latestUnreadPerAgent } from "./notifications";

function item(key: number, terminalId: string, ts: number, extra: Partial<NotificationItem> = {}): NotificationItem {
  return { key, terminalId, workspaceId: "ws-1", message: `message ${key}`, ts, read: false, ...extra };
}

describe("latestUnreadPerAgent", () => {
  it("given several unread messages per agent, keeps the latest of each, newest first", () => {
    const latest = latestUnreadPerAgent([item(1, "t-1", 10), item(2, "t-1", 30), item(3, "t-2", 20)]);
    expect(latest.map((entry) => entry.key)).toEqual([2, 3]);
  });

  it("given read and system messages, skips them", () => {
    const latest = latestUnreadPerAgent([
      item(1, "t-1", 10),
      item(2, "t-1", 30, { read: true }),
      item(3, "t-2", 20, { system: true }),
    ]);
    expect(latest.map((entry) => entry.key)).toEqual([1]);
  });

  it("given no messages, returns none", () => {
    expect(latestUnreadPerAgent([])).toEqual([]);
  });
});
