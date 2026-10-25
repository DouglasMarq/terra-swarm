import type { PaneMenuGroups } from "../workbench/PaneActionsMenu";
import type { CSSProperties, MouseEvent, ReactNode } from "react";
import type { TerminalMeta } from "../../domain/terminal.model";
import type { Pane, Workspace, WorkspaceContainer, WorkspaceGroup, WorkspaceGitStatus, WorkspaceSnapshotV2 } from "../../domain/workspace.model";
import type { WorkspaceFileListing } from "../../domain/workspaceFiles.model";

/** The three visible nesting levels in the Terra navigator. */
export type NavigatorNodeKind = "group" | "project" | "container" | "pane" | "agent";

export type NavigatorStatus = "working" | "idle" | "attention" | "exited" | "suspended";

export type ActivityTab = "projects" | "files" | "git";

export type NavigatorFilesLoader = (
  workspaceId: string,
  relativePath: string,
  limit?: number,
) => Promise<WorkspaceFileListing>;

export type NavigatorGitLoader = (workspaceId: string) => Promise<WorkspaceGitStatus>;

/**
 * Activities are provider-backed surfaces. Projects is the only activity
 * available without an integration, so callers can opt into the others only
 * when they can actually render and persist them.
 */
export type NavigatorActivityCapabilities = Readonly<Partial<Record<ActivityTab, boolean>>>;

/** A branch is intentionally a small adapter type: SCM integrations can add data later. */
export interface NavigatorBranch {
  id: string;
  name?: string;
  workspaceId?: string | null;
  projectId?: string | null;
  terminalId?: string | null;
  agentId?: string | null;
  status?: NavigatorStatus;
}

export interface NavigatorNodeRef {
  id: string;
  kind: NavigatorNodeKind;
}

export interface NavigatorNotificationMap {
  readonly [id: string]: number | readonly unknown[] | undefined;
}

export interface NavigatorStatusMaps {
  groups?: Readonly<Record<string, NavigatorStatus>>;
  projects?: Readonly<Record<string, NavigatorStatus>>;
  agents?: Readonly<Record<string, NavigatorStatus>>;
}

export interface NavigatorNodeActions {
  onOpen?: (node: NavigatorNodeRef) => void;
  onCreate?: (node: NavigatorNodeRef) => void;
  onRename?: (node: NavigatorNodeRef) => void;
  /** Request destructive removal of a persisted project/workspace. */
  onDelete?: (node: NavigatorNodeRef) => void;
  onHide?: (node: NavigatorNodeRef) => void;
  onSuspend?: (node: NavigatorNodeRef) => void;
  onResume?: (node: NavigatorNodeRef) => void;
  onContextMenu?: (event: MouseEvent<HTMLElement>, node: NavigatorNodeRef) => void;
}

export interface NavigatorBaseNode {
  id: string;
  kind: NavigatorNodeKind;
  name: string;
  parentId: string | null;
  depth: number;
  children: NavigatorNode[];
  status: NavigatorStatus;
  count: number;
}

export interface NavigatorGroupNode extends NavigatorBaseNode {
  kind: "group";
  source: WorkspaceGroup;
  projectIds: string[];
  suspended: boolean;
}

export interface NavigatorProjectNode extends NavigatorBaseNode {
  kind: "project";
  source: Workspace;
  workspaceId: string;
  terminalIds: string[];
  visible: boolean;
}

export interface NavigatorContainerNode extends NavigatorBaseNode {
  kind: "container";
  source: WorkspaceContainer;
  workspaceId: string;
  projectId: string;
  containerId: string;
  paneIds: string[];
  visible: boolean;
  collapsed: boolean;
  fullscreen: boolean;
}

export interface NavigatorPaneNode extends NavigatorBaseNode {
  kind: "pane";
  source: Pane;
  workspaceId: string;
  projectId: string;
  containerId: string;
  paneId: string;
  tabIds: string[];
}

export interface NavigatorAgentNode extends NavigatorBaseNode {
  kind: "agent";
  source: TerminalMeta;
  workspaceId: string;
  terminalId: string;
  /** Visual tab identity when the agent came from the v2 snapshot. */
  tabId?: string;
  paneId?: string;
  containerId?: string;
  branchIds: string[];
  contextUsage: number | null;
  notifications: number;
  /** "claude 2" or "Lyra · claude"; shown under the task title. */
  tag?: string;
}

export type NavigatorNode =
  | NavigatorGroupNode
  | NavigatorProjectNode
  | NavigatorContainerNode
  | NavigatorPaneNode
  | NavigatorAgentNode;

export interface NavigatorTree {
  roots: NavigatorNode[];
  byId: Readonly<Record<string, NavigatorNode>>;
  ungrouped: NavigatorProjectNode[];
}

export interface FlatNavigatorNode {
  id: string;
  kind: NavigatorNodeKind;
  name: string;
  parentId: string | null;
  depth: number;
  hasChildren: boolean;
  status: NavigatorStatus;
  count: number;
  node: NavigatorNode;
}

export interface NavigatorPanelProps {
  workspaces: readonly Workspace[];
  /** Optional v2 hierarchy; legacy Workspace[] remains a supported fallback. */
  snapshot?: WorkspaceSnapshotV2 | null;
  groups?: readonly WorkspaceGroup[];
  activeWorkspaceId?: string | null;
  activeContainerId?: string | null;
  activePaneId?: string | null;
  activeTerminalId?: string | null;
  exited?: Readonly<Record<string, number | null>>;
  notifications?: NavigatorNotificationMap;
  contextUsage?: Readonly<Record<string, number>>;
  statuses?: NavigatorStatusMaps;
  branches?: readonly NavigatorBranch[];
  /** Visibility is keyed by project/workspace id. Missing means visible. */
  containerVisibility?: Readonly<Record<string, boolean>>;
  collapsedIds?: readonly string[];
  defaultCollapsedIds?: readonly string[];
  onCollapsedChange?: (ids: string[]) => void;
  onOpenWorkspace?: (workspaceId: string) => void;
  onOpenTerminal?: (workspaceId: string, terminalId: string) => void;
  onFocus?: (id: string) => void;
  onCreateGroup?: () => void;
  onCreateProject?: (groupId: string | null) => void;
  onCreateWorkspace?: (groupId: string | null) => void;
  onCreateAgent?: (workspaceId: string) => void;
  onRenameNode?: (node: NavigatorNodeRef) => void;
  onDeleteWorkspace?: (workspaceId: string) => void;
  onHideContainer?: (workspaceId: string) => void;
  onHideWorkspace?: (workspaceId: string) => void;
  onSuspendGroup?: (groupId: string) => void;
  onResumeGroup?: (groupId: string) => void;
  onContextMenu?: (event: MouseEvent<HTMLElement>, node: NavigatorNodeRef) => void;
  /** Lazy metadata-only directory loader for the Files activity. */
  loadFiles?: NavigatorFilesLoader;
  /** Structured branch/status loader for the Git activity. */
  loadGitStatus?: NavigatorGitLoader;
  activeActivity?: ActivityTab;
  onActivityChange?: (tab: ActivityTab) => void;
  /** Explicit provider capabilities. Projects remains the safe default. */
  capabilities?: NavigatorActivityCapabilities;
  /** Alternate list form for hosts that discover available providers. */
  availableActivities?: readonly ActivityTab[];
  title?: string;
  className?: string;
  style?: CSSProperties;
  emptyState?: ReactNode;
  /** Task title / numbered kind per terminal id, see domain/agentLabels. */
  agentLabels?: Readonly<Record<string, { primary: string; tag: string } | undefined>>;
  /** Skip container and pane levels: group → project → agent. */
  flatten?: boolean;
  /** Replaces the title row (the sidebar puts its surface switch there). */
  headerSlot?: ReactNode;
  /** Actions for an agent row's "…" / right-click menu (same as the pane menu). */
  agentMenu?: (terminalId: string, command: string) => PaneMenuGroups;
}

export interface ProjectTreeProps extends Omit<NavigatorPanelProps, "className" | "style" | "title" | "emptyState" | "activeActivity" | "onActivityChange" | "onCreateGroup" | "agentLabels" | "flatten" | "headerSlot" | "agentMenu"> {
  tree: NavigatorTree;
  expandedIds: ReadonlySet<string>;
  searchQuery?: string;
  onToggle: (id: string) => void;
  onCreateGroup?: () => void;
}

export interface NavigatorRowProps {
  node: NavigatorNode;
  expanded: boolean;
  selected: boolean;
  active: boolean;
  visible: boolean;
  actions: NavigatorNodeActions;
  onToggle?: (id: string) => void;
  onSelect?: (node: NavigatorNode) => void;
  style?: CSSProperties;
}

export function navigatorRef(node: NavigatorNode): NavigatorNodeRef {
  return { id: node.id, kind: node.kind };
}
