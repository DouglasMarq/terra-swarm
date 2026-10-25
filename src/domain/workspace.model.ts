import type { TerminalMeta } from "./terminal.model";

export interface Workspace {
  id: string;
  name: string;
  cwd: string;
  terminals: TerminalMeta[];
  groupId?: string | null;
  activePaneId?: string | null;
  activeContainerId?: string | null;
  layoutMode?: LayoutMode | string | null;
  layout?: WorkspaceLayout | null;
  panes?: PersistedWorkspacePane[];
  containers?: PersistedWorkspaceContainer[];
  isCollapsed?: boolean;
  isArchived?: boolean;
}

export interface WorkspaceGitStatus {
  branch: string | null;
  ahead: number;
  behind: number;
  staged: string[];
  modified: string[];
  untracked: string[];
  conflicted: string[];
}

export type LayoutMode =
  | "auto"
  | "grid"
  | "horizontal"
  | "vertical"
  | "stack"
  | "spotlight";

export interface WorkspaceLayout {
  mode: LayoutMode;
  columns?: number;
  rows?: number;
  itemIds?: string[];
  sizes?: Record<string, number>;
  metadata?: Record<string, unknown>;
}

export interface PersistedWorkspaceContainer {
  id: string;
  projectId: string;
  paneIds: string[];
  lastUsedAt?: number | null;
  size?: number;
  internalLayout?: string;
  isCollapsed?: boolean;
  activePaneId?: string | null;
  isVisible?: boolean;
  isClosed?: boolean;
  isFullscreen?: boolean;
  layout?: WorkspaceLayout | null;
}

export interface PersistedWorkspacePane {
  id: string;
  name?: string;
  cwd?: string;
  containerId?: string | null;
  tabs?: PersistedWorkspaceTab[];
  activeTabId?: string | null;
  kind?: string | null;
  isDisabled?: boolean;
  isCollapsed?: boolean;
  width?: number | null;
  height?: number | null;
  layout?: WorkspaceLayout | null;
}

export interface PersistedWorkspaceTab {
  id: string;
  type?: string;
  name?: string;
  cwd?: string;
  ptyId?: string | null;
  sessionId?: string | null;
  isSuspended?: boolean;
}

export interface Project {
  id: string;
  name: string;
  cwd: string;
  groupId: string | null;
  paneIds: string[];
  containerIds: string[];
  activePaneId: string | null;
  activeContainerId: string | null;
  layout: WorkspaceLayout;
  isCollapsed: boolean;
  isArchived?: boolean;
}

export interface Group {
  id: string;
  name: string;
  projectIds: string[];
  parentGroupId: string | null;
  isCollapsed: boolean;
  isSuspended: boolean;
  layout: WorkspaceLayout;
}

export interface WorkspaceGroup {
  id: string;
  name: string;
  color?: string | null;
  iconUrl?: string | null;
  isCollapsed: boolean;
  projectIds: string[];
  parentGroupId: string | null;
  layoutMode?: string | null;
  isSuspended: boolean;
  isArchived?: boolean;
  createdAt?: number | null;
}

export interface WorkspaceSnapshotTransfer {
  version: 2;
  path: string;
  backupPath: string | null;
  workspaceCount: number;
  groupCount: number;
  terminalCount: number;
  suspendedTerminalCount: number;
}

export interface ActivePaneSelection {
  workspaceId: string;
  paneId: string | null;
}

export interface WorkspacePaneMove {
  workspaceId: string;
  paneId: string;
  toContainerId: string;
  index?: number | null;
}

export interface WorkspaceContainer {
  id: string;
  projectId: string | null;
  paneIds: string[];
  layout: WorkspaceLayout;
  activePaneId?: string | null;
  internalLayout?: string;
  size?: number;
  isVisible: boolean;
  isCollapsed: boolean;
  isClosed: boolean;
  isFullscreen: boolean;
}

export interface WorkspaceContainerPatch {
  isVisible?: boolean;
  isClosed?: boolean;
  isCollapsed?: boolean;
  isFullscreen?: boolean;
  activePaneId?: string | null;
  shouldClearActivePane?: boolean;
  internalLayout?: string;
  size?: number;
  layout?: WorkspaceLayout;
}

export interface Pane {
  id: string;
  projectId: string | null;
  containerId: string | null;
  tabIds: string[];
  activeTabId: string | null;
  layout: WorkspaceLayout;
}

export interface TerminalTab {
  id: string;
  paneId: string | null;
  ptyId: string | null;
  command: string;
  cwd: string;
  width: number | null;
  title: string;
  legacyTerminalId?: string;
  legacyWorkspaceId?: string;
  isOrphaned: boolean;
}

export interface WorkspaceSnapshotV2 {
  version: 2;
  projects: Project[];
  groups: Group[];
  containers: WorkspaceContainer[];
  panes: Pane[];
  tabs: TerminalTab[];
  orphanedTabIds: string[];
  activeProjectId: string | null;
  activeGroupId: string | null;
  activeContainerId: string | null;
  activePaneId: string | null;
  activeTabId: string | null;
  layout: WorkspaceLayout;
}

export type OrchestrationSnapshotV2 = WorkspaceSnapshotV2;
export type DomainSnapshotV2 = WorkspaceSnapshotV2;
export type SnapshotV2 = WorkspaceSnapshotV2;
