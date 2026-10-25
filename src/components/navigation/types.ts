import type { PaneMenuGroups } from "../workbench/PaneActionsMenu";
import type { CSSProperties, MouseEvent, ReactNode } from "react";
import type { TerminalMeta } from "../../domain/terminal.model";
import type { Pane, Workspace, WorkspaceContainer, WorkspaceGroup, WorkspaceGitStatus, WorkspaceSnapshotV2 } from "../../domain/workspace.model";
import type { WorkspaceFileListing } from "../../domain/workspaceFiles.model";

export type NavigatorNodeKind = "group" | "project" | "container" | "pane" | "agent";

export type NavigatorStatus = "working" | "idle" | "attention" | "exited" | "suspended";

export type ActivityTab = "projects" | "files" | "git";

export type NavigatorFilesLoader = (
  workspaceId: string,
  relativePath: string,
  limit?: number,
) => Promise<WorkspaceFileListing>;

export type NavigatorGitLoader = (workspaceId: string) => Promise<WorkspaceGitStatus>;

export type NavigatorActivityCapabilities = Readonly<Partial<Record<ActivityTab, boolean>>>;

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
  isSuspended: boolean;
}

export interface NavigatorProjectNode extends NavigatorBaseNode {
  kind: "project";
  source: Workspace;
  workspaceId: string;
  terminalIds: string[];
  isVisible: boolean;
}

export interface NavigatorContainerNode extends NavigatorBaseNode {
  kind: "container";
  source: WorkspaceContainer;
  workspaceId: string;
  projectId: string;
  containerId: string;
  paneIds: string[];
  isVisible: boolean;
  isCollapsed: boolean;
  isFullscreen: boolean;
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
  tabId?: string;
  paneId?: string;
  containerId?: string;
  branchIds: string[];
  contextUsage: number | null;
  notifications: number;
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
  loadFiles?: NavigatorFilesLoader;
  loadGitStatus?: NavigatorGitLoader;
  activeActivity?: ActivityTab;
  onActivityChange?: (tab: ActivityTab) => void;
  capabilities?: NavigatorActivityCapabilities;
  availableActivities?: readonly ActivityTab[];
  title?: string;
  className?: string;
  style?: CSSProperties;
  emptyState?: ReactNode;
  agentLabels?: Readonly<Record<string, { primary: string; tag: string } | undefined>>;
  shouldFlatten?: boolean;
  headerSlot?: ReactNode;
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
  isExpanded: boolean;
  isSelected: boolean;
  isActive: boolean;
  isVisible: boolean;
  actions: NavigatorNodeActions;
  onToggle?: (id: string) => void;
  onSelect?: (node: NavigatorNode) => void;
  style?: CSSProperties;
}

export function navigatorRef(node: NavigatorNode): NavigatorNodeRef {
  return { id: node.id, kind: node.kind };
}
