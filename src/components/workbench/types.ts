import type { Group, LayoutMode, Pane, Project, TerminalTab, Workspace, WorkspaceContainer, WorkspaceLayout, WorkspaceSnapshotV2 } from "../../domain/workspace.model";
import type { ReactNode } from "react";

/** A domain input accepted by the workbench boundary. */
export type WorkbenchSource = WorkspaceSnapshotV2 | readonly Workspace[];

/** `sidebar` is a visual workbench mode, even though legacy persistence did
 * not need to know about it. */
export type WorkbenchLayoutMode = LayoutMode | "sidebar";

export interface WorkbenchTabRenderContext {
  tab: TerminalTab;
  pane: Pane;
  container: WorkspaceContainer;
  project: Project | null;
  group: Group | null;
  isActive: boolean;
  /** Inactive tabs remain mounted; consumers can use this for accessibility. */
  isHidden: boolean;
}

export type WorkbenchTabRenderer = (context: WorkbenchTabRenderContext) => ReactNode;

export interface WorkbenchContainerProjection {
  container: WorkspaceContainer;
  project: Project | null;
  group: Group | null;
  panes: WorkbenchPaneProjection[];
}

export interface WorkbenchPaneProjection {
  pane: Pane;
  tabs: TerminalTab[];
}

export interface WorkbenchProjection {
  source: WorkspaceSnapshotV2;
  containers: WorkbenchContainerProjection[];
}

export interface WorkbenchLocation {
  containerId: string;
  /** Null when creating the first pane in an otherwise empty container. */
  paneId: string | null;
  projectId: string | null;
}

export interface ContainerLayoutChange {
  containerId: string;
  layout: WorkspaceLayout;
}

export interface PaneLayoutProps {
  containerId: string;
  paneId: string;
  mode: WorkbenchLayoutMode;
  paneIds: readonly string[];
  activePaneId: string | null;
  onLayoutChange?: (change: ContainerLayoutChange) => void;
}

export interface WorkbenchActionCallbacks {
  onFocusTab?: (tabId: string, location: WorkbenchLocation) => void;
  onNewTab?: (location: WorkbenchLocation) => void;
  /** The header's "New agent ⌘T": starts the default agent like ⌘T does. */
  onQuickNewTab?: (location: WorkbenchLocation) => void;
  onDetachTab?: (tabId: string, location: WorkbenchLocation) => void;
  /** Explicit destructive action. Hiding/closing a container never calls this. */
  onKillTab?: (tabId: string, location: WorkbenchLocation) => void;
  onCollapseContainer?: (containerId: string, isCollapsed: boolean) => void;
  onFullscreenContainer?: (containerId: string, isFullscreen: boolean) => void;
  /** Hides a visual container while preserving every mounted terminal surface. */
  onHideContainer?: (containerId: string) => void;
  onLayoutChange?: (change: ContainerLayoutChange) => void;
  /** Persists a workspace-level visual preset (Auto, Spotlight, Sidebar, Grid). */
  onWorkspaceLayoutChange?: (projectId: string, layout: WorkspaceLayout) => void;
}

export interface WorkspaceWorkbenchProps extends WorkbenchActionCallbacks {
  source: WorkbenchSource;
  renderTab: WorkbenchTabRenderer;
  className?: string;
  /** Called when the user presses the empty workbench action. */
  onNewContainer?: () => void;
  /** Optional empty state for a source with no containers. */
  emptyState?: ReactNode;
}

export interface ProjectContainerProps extends WorkbenchActionCallbacks {
  projection: WorkbenchContainerProjection;
  renderTab: WorkbenchTabRenderer;
  isVisible?: boolean;
}

export interface PaneFrameProps extends WorkbenchActionCallbacks {
  projection: WorkbenchPaneProjection;
  container: WorkspaceContainer;
  project: Project | null;
  group: Group | null;
  isActive?: boolean;
  renderTab: WorkbenchTabRenderer;
}

export interface SubTabLaneTab {
  tab: TerminalTab;
  isActive: boolean;
  isUnread?: boolean;
  status?: "running" | "idle" | "attention" | "error" | "suspended";
}

export interface SubTabLaneProps {
  tabs: readonly SubTabLaneTab[];
  onFocusTab?: (tabId: string) => void;
  onNewTab?: () => void;
  onDetachTab?: (tabId: string) => void;
  onKillTab?: (tabId: string) => void;
  className?: string;
}

export interface EmptyPaneCellProps {
  paneId?: string;
  projectName?: string | null;
  onNewTab?: () => void;
  label?: string;
  description?: string;
  actionLabel?: string;
  className?: string;
}

export interface ContainerLayoutProps extends WorkbenchActionCallbacks {
  projection: WorkbenchContainerProjection;
  renderTab: WorkbenchTabRenderer;
  /** Explicitly controlled mode wins over the persisted container layout. */
  mode?: WorkbenchLayoutMode;
}
