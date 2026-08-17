import type { NotificationItem, WorkspaceSnapshotV2 } from "../../types";

export interface NotificationTarget {
  /** Project/workspace currently selected in the shell. */
  workspaceId?: string | null;
  /** Runtime PTY currently focused by the user. */
  terminalId?: string | null;
  /** Visual target state, when the shell has a normalized workspace snapshot. */
  snapshot?: WorkspaceSnapshotV2 | null;
}

/**
 * Scope notification history to the most precise target the shell knows.
 *
 * NotificationItem intentionally carries terminal/workspace identity rather
 * than duplicating visual container/pane/tab ids. The snapshot lets us project
 * an active tab, pane, or container back to the PTYs they contain, while the
 * direct terminal id always wins when a runtime focus exists.
 */
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

  // Prefer the deepest active visual target: tab → pane → container.
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
