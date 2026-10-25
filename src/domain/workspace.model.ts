import type { TerminalMeta } from "./terminal.model";

export interface Workspace {
  id: string;
  name: string;
  cwd: string;
  terminals: TerminalMeta[];
  /** Wave 2 metadata is optional so legacy callers remain source compatible. */
  groupId?: string | null;
  activePaneId?: string | null;
  activeContainerId?: string | null;
  layoutMode?: LayoutMode | string | null;
  layout?: WorkspaceLayout | null;
  /** Backend-owned visual metadata; PTY identities remain in terminals. */
  panes?: PersistedWorkspacePane[];
  containers?: PersistedWorkspaceContainer[];
  collapsed?: boolean;
  archived?: boolean;
}

/** Structured git metadata for one workspace; paths are repository-relative. */
export interface WorkspaceGitStatus {
  branch: string | null;
  ahead: number;
  behind: number;
  staged: string[];
  modified: string[];
  untracked: string[];
  conflicted: string[];
}

/**
 * The legacy workspace API remains intentionally small.  The orchestration
 * model below is an additive contract: callers that still consume
 * `Workspace[]` do not need to know about projects, containers, or tabs.
 */
export type LayoutMode =
  | "auto"
  | "grid"
  | "horizontal"
  | "vertical"
  | "stack"
  | "spotlight";

export interface WorkspaceLayout {
  mode: LayoutMode;
  /** Optional grid hints. They are not required for the legacy migration. */
  columns?: number;
  rows?: number;
  /** Ordered visual children for deterministic rendering. */
  itemIds?: string[];
  /** Relative sizing keyed by child id. */
  sizes?: Record<string, number>;
  /** Extensible visual metadata owned by the surface that renders the layout. */
  metadata?: Record<string, unknown>;
}

/** Wire shape returned by Rust for durable workspace layout metadata. */
export interface PersistedWorkspaceContainer {
  id: string;
  projectId: string;
  paneIds: string[];
  lastUsedAt?: number | null;
  size?: number;
  internalLayout?: string;
  collapsed?: boolean;
  activePaneId?: string | null;
  visible?: boolean;
  closed?: boolean;
  fullscreen?: boolean;
  layout?: WorkspaceLayout | null;
}

/** Wire shape returned by Rust for a pane's durable container/layout link. */
export interface PersistedWorkspacePane {
  id: string;
  name?: string;
  cwd?: string;
  containerId?: string | null;
  tabs?: PersistedWorkspaceTab[];
  activeTabId?: string | null;
  kind?: string | null;
  disabled?: boolean;
  collapsed?: boolean;
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
  suspended?: boolean;
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
  collapsed: boolean;
  archived?: boolean;
}

export interface Group {
  id: string;
  name: string;
  projectIds: string[];
  parentGroupId: string | null;
  collapsed: boolean;
  /** Suspending a group is a domain state; the visual containers stay data. */
  suspended: boolean;
  layout: WorkspaceLayout;
}

/**
 * Shape returned by the Rust group commands. The frontend domain snapshot
 * adds a normalized layout, while this wire shape remains compatible with
 * the persisted workspace store and future optional metadata.
 */
export interface WorkspaceGroup {
  id: string;
  name: string;
  color?: string | null;
  iconUrl?: string | null;
  collapsed: boolean;
  projectIds: string[];
  parentGroupId: string | null;
  layoutMode?: string | null;
  suspended: boolean;
  archived?: boolean;
  createdAt?: number | null;
}

/** Result shared by the versioned local snapshot import/export commands. */
export interface WorkspaceSnapshotTransfer {
  version: 2;
  /** Export destination or import source, depending on the operation. */
  path: string;
  /** Backup of the active store created before an import, when applicable. */
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

/**
 * A container is a visual surface only. Closing/hiding it must not imply
 * killing any PTY referenced by one of its panes.
 */
export interface WorkspaceContainer {
  id: string;
  projectId: string | null;
  paneIds: string[];
  layout: WorkspaceLayout;
  activePaneId?: string | null;
  internalLayout?: string;
  size?: number;
  visible: boolean;
  collapsed: boolean;
  /** Kept as a separate flag for consumers that model close independently. */
  closed: boolean;
  fullscreen: boolean;
}

export interface WorkspaceContainerPatch {
  visible?: boolean;
  closed?: boolean;
  collapsed?: boolean;
  fullscreen?: boolean;
  activePaneId?: string | null;
  clearActivePane?: boolean;
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
  /** Null means that the tab was retained but its pane reference was invalid. */
  paneId: string | null;
  /** PTY identity is separate from visual identity and may be absent for an orphan. */
  ptyId: string | null;
  command: string;
  cwd: string;
  width: number | null;
  title: string;
  /** Original terminal id when a malformed/duplicate legacy entry is retained. */
  legacyTerminalId?: string;
  legacyWorkspaceId?: string;
  orphaned: boolean;
}

export interface WorkspaceSnapshotV2 {
  version: 2;
  projects: Project[];
  groups: Group[];
  containers: WorkspaceContainer[];
  panes: Pane[];
  tabs: TerminalTab[];
  /** IDs are used instead of a duplicate tab collection to avoid two sources of truth. */
  orphanedTabIds: string[];
  activeProjectId: string | null;
  activeGroupId: string | null;
  activeContainerId: string | null;
  activePaneId: string | null;
  activeTabId: string | null;
  layout: WorkspaceLayout;
}

/** Domain aliases make the migration contract discoverable without forcing a rename. */
export type OrchestrationSnapshotV2 = WorkspaceSnapshotV2;
export type DomainSnapshotV2 = WorkspaceSnapshotV2;
export type SnapshotV2 = WorkspaceSnapshotV2;
