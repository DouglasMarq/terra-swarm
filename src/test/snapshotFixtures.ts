import type { Group, Pane, Project, TerminalTab, WorkspaceContainer, WorkspaceSnapshotV2 } from "../domain/workspace.model";

const layout = { mode: "grid" as const };

export function projectFixture(id: string, overrides: Partial<Project> = {}): Project {
  return { id, name: id, cwd: `/${id}`, groupId: null, paneIds: [], containerIds: [], activePaneId: null, activeContainerId: null, layout, isCollapsed: false, ...overrides };
}

export function containerFixture(id: string, paneIds: string[], overrides: Partial<WorkspaceContainer> = {}): WorkspaceContainer {
  return { id, projectId: "p1", paneIds, layout, isVisible: true, isCollapsed: false, isClosed: false, isFullscreen: false, ...overrides };
}

export function paneFixture(id: string, tabIds: string[], overrides: Partial<Pane> = {}): Pane {
  return { id, projectId: "p1", containerId: "c1", tabIds, activeTabId: null, layout, ...overrides };
}

export function tabFixture(id: string, ptyId: string | null, overrides: Partial<TerminalTab> = {}): TerminalTab {
  return { id, paneId: null, ptyId, command: "claude", cwd: "/p1", width: null, title: id, isOrphaned: false, ...overrides };
}

export function groupFixture(id: string, projectIds: string[], parentGroupId: string | null = null): Group {
  return { id, name: id, projectIds, parentGroupId, isCollapsed: false, isSuspended: false, layout };
}

export function snapshotFixture(overrides: Partial<WorkspaceSnapshotV2> = {}): WorkspaceSnapshotV2 {
  return {
    version: 2,
    projects: [],
    groups: [],
    containers: [],
    panes: [],
    tabs: [],
    orphanedTabIds: [],
    activeProjectId: null,
    activeGroupId: null,
    activeContainerId: null,
    activePaneId: null,
    activeTabId: null,
    layout,
    ...overrides,
  };
}
