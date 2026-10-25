import type { NotificationItem } from "./notification.model";

const PER_AGENT_COOLDOWN_MS = 30_000;

export interface NotifyMoment {
  now: number;
  isAppFocused: boolean;
}

export function shouldNotify(lastShown: Map<string, number>, terminalId: string, moment: NotifyMoment): boolean {
  if (moment.isAppFocused) return false;
  const { now } = moment;
  const last = lastShown.get(terminalId);
  if (last !== undefined && now - last < PER_AGENT_COOLDOWN_MS) return false;
  lastShown.set(terminalId, now);
  return true;
}

export function latestUnreadPerAgent(items: readonly NotificationItem[]): NotificationItem[] {
  const latest = new Map<string, NotificationItem>();
  for (const item of items) {
    if (item.isRead || item.isSystem) continue;
    const current = latest.get(item.terminalId);
    if (!current || current.ts < item.ts) latest.set(item.terminalId, item);
  }
  return [...latest.values()].sort((left, right) => right.ts - left.ts);
}
