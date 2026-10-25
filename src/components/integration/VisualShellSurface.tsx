import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { ApplicationShell } from "../shell/ApplicationShell";
import { CollapsedSidebar, Sidebar, SurfaceSwitch } from "../shell/Sidebar";
import { NotificationCenter } from "../notifications/NotificationCenter";
import { useT } from "../../i18n";
import { AgentInspector } from "../inspector/AgentInspector";
import { TasksPanel } from "../tasks/TasksPanel";
import { TaskBoard } from "../tasks/TaskBoard";
import { nudgeAgent, sendPromptToTerminal } from "../../app/sendPromptToTerminal";
import { startMcpEventBridge } from "../../stores/mcpStore";
import { useReviewStore } from "../../stores/reviewStore";
import { startPreviewBridge } from "../../stores/previewStore";
import { PreviewPanel } from "../preview/PreviewPanel";
import { isTerminalRunning } from "../../domain/agentStatus";
import { NavigatorPanel } from "../navigation/NavigatorPanel";
import type { ActivityTab, NavigatorFilesLoader, NavigatorGitLoader, NavigatorNodeRef } from "../navigation/types";
import type { WorkbenchLocation, WorkbenchTabRenderContext } from "../workbench/types";
import type { CommandConfirmRequest } from "../overlays/CommandPalette";
import type { VoiceCapsuleState } from "../voice";
import type { NotificationItem } from "../../domain/notification.model";
import type { VoiceStatus } from "../../domain/voice.model";
import type { Group, Workspace, WorkspaceGroup, WorkspaceSnapshotV2 } from "../../domain/workspace.model";
import { useShellStore, type ShellSurface } from "../../stores/shellStore";
import { useOrchestrationStore } from "../../stores/orchestrationStore";
import { DEFAULT_HOTKEYS, formatHotkey, usePreferencesStore } from "../../stores/preferencesStore";
import {
  inspectorActionRequiresConfirmation,
  type InspectorActionKind,
  type InspectorTarget,
} from "../inspector/inspectorModel";
import {
  containerVisibilityByWorkspace,
  lastActivityByAgent,
  latestMessageByAgent,
  nearlyFullContexts,
  roleLabelsByTerminal,
  shellSurfaceTitle,
  shellVoiceLabel,
  shellVoiceState,
  workbenchSnapshot,
  worktreeBranchesByTerminal,
} from "./visualShellModel";
import { CommandPalette } from "./lazySurfaces";
import { ShellConfirmDialogs, type PendingInspectorAction } from "./ShellConfirmDialogs";
import { shellShortcutLabels, useShellShortcuts } from "./shellShortcuts";
import { useFullscreenExit } from "./useFullscreenExit";
import { buildPaneMenu, type FocusedAgentActionHandler, type PaneMenuActions } from "./paneMenu";
import { ShellVoiceOverlay, type ShellVoiceProps } from "./ShellVoiceOverlay";
import { ShellTerminalTab, type ShellTerminalTabActions, type ShellTerminalTabView } from "./ShellTerminalTab";
import { ShellFleetContent } from "./ShellFleetContent";
import { ShellWorkbenchContent } from "./ShellWorkbenchContent";
import { useShellAgentOverview } from "./useShellAgentOverview";
import { useShellInspector } from "./useShellInspector";
import { useNotificationMute } from "./useNotificationMute";
import { shellPaletteCallbacks } from "./shellPaletteCallbacks";
import "./visual-shell.css";

export interface VisualShellSurfaceProps extends ShellVoiceProps {
  workspaces: readonly Workspace[];
  groups: readonly Group[];
  agents: VisualAgent[];
  snapshot: WorkspaceSnapshotV2 | null;
  activeId: string | null;
  focusedId: string | null;
  expandedId: string | null;
  exited: Readonly<Record<string, number | null>>;
  notifications: Readonly<Record<string, number>>;
  contextUsage: Readonly<Record<string, number>>;
  titles: Readonly<Record<string, string>>;
  branches: Readonly<Record<string, string>>;
  notificationItems: readonly NotificationItem[];
  resumeCount?: number;
  /** Runtime version resolved once by App from Tauri's app metadata. */
  appVersion?: string;
  onOpenResume?: () => void;
  detachedTerminalIds: readonly string[];
  fontSize: number;
  voiceStatus: VoiceStatus;
  voiceState?: VoiceCapsuleState;
  /** Settings rendered as a page when the shell surface is "settings". */
  settingsPage?: ReactNode;
  onRenameAgent?: (terminalId: string) => void;
  onFocus: (id: string) => void;
  onSelectWorkspace: (id: string, focusedTerminalId?: string) => void;
  onNewWorkspace: () => void;
  onNewAgent: (workspaceId: string, paneId?: string | null, agentId?: string) => void;
  /** Starts the default agent (⌘T); opens the picker when there is none. */
  onQuickNewAgent?: (workspaceId: string) => void;
  onClearNotifications: (id: string) => void;
  onMarkAllRead: () => void;
  onClearAll: () => void;
  onJumpToNotification: (item: NotificationItem) => void;
  onRestart: (id: string, command: string) => void;
  onKill: (id: string) => void;
  onDetach: (id: string) => void;
  onReattach: (id: string) => void;
  onToggleExpand: (id: string | null) => void;
  onHideWorkspace: (id: string) => void;
  onDeleteWorkspace?: (id: string) => void;
  onHideContainer?: (containerId: string) => void;
  loadFiles?: NavigatorFilesLoader;
  loadGitStatus?: NavigatorGitLoader;
  onCreateGroup: () => void;
  onCreateProject: (groupId: string | null) => void;
  onRenameNode: (node: NavigatorNodeRef) => void;
  onSuspendGroup: (groupId: string) => void;
  onResumeGroup: (groupId: string) => void;
  onBatchStop: (ids: string[]) => void;
  onBatchResume: (ids: string[]) => void;
  onOpenSettings: () => void;
  onOpenVoiceSettings?: () => void;
  onExportWorkspace?: () => void;
  onImportWorkspace?: () => void;
  onFocusedAgentAction?: FocusedAgentActionHandler;
}

interface VisualAgent {
  id: string;
  label: string;
  available: boolean;
}

function toWireGroup(group: Group): WorkspaceGroup {
  return {
    id: group.id,
    name: group.name,
    collapsed: group.collapsed,
    projectIds: group.projectIds,
    parentGroupId: group.parentGroupId,
    suspended: group.suspended,
    layoutMode: group.layout.mode,
  };
}

export function VisualShellSurface(props: VisualShellSurfaceProps) {
  const t = useT();
  const shortcutLabels = shellShortcutLabels();
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const notificationMute = useNotificationMute();
  const [navigatorActivity, setNavigatorActivity] = useState<ActivityTab>("projects");
  const [pendingCommandConfirmation, setPendingCommandConfirmation] = useState<CommandConfirmRequest | null>(null);
  const hotkeys = usePreferencesStore((state) => state.hotkeys);
  const [pendingInspectorAction, setPendingInspectorAction] = useState<PendingInspectorAction | null>(null);
  const orchestration = useOrchestrationStore(useShallow((state) => ({
    setContainerFullscreen: state.setContainerFullscreen,
    setContainerActivePane: state.setContainerActivePane,
    setActivePane: state.setActivePane,
  })));
  const shell = useShellStore(useShallow((state) => ({
    activeSurface: state.activeSurface,
    activeWorkspaceId: state.activeWorkspaceId,
    dock: state.dock,
    panelLayout: state.panelLayout,
    navigatorCollapsedIds: state.navigatorCollapsedIds,
    sidebarCollapsed: state.sidebarCollapsed,
    setSidebarCollapsed: state.setSidebarCollapsed,
    toggleSidebar: state.toggleSidebar,
    workspaceTabs: state.workspaceTabs,
    recentlyClosedTabs: state.recentlyClosedTabs,
    historyIndex: state.historyIndex,
    historyLength: state.history.length,
    navigate: state.navigate,
    goBack: state.goBack,
    goForward: state.goForward,
    setDockOpen: state.setDockOpen,
    setPanelLayout: state.setPanelLayout,
    setNavigatorCollapsedIds: state.setNavigatorCollapsedIds,
    setDockTab: state.setDockTab,
    openWorkspaceTab: state.openWorkspaceTab,
    closeWorkspaceTab: state.closeWorkspaceTab,
    reopenWorkspaceTab: state.reopenWorkspaceTab,
    selectWorkspaceTab: state.selectWorkspaceTab,
    reorderWorkspaceTabs: state.reorderWorkspaceTabs,
  })));

  const inspectorActive = shell.dock.open && shell.dock.activeTab === "inspector";
  useEffect(() => startMcpEventBridge(nudgeAgent), []);
  useEffect(() => startPreviewBridge(), []);

  useShellShortcuts({
    toggleSidebar: shell.toggleSidebar,
    dockOpen: shell.dock.open,
    setDockOpen: shell.setDockOpen,
    setCommandPaletteOpen,
  });

  const wireGroups = useMemo(() => props.groups.map(toWireGroup), [props.groups]);
  const containerVisibility = useMemo(
    () => containerVisibilityByWorkspace(props.snapshot, props.workspaces, props.focusedId),
    [props.focusedId, props.snapshot, props.workspaces],
  );
  const source = useMemo(
    () => workbenchSnapshot(props.snapshot, { detachedTerminalIds: props.detachedTerminalIds, focusedId: props.focusedId, activeProjectId: props.activeId }),
    [props.activeId, props.detachedTerminalIds, props.focusedId, props.snapshot],
  );

  useEffect(() => {
    if (props.workspaces.length === 0 || (!props.loadFiles && !props.loadGitStatus)) {
      setNavigatorActivity("projects");
    }
  }, [props.loadFiles, props.loadGitStatus, props.workspaces.length]);

  const navigatorActivityProps = {
    activeActivity: navigatorActivity,
    availableActivities: ["projects", "files", "git"] as const,
    loadFiles: props.loadFiles,
    loadGitStatus: props.loadGitStatus,
    onActivityChange: setNavigatorActivity,
  };

  const { activeSurface, activeWorkspaceId, navigate: navigateShell } = shell;
  useEffect(() => {
    if (activeSurface === "workbench" && !activeWorkspaceId && props.activeId) {
      navigateShell("workbench", props.activeId);
    }
  }, [props.activeId, activeSurface, activeWorkspaceId, navigateShell]);

  const navigate = (
    surface: ShellSurface,
    workspaceId: string | null = null,
    focusedTerminalId?: string,
  ) => {
    shell.navigate(surface, workspaceId);
    if (workspaceId) {
      props.onSelectWorkspace(workspaceId, focusedTerminalId);
      shell.openWorkspaceTab({ id: workspaceId, workspaceId, label: props.workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? workspaceId });
    }
  };

  const focusTerminal = (id: string) => {
    const match = props.workspaces.find((workspace) => workspace.terminals.some((terminal) => terminal.id === id));
    if (!match) return;
    props.onReattach(id);
    props.onSelectWorkspace(match.id, id);
    props.onFocus(id);
    navigate("workbench", match.id, id);
  };

  const handleInspectorAction = (action: InspectorActionKind, target: InspectorTarget) => {
    if (action === "focus") {
      focusTerminal(target.terminalId);
      return;
    }
    if (action === "detach") {
      props.onDetach(target.terminalId);
      return;
    }
    if (action === "reattach") {
      props.onReattach(target.terminalId);
      return;
    }
    // Restarting and terminating a PTY are lifecycle mutations. Keep their
    // callbacks behind the same explicit confirmation affordance used by the
    // command palette and Fleet.
    if (inspectorActionRequiresConfirmation(action)) {
      setPendingInspectorAction({ action, target });
    }
  };

  const visualVoiceState = shellVoiceState(props.voiceState, props.voiceStatus);
  const voiceActive = visualVoiceState === "listening" || visualVoiceState === "transcribing";
  const voiceRecording = visualVoiceState === "listening";
  const voiceLabel = shellVoiceLabel(visualVoiceState, t);
  const voiceShortcut = formatHotkey(hotkeys.toggleVoice ?? DEFAULT_HOTKEYS.toggleVoice);

  const { agentLabels, agentStatus, reported, attentionCount, activeCount, railProjects } = useShellAgentOverview(props);
  const exitedIds = useMemo(() => Object.keys(props.exited), [props.exited]);
  const workspaceNames = useMemo(() => Object.fromEntries(props.workspaces.map((workspace) => [workspace.id, workspace.name])), [props.workspaces]);
  const inspectorProps = useShellInspector(props, { agentLabels, agentStatus }, { isActive: inspectorActive, onAction: handleInspectorAction });
  const contextAlerts = nearlyFullContexts(props.workspaces, props.exited, props.contextUsage);
  const activeWorkspace = props.workspaces.find((workspace) => workspace.id === props.activeId) ?? null;
  const activeAgents = (activeWorkspace?.terminals ?? []).map((terminal) => ({
    id: terminal.id,
    label: agentLabels[terminal.id]?.primary ?? terminal.command,
    running: isTerminalRunning(terminal, props.exited),
  }));
  const tasksPanel = (
    <TasksPanel
      workspaceId={activeWorkspace?.id ?? null}
      workspaceName={activeWorkspace?.name ?? null}
      agents={activeAgents}
    />
  );
  const taskBoard = (
    <TaskBoard
      workspaceId={activeWorkspace?.id ?? null}
      workspaceName={activeWorkspace?.name ?? null}
      agents={activeAgents}
      onSendPrompt={(terminalId, prompt) => sendPromptToTerminal(terminalId, prompt)}
    />
  );
  const dockTabs = [
    { id: "inspector", label: t("shell.dock.inspector") },
    { id: "tasks", label: t("shell.dock.tasks") },
    { id: "preview", label: t("shell.dock.preview") },
  ] as const;
  const focusedLabel = props.focusedId ? agentLabels[props.focusedId] ?? null : null;
  useFullscreenExit({
    snapshot: props.snapshot,
    dockOpen: shell.dock.open,
    setContainerFullscreen: orchestration.setContainerFullscreen,
  });

  const focusWorkbenchTab = (id: string, location?: WorkbenchLocation) => {
    if (location) {
      orchestration.setContainerActivePane(location.containerId, location.paneId);
      orchestration.setActivePane?.(location.paneId);
    }
    focusTerminal(id);
  };

  const attentionMessages = useMemo(() => latestMessageByAgent(props.notificationItems), [props.notificationItems]);

  const lastActivity = useMemo(() => lastActivityByAgent(props.notificationItems), [props.notificationItems]);

  const workspaceIdFor = (terminalId: string) => props.workspaces.find((workspace) => workspace.terminals.some((terminal) => terminal.id === terminalId))?.id ?? null;

  const worktreeBranches = worktreeBranchesByTerminal(props.workspaces);
  const roleLabels = roleLabelsByTerminal(props.workspaces, t);
  const openReview = (terminalId: string) => {
    const workspaceId = workspaceIdFor(terminalId);
    if (!workspaceId) return;
    useReviewStore.getState().open({ workspaceId, terminalId, label: agentLabels[terminalId]?.primary ?? terminalId });
  };
  const paneMenuActions: PaneMenuActions = {
    onFocusedAgentAction: props.onFocusedAgentAction,
    onRestart: props.onRestart,
    onReattach: props.onReattach,
    onDetach: props.onDetach,
    onOpenInspector: (ptyId) => { props.onFocus(ptyId); shell.setDockOpen(true); },
    onOpenReview: openReview,
    onRenameAgent: props.onRenameAgent,
    onRequestConfirm: setPendingCommandConfirmation,
  };
  const buildMenu = (ptyId: string, command: string) => buildPaneMenu(
    {
      ptyId,
      command,
      workspaceId: workspaceIdFor(ptyId),
      label: agentLabels[ptyId]?.primary ?? command,
      isDetached: props.detachedTerminalIds.includes(ptyId),
      hasWorktree: Boolean(worktreeBranches[ptyId]),
    },
    paneMenuActions,
    { t, shortcuts: shortcutLabels },
  );

  const terminalTabView: ShellTerminalTabView = {
    fontSize: props.fontSize,
    focusedId: props.focusedId,
    expandedId: props.expandedId,
    exited: props.exited,
    notifications: props.notifications,
    contextUsage: props.contextUsage,
    titles: props.titles,
    branches: props.branches,
    worktreeBranches,
    roleLabels,
    detachedIds: new Set(props.detachedTerminalIds),
    labels: agentLabels,
    attentionMessages,
  };
  const terminalTabActions: ShellTerminalTabActions = {
    buildMenu,
    onClearNotifications: props.onClearNotifications,
    onFocusTab: focusWorkbenchTab,
    onToggleExpand: props.onToggleExpand,
    onRestart: props.onRestart,
    onDetach: props.onDetach,
    onKill: props.onKill,
    onOpenReview: openReview,
  };
  const renderTab = (context: WorkbenchTabRenderContext) => (
    <ShellTerminalTab context={context} view={terminalTabView} actions={terminalTabActions} />
  );

  const surface = shell.activeSurface;
  const branchList = Object.entries(props.branches).map(([workspaceId, name]) => ({ id: `${workspaceId}:${name}`, name, workspaceId }));
  const navigator = (
    <NavigatorPanel
      {...navigatorActivityProps}
      flatten
      agentLabels={agentLabels}
      agentMenu={buildMenu}
      headerSlot={<SurfaceSwitch surface={surface} attentionCount={attentionCount} onNavigate={(next) => navigate(next)} />}
      workspaces={props.workspaces}
      snapshot={props.snapshot}
      groups={wireGroups}
      activeWorkspaceId={props.activeId}
      activeContainerId={props.snapshot?.activeContainerId ?? null}
      activePaneId={props.snapshot?.activePaneId ?? null}
      activeTerminalId={props.focusedId}
      collapsedIds={shell.navigatorCollapsedIds}
      onCollapsedChange={shell.setNavigatorCollapsedIds}
      exited={props.exited}
      notifications={props.notifications}
      contextUsage={props.contextUsage}
      branches={branchList}
      containerVisibility={containerVisibility}
      onOpenWorkspace={(id) => navigate("workbench", id)}
      onOpenTerminal={(workspaceId, terminalId) => { props.onSelectWorkspace(workspaceId); focusTerminal(terminalId); }}
      onFocus={focusTerminal}
      onCreateGroup={props.onCreateGroup}
      onCreateProject={props.onCreateProject}
      onCreateAgent={(workspaceId) => props.onNewAgent(workspaceId)}
      onRenameNode={props.onRenameNode}
      onDeleteWorkspace={props.onDeleteWorkspace}
      onHideWorkspace={props.onHideWorkspace}
      onHideContainer={props.onHideContainer ?? props.onHideWorkspace}
      onSuspendGroup={props.onSuspendGroup}
      onResumeGroup={props.onResumeGroup}
    />
  );
  const sidebar = <Sidebar surface={surface} attentionCount={attentionCount} onNavigate={(next) => navigate(next)} activeAgents={activeCount} version={props.appVersion?.trim() || undefined} onOpenSettings={props.onOpenSettings}>{navigator}</Sidebar>;
  const collapsedSidebar = <CollapsedSidebar surface={surface} attentionCount={attentionCount} projects={railProjects} activeWorkspaceId={props.activeId} focusedAgentId={props.focusedId} onNavigate={(next) => navigate(next)} onOpenWorkspace={(id) => navigate("workbench", id)} onFocusAgent={(_workspaceId, terminalId) => focusTerminal(terminalId)} onOpenSettings={props.onOpenSettings} onExpand={() => shell.setSidebarCollapsed(false)} expandShortcut={shortcutLabels.sidebar} />;

  const fleetContent = (
    <ShellFleetContent
      view={{ workspaces: props.workspaces, groups: wireGroups, reported, exited: props.exited, notifications: props.notifications, contextUsage: props.contextUsage, titles: props.titles, branches: props.branches, lastActivity, labels: agentLabels, attentionMessages }}
      actions={{ onFocusTerminal: focusTerminal, onMarkRead: props.onClearNotifications, onBatchStop: props.onBatchStop, onBatchResume: props.onBatchResume, onToggleVoice: props.onToggleVoice }}
    />
  );
  const workbenchContent = (
    <ShellWorkbenchContent
      source={source}
      snapshot={props.snapshot}
      activeId={props.activeId}
      renderTab={renderTab}
      actions={{ onFocusTerminalTab: focusWorkbenchTab, onFocus: props.onFocus, onNewWorkspace: props.onNewWorkspace, onNewAgent: props.onNewAgent, onQuickNewAgent: props.onQuickNewAgent, onDetach: props.onDetach, onKill: props.onKill, onHideWorkspace: props.onHideWorkspace, onHideContainer: props.onHideContainer }}
    />
  );
  const content = surface === "settings" && props.settingsPage ? props.settingsPage : surface === "board" ? taskBoard : surface === "fleet" ? fleetContent : workbenchContent;
  const notificationsPanel = (
    <NotificationCenter
      items={props.notificationItems}
      contextAlerts={contextAlerts}
      onFocusAgent={(terminalId) => { setNotificationsOpen(false); focusTerminal(terminalId); }}
      labels={agentLabels}
      workspaceNames={workspaceNames}
      muted={notificationMute.isMuted}
      onJump={(item) => { setNotificationsOpen(false); props.onJumpToNotification(item); }}
      onMarkRead={props.onClearNotifications}
      onMarkAllRead={props.onMarkAllRead}
      onToggleMute={notificationMute.toggleMute}
      onOpenFleet={() => { setNotificationsOpen(false); navigate("fleet"); }}
    />
  );
  const dockContent = shell.dock.activeTab === "tasks"
    ? tasksPanel
    : shell.dock.activeTab === "preview" ? <PreviewPanel workspaceId={activeWorkspace?.id ?? null} /> : <AgentInspector {...inspectorProps} />;
  const paletteCallbacks = shellPaletteCallbacks(props, {
    navigate,
    focusTerminal,
    toggleDock: () => shell.setDockOpen(!shell.dock.open),
    reopenLastClosedTab: () => {
      const candidate = shell.recentlyClosedTabs[0];
      if (!candidate) return;
      shell.reopenWorkspaceTab(candidate.workspaceId);
      props.onSelectWorkspace(candidate.workspaceId);
    },
  });

  return <>
    <ApplicationShell
      surface={surface}
      defaultLayout={shell.panelLayout ?? undefined}
      onLayoutChanged={shell.setPanelLayout}
      sidebar={sidebar}
      collapsedSidebar={collapsedSidebar}
      sidebarCollapsed={shell.sidebarCollapsed}
      chrome={{
        breadcrumb: surface !== "workbench" ? undefined : { project: activeWorkspace?.name ?? null, agent: focusedLabel?.primary ?? null, branch: props.activeId ? props.branches[props.activeId] ?? null : null },
        title: shellSurfaceTitle(surface, t),
        sidebarCollapsed: shell.sidebarCollapsed,
        onToggleSidebar: shell.toggleSidebar,
        sidebarShortcut: shortcutLabels.sidebar,
        onOpenLauncher: () => setCommandPaletteOpen(true),
        attentionCount: notificationMute.isMuted ? 0 : attentionCount,
        notificationsOpen,
        onNotificationsOpenChange: setNotificationsOpen,
        notificationsPanel,
        onToggleVoice: props.onToggleVoice,
        voiceActive,
        voiceLabel,
        voiceShortcut,
        inspectorOpen: shell.dock.open,
        onToggleInspector: () => shell.setDockOpen(!shell.dock.open),
        inspectorShortcut: shortcutLabels.inspector,
      }}
      rightDock={{
        open: shell.dock.open,
        onOpen: () => shell.setDockOpen(true),
        onClose: () => shell.setDockOpen(false),
        tabs: dockTabs,
        activeTab: shell.dock.activeTab,
        onTabChange: shell.setDockTab,
        content: dockContent,
      }}
      overlay={<ShellVoiceOverlay voice={props} state={visualVoiceState} focusedId={props.focusedId} targets={{ projects: railProjects, labels: agentLabels }} shortcut={voiceShortcut} />}
    >
      {content}
    </ApplicationShell>
    <CommandPalette
      open={commandPaletteOpen}
      onOpenChange={setCommandPaletteOpen}
      workspaces={props.workspaces}
      groups={wireGroups}
      agents={props.agents}
      focusedWorkspaceId={props.activeId}
      focusedTerminalId={props.focusedId}
      hasDetachedTabs={props.detachedTerminalIds.length > 0}
      hasRecentlyClosedTabs={false}
      agentLabels={agentLabels}
      resumeCount={props.resumeCount ?? 0}
      exitedTerminalIds={exitedIds}
      dockOpen={shell.dock.open}
      voiceEnabled={props.voiceEnabled}
      voiceRecording={voiceRecording}
      callbacks={paletteCallbacks}
      onRequestConfirm={(request) => {
        setPendingCommandConfirmation(request);
      }}
    />
    <ShellConfirmDialogs
      commandRequest={pendingCommandConfirmation}
      onCommandRequestChange={setPendingCommandConfirmation}
      inspectorRequest={pendingInspectorAction}
      onInspectorRequestChange={setPendingInspectorAction}
      onImportWorkspace={props.onImportWorkspace}
      onFocusedAgentAction={props.onFocusedAgentAction}
      onKill={props.onKill}
      onRestart={props.onRestart}
    />
  </>;
}
