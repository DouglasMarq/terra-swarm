import type { NotificationItem } from "../types";

/** The latest unread agent message per terminal, newest first: one per agent that needs the user. */
export function latestUnreadPerAgent(items: readonly NotificationItem[]): NotificationItem[] {
  const latest = new Map<string, NotificationItem>();
  for (const item of items) {
    if (item.read || item.system) continue;
    const current = latest.get(item.terminalId);
    if (!current || current.ts < item.ts) latest.set(item.terminalId, item);
  }
  return [...latest.values()].sort((a, b) => b.ts - a.ts);
}
