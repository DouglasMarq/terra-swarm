import type {
  Pane,
  Project,
  TerminalTab,
  WorkspaceContainer,
  WorkspaceSnapshotV2,
} from "../types";

/** The item with `id`, or null when `id` is empty or not in `items`. */
export function byId<T extends { id: string }>(items: readonly T[], id: string | null | undefined): T | null {
  if (!id) return null;
  return items.find((item) => item.id === id) ?? null;
}

function selectProject(
  snapshot: WorkspaceSnapshotV2,
  projectId: string | null | undefined,
): Project | null {
  return byId(snapshot.projects, projectId);
}

function selectContainer(
  snapshot: WorkspaceSnapshotV2,
  containerId: string | null | undefined,
): WorkspaceContainer | null {
  return byId(snapshot.containers, containerId);
}

function selectPane(
  snapshot: WorkspaceSnapshotV2,
  paneId: string | null | undefined,
): Pane | null {
  return byId(snapshot.panes, paneId);
}

function selectTab(
  snapshot: WorkspaceSnapshotV2,
  tabId: string | null | undefined,
): TerminalTab | null {
  return byId(snapshot.tabs, tabId);
}

function resolvePaneScope(
  snapshot: WorkspaceSnapshotV2,
  scope: string | null | undefined,
): Pane | null {
  if (!scope) return null;
  const direct = selectPane(snapshot, scope);
  if (direct) return direct;
  const container = selectContainer(snapshot, scope);
  if (!container) return null;
  return (
    container.paneIds
      .map((paneId) => selectPane(snapshot, paneId))
      .find((pane): pane is Pane => pane !== null) ?? null
  );
}

/** Returns the active pane for a project, container, or the snapshot itself. */
export function selectActivePane(
  snapshot: WorkspaceSnapshotV2,
  scope?: string | null,
): Pane | null {
  if (scope) {
    const directPane = selectPane(snapshot, scope);
    if (directPane) return directPane;
    const container = selectContainer(snapshot, scope);
    if (container) {
      return (
        container.paneIds
          .map((paneId) => selectPane(snapshot, paneId))
          .find((pane): pane is Pane => pane !== null) ?? null
      );
    }
    const project = selectProject(snapshot, scope);
    if (project) {
      return (
        (project.activePaneId && selectPane(snapshot, project.activePaneId)) ||
        project.paneIds.map((paneId) => selectPane(snapshot, paneId)).find((pane): pane is Pane => pane !== null) ||
        null
      );
    }
    return null;
  }

  const activePane = selectPane(snapshot, snapshot.activePaneId);
  if (activePane) return activePane;
  const activeContainer = selectContainer(snapshot, snapshot.activeContainerId);
  if (activeContainer) {
    return (
      activeContainer.paneIds
        .map((paneId) => selectPane(snapshot, paneId))
        .find((pane): pane is Pane => pane !== null) ?? null
    );
  }
  const activeProject = selectProject(snapshot, snapshot.activeProjectId);
  return activeProject ? selectActivePane(snapshot, activeProject.id) : null;
}

export const getActivePane = selectActivePane;

/** Returns all tabs in a pane in the pane's stable order. */
export function selectPaneTabs(snapshot: WorkspaceSnapshotV2, paneId: string): TerminalTab[] {
  const pane = selectPane(snapshot, paneId);
  if (!pane) return [];
  return pane.tabIds
    .map((tabId) => selectTab(snapshot, tabId))
    .filter((tab): tab is TerminalTab => tab !== null);
}

/** Returns the active tab in a pane, or the first recoverable tab. */
function selectActiveTab(
  snapshot: WorkspaceSnapshotV2,
  paneId?: string | null,
): TerminalTab | null {
  const pane = paneId ? resolvePaneScope(snapshot, paneId) : selectActivePane(snapshot);
  if (!pane) return null;
  return (
    (pane.activeTabId && selectTab(snapshot, pane.activeTabId)) ||
    (snapshot.activeTabId && pane.tabIds.includes(snapshot.activeTabId)
      ? selectTab(snapshot, snapshot.activeTabId)
      : null) ||
    selectPaneTabs(snapshot, pane.id)[0] ||
    null
  );
}

export const getActiveTab = selectActiveTab;

function descendantGroupIds(snapshot: WorkspaceSnapshotV2, groupId: string): Set<string> {
  const result = new Set<string>([groupId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of snapshot.groups) {
      if (group.parentGroupId && result.has(group.parentGroupId) && !result.has(group.id)) {
        result.add(group.id);
        changed = true;
      }
    }
  }
  return result;
}

export function selectGroupProjectIds(snapshot: WorkspaceSnapshotV2, groupId: string): string[] {
  const groupIds = descendantGroupIds(snapshot, groupId);
  const projectIds: string[] = [];
  const seen = new Set<string>();
  for (const group of snapshot.groups) {
    if (!groupIds.has(group.id)) continue;
    for (const projectId of group.projectIds) {
      if (!seen.has(projectId) && selectProject(snapshot, projectId)) {
        seen.add(projectId);
        projectIds.push(projectId);
      }
    }
  }
  return projectIds;
}

export function selectProjectPtyIds(snapshot: WorkspaceSnapshotV2, projectId: string): string[] {
  const project = selectProject(snapshot, projectId);
  if (!project) return [];
  const paneIds = new Set(project.paneIds);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const pane of snapshot.panes) {
    if (pane.projectId !== project.id && !paneIds.has(pane.id)) continue;
    for (const tab of selectPaneTabs(snapshot, pane.id)) {
      if (tab.ptyId && !seen.has(tab.ptyId)) {
        seen.add(tab.ptyId);
        result.push(tab.ptyId);
      }
    }
  }
  return result;
}

/** PTYs are selected from project membership, never from container visibility. */
function selectGroupPtyIds(snapshot: WorkspaceSnapshotV2, groupId: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const projectId of selectGroupProjectIds(snapshot, groupId)) {
    for (const ptyId of selectProjectPtyIds(snapshot, projectId)) {
      if (!seen.has(ptyId)) {
        seen.add(ptyId);
        result.push(ptyId);
      }
    }
  }
  return result;
}

export const getGroupPtyIds = selectGroupPtyIds;
function selectOrphanedTabs(snapshot: WorkspaceSnapshotV2): TerminalTab[] {
  const orphanIds = new Set(snapshot.orphanedTabIds);
  return snapshot.tabs.filter((tab) => tab.orphaned || orphanIds.has(tab.id));
}

export const getOrphanedTabs = selectOrphanedTabs;

export function isContainerVisible(container: WorkspaceContainer | null | undefined): boolean {
  return Boolean(container && !container.closed && container.visible);
}

/** Closing a visual container never requires a PTY termination. */
export function shouldTerminatePtyWhenContainerCloses(): false {
  return false;
}

function getActiveProject(snapshot: WorkspaceSnapshotV2): Project | null {
  return selectProject(snapshot, snapshot.activeProjectId) ?? snapshot.projects[0] ?? null;
}

export function getActiveContainer(snapshot: WorkspaceSnapshotV2): WorkspaceContainer | null {
  const project = getActiveProject(snapshot);
  return (
    selectContainer(snapshot, snapshot.activeContainerId) ||
    (project?.activeContainerId ? selectContainer(snapshot, project.activeContainerId) : null) ||
    (project?.containerIds[0] ? selectContainer(snapshot, project.containerIds[0]) : null)
  );
}

