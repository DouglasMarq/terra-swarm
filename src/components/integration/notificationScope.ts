import type { NotificationItem } from "../../domain/notification.model";
import type { WorkspaceSnapshotV2 } from "../../domain/workspace.model";

export interface NotificationTarget {
  workspaceId?: string | null;
  terminalId?: string | null;
  snapshot?: WorkspaceSnapshotV2 | null;
}

export function filterNotificationItemsForTarget(
  items: readonly NotificationItem[],
  target: NotificationTarget,
): NotificationItem[] {
  const terminalIds = terminalIdsForTarget(target);
  if (terminalIds) {
    return items.filter((item) => terminalIds.has(item.terminalId));
  }

  const workspaceId = target.workspaceId?.trim();
  return workspaceId
    ? items.filter((item) => item.workspaceId === workspaceId)
    : [];
}

function terminalIdsForTarget(target: NotificationTarget): Set<string> | null {
  const directId = target.terminalId?.trim();
  if (directId) return new Set([directId]);

  const snapshot = target.snapshot;
  if (!snapshot) return null;

  const tabById = new Map(snapshot.tabs.map((tab) => [tab.id, tab]));
  const paneById = new Map(snapshot.panes.map((pane) => [pane.id, pane]));
  const containerById = new Map(snapshot.containers.map((container) => [container.id, container]));
  const ptyIds = new Set<string>();

  const addTab = (tabId: string | null | undefined) => {
    if (!tabId) return;
    const ptyId = tabById.get(tabId)?.ptyId;
    if (ptyId) ptyIds.add(ptyId);
  };
  const addPane = (paneId: string | null | undefined) => {
    if (!paneId) return;
    const pane = paneById.get(paneId);
    if (!pane) return;
    pane.tabIds.forEach(addTab);
  };

  addTab(snapshot.activeTabId);
  if (ptyIds.size > 0) return ptyIds;

  addPane(snapshot.activePaneId);
  if (ptyIds.size > 0) return ptyIds;

  const container = snapshot.activeContainerId
    ? containerById.get(snapshot.activeContainerId)
    : undefined;
  container?.paneIds.forEach(addPane);
  return ptyIds.size > 0 ? ptyIds : null;
}
