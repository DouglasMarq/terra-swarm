import { lazy, Suspense, useEffect, useMemo, useReducer, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  Copy,
  Eraser,
  GitCompare,
  LayoutGrid,
  PanelRight,
  Pencil,
  Power,
  RotateCcw,
  SquareArrowOutUpRight,
  Square,
} from "lucide-react";
import type { PaneMenuGroups } from "../workbench/PaneActionsMenu";
import { profileForCommand, resolveResumeCommand } from "../../lib/features/agentProfiles";
import { ApplicationShell } from "../shell/ApplicationShell";
import { CollapsedSidebar, Sidebar, SurfaceSwitch, type CollapsedSidebarProject } from "../shell/Sidebar";
import { NotificationCenter } from "../notifications/NotificationCenter";
import { buildAgentLabels } from "../../domain/agentLabels";
import { useT } from "../../i18n";
import { AgentInspector } from "../inspector/AgentInspector";
import { TasksPanel } from "../tasks/TasksPanel";
import { TaskBoard } from "../tasks/TaskBoard";
import { sendPromptToTerminal } from "../../lib/session/sendPrompt";
import { startMcpEventBridge, useReportedStates } from "../../stores/mcpStore";
import { useReviewStore } from "../../stores/reviewStore";
import { useLibraryStore } from "../../stores/libraryStore";
import { useAgentUsage } from "../../stores/usageStore";
import { startPreviewBridge } from "../../stores/previewStore";
import { PreviewPanel } from "../preview/PreviewPanel";
import { deriveAgentStatus } from "../../domain/agentStatus";
import { NavigatorPanel } from "../navigation/NavigatorPanel";
import type { ActivityTab, NavigatorFilesLoader, NavigatorGitLoader, NavigatorNodeRef } from "../navigation/types";
import type { WorkbenchLocation, WorkbenchTabRenderContext } from "../workbench/types";
import type { CommandConfirmRequest, FocusedAgentAction } from "../overlays/CommandPalette";
import { ConfirmActionDialog } from "../overlays/Dialog";
import { VoiceCapsule } from "../voice";
import { VoiceTargetPicker } from "../voice/VoiceTargetPicker";
import type {
  VoiceCapsuleIntent,
  VoiceCapsuleState,
  VoiceSendPayload,
} from "../voice";
import type {
  Group,
  NotificationItem,
  Workspace,
  WorkspaceGroup,
  WorkspaceSnapshotV2,
} from "../../types";
import { useShellStore, type ShellSurface } from "../../stores/shellStore";
import { useOrchestrationStore } from "../../stores/orchestrationStore";
import { DEFAULT_HOTKEYS, formatHotkey, usePreferencesStore } from "../../stores/preferencesStore";
import { useShallow as useOrchestrationShallow } from "zustand/react/shallow";
import { selectWorkspaceContainerId } from "../../lib/session/workspaceContainerSelection";
import { ptyApi } from "../../lib/tauri/pty";
import {
  inspectorActionRequiresConfirmation,
  resolveInspectorTarget,
  type InspectorActionKind,
  type InspectorTarget,
} from "./inspectorModel";
import {
  INITIAL_INSPECTOR_RUNTIME_STATE,
  reduceInspectorRuntime,
} from "./inspectorRuntime";
import "./visual-shell.css";

const LazyFleetCommandCenter = lazy(async () => {
  const module = await import("../fleet/FleetCommandCenter");
  return { default: module.FleetCommandCenter };
});

const LazyWorkspaceWorkbench = lazy(async () => {
  const module = await import("../workbench/WorkspaceWorkbench");
  return { default: module.WorkspaceWorkbench };
});

const LazyTerminalTabSurface = lazy(async () => {
  const module = await import("./TerminalTabSurface");
  return { default: module.TerminalTabSurface };
});

const LazyCommandPalette = lazy(async () => {
  const module = await import("../overlays/CommandPalette/CommandPalette");
  return { default: module.CommandPalette };
});

function SurfaceLoading() {
  const t = useT();
  return (
    <div className="terra-surface-loading" role="status" aria-live="polite">
      {t("shell.loading")}
    </div>
  );
}

function FleetCommandCenter(props: ComponentProps<typeof LazyFleetCommandCenter>) {
  return (
    <Suspense fallback={<SurfaceLoading />}>
      <LazyFleetCommandCenter {...props} />
    </Suspense>
  );
}

function WorkspaceWorkbench(props: ComponentProps<typeof LazyWorkspaceWorkbench>) {
  return (
    <Suspense fallback={<SurfaceLoading />}>
      <LazyWorkspaceWorkbench {...props} />
    </Suspense>
  );
}

function CommandPalette(props: ComponentProps<typeof LazyCommandPalette>) {
  if (!props.open) return null;
  return (
    <Suspense fallback={null}>
      <LazyCommandPalette {...props} />
    </Suspense>
  );
}

/** ⌘B toggles the sidebar and ⌘I the inspector, outside dialogs and terminals' own input. */
function shellShortcut(event: KeyboardEvent): "sidebar" | "inspector" | null {
  if (event.defaultPrevented || event.shiftKey || event.altKey) return null;
  if (!(event.metaKey || event.ctrlKey)) return null;
  const target = event.target;
  if (typeof Element !== "undefined" && target instanceof Element && target.closest('[role="dialog"]')) return null;
  const key = event.key.toLowerCase();
  if (key === "b") return "sidebar";
  if (key === "i") return "inspector";
  return null;
}

export function shouldOpenCommandPaletteShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) return false;
  const target = event.target;
  if (typeof Element !== "undefined" && target instanceof Element && target.closest('[role="dialog"]')) {
    return false;
  }
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
}

export interface VisualShellSurfaceProps {
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
  voiceEnabled: boolean;
  voiceStatus: string;
  voiceState?: VoiceCapsuleState;
  voiceTranscript?: string;
  voicePartialTranscript?: string;
  voiceFinalTranscript?: string;
  voiceIntent?: VoiceCapsuleIntent | null;
  voiceTargetAgent?: string | null;
  /** Terminal that receives dictation (explicit choice or the focused one). */
  voiceTargetId?: string | null;
  onVoiceTargetChange?: (terminalId: string | null) => void;
  /** Settings rendered as a page when the shell surface is "settings". */
  settingsPage?: ReactNode;
  onRenameAgent?: (terminalId: string) => void;
  voiceLevel?: number;
  voiceSamples?: readonly number[];
  voiceError?: string | null;
  voiceSubmitted?: boolean;
  voiceFeedback?: string | null;
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
  onToggleVoice: () => void;
  onVoiceStartListening?: () => void;
  onVoiceStopListening?: () => void;
  onVoiceCancel?: () => void;
  onVoiceRetry?: () => void;
  onVoiceSend?: (payload: VoiceSendPayload) => void;
  onVoiceConfirm?: (payload: VoiceSendPayload) => void;
  onExportWorkspace?: () => void;
  onImportWorkspace?: () => void;
  onFocusedAgentAction?: (action: FocusedAgentAction, context: { workspaceId: string; terminalId: string; command: string }) => void;
}

interface VisualAgent {
  id: string;
  label: string;
  available: boolean;
}

interface PendingInspectorAction {
  action: "restart" | "kill";
  target: InspectorTarget;
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

function visibleSnapshot(
  snapshot: WorkspaceSnapshotV2 | null,
  detachedTerminalIds: readonly string[],
  focusedId: string | null,
): WorkspaceSnapshotV2 | null {
  if (!snapshot || (detachedTerminalIds.length === 0 && !focusedId)) return snapshot;
  const detached = new Set(detachedTerminalIds);
  const tabs = snapshot.tabs.filter((tab) => !tab.ptyId || !detached.has(tab.ptyId));
  const tabIds = new Set(tabs.map((tab) => tab.id));
  const panes = snapshot.panes.map((pane) => {
    const nextTabIds = pane.tabIds.filter((id) => tabIds.has(id));
    const focusedTab = focusedId
      ? pane.tabIds
        .map((id) => snapshot.tabs.find((tab) => tab.id === id))
        .find((tab) => tab?.ptyId === focusedId)
      : undefined;
    return {
      ...pane,
      tabIds: nextTabIds,
      activeTabId: focusedTab && tabIds.has(focusedTab.id)
        ? focusedTab.id
        : pane.activeTabId && tabIds.has(pane.activeTabId)
          ? pane.activeTabId
          : nextTabIds[0] ?? null,
    };
  });
  const activeTabId = snapshot.activeTabId && tabIds.has(snapshot.activeTabId) ? snapshot.activeTabId : tabs[0]?.id ?? null;
  return { ...snapshot, tabs, panes, activeTabId };
}

export function VisualShellSurface(props: VisualShellSurfaceProps) {
  const t = useT();
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [muteUntil, setMuteUntil] = useState(0);
  const [navigatorActivity, setNavigatorActivity] = useState<ActivityTab>("projects");
  const [pendingCommandConfirmation, setPendingCommandConfirmation] = useState<CommandConfirmRequest | null>(null);
  const hotkeys = usePreferencesStore((state) => state.hotkeys);
  const [pendingInspectorAction, setPendingInspectorAction] = useState<PendingInspectorAction | null>(null);
  const [inspectorRuntime, dispatchInspectorRuntime] = useReducer(
    reduceInspectorRuntime,
    INITIAL_INSPECTOR_RUNTIME_STATE,
  );
  const runtimeRequestIdRef = useRef(0);
  const orchestrationActions = useOrchestrationStore(useOrchestrationShallow((state) => ({
    hydrated: state.hydrated,
    setContainerState: state.setContainerState,
    setContainerCollapsed: state.setContainerCollapsed,
    setContainerFullscreen: state.setContainerFullscreen,
    setContainerActivePane: state.setContainerActivePane,
    setActivePane: state.setActivePane,
    setWorkspaceLayout: state.setWorkspaceLayout,
  })));
  const orchestration = useMemo(
    () => ({
      ...orchestrationActions,
    }),
    [orchestrationActions],
  );
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
  useEffect(() => startMcpEventBridge(), []);
  useEffect(() => startPreviewBridge(), []);
  useEffect(() => {
    const terminalId = props.focusedId;
    const requestId = ++runtimeRequestIdRef.current;
    if (!inspectorActive || !terminalId) {
      dispatchInspectorRuntime({ type: "reset", requestId });
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    dispatchInspectorRuntime({ type: "request", terminalId, requestId });

    const poll = async () => {
      try {
        const info = await ptyApi.terminalRuntimeInfo(terminalId);
        if (!cancelled) {
          dispatchInspectorRuntime({ type: "success", terminalId, requestId, info });
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error && error.message.trim()
            ? error.message
            : t("inspector.unavailable");
          dispatchInspectorRuntime({ type: "failure", terminalId, requestId, error: message });
        }
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 1500);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [inspectorActive, props.focusedId]);

  const toggleSidebar = shell.toggleSidebar;
  const setDockOpen = shell.setDockOpen;
  const dockOpen = shell.dock.open;
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const shellKey = shellShortcut(event);
      if (shellKey === "sidebar") {
        event.preventDefault();
        toggleSidebar();
        return;
      }
      if (shellKey === "inspector") {
        event.preventDefault();
        setDockOpen(!dockOpen);
        return;
      }
      if (!shouldOpenCommandPaletteShortcut(event)) return;
      event.preventDefault();
      setCommandPaletteOpen(true);
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [dockOpen, setDockOpen, toggleSidebar]);

  const wireGroups = useMemo(() => props.groups.map(toWireGroup), [props.groups]);
  const containerVisibility = useMemo(() => Object.fromEntries(props.workspaces.map((workspace) => {
    const containerId = selectWorkspaceContainerId(props.snapshot, props.workspaces, workspace.id, {
      focusedTerminalId: props.focusedId,
    });
    return [workspace.id, containerId ? props.snapshot?.containers.find((container) => container.id === containerId)?.visible !== false : true];
  })), [props.focusedId, props.snapshot, props.workspaces]);
  const source = useMemo(() => {
    const visible = visibleSnapshot(props.snapshot, props.detachedTerminalIds, props.focusedId);
    // The Workbench shows one project at a time; the sidebar switches between them.
    if (!visible || !props.activeId) return visible;
    const containers = visible.containers.filter((container) => container.projectId === props.activeId);
    return { ...visible, containers };
  }, [props.activeId, props.detachedTerminalIds, props.focusedId, props.snapshot]);

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


  useEffect(() => {
    if (shell.activeSurface === "workbench" && !shell.activeWorkspaceId && props.activeId) {
      shell.navigate("workbench", props.activeId);
    }
  }, [props.activeId, shell.activeSurface, shell.activeWorkspaceId, shell.navigate]);

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

  const activeCount = props.workspaces.reduce((count, workspace) => count + workspace.terminals.filter((terminal) => !(terminal.id in props.exited) && !terminal.suspended).length, 0);
  const visualVoiceState = props.voiceState ?? (props.voiceStatus === "recording" ? "listening" : props.voiceStatus === "transcribing" ? "transcribing" : "idle");
  const voiceActive = visualVoiceState === "listening" || visualVoiceState === "transcribing";
  const voiceRecording = visualVoiceState === "listening";
  const voiceLabel = visualVoiceState === "listening"
    ? t("shell.voiceListening")
    : visualVoiceState === "transcribing"
      ? t("shell.voiceTranscribing")
      : visualVoiceState === "preview"
        ? t("shell.voicePreview")
        : visualVoiceState === "error"
          ? t("shell.voiceError")
          : t("shell.voice");

  const agentNames = usePreferencesStore((state) => state.agentNames);
  const agentLabels = useMemo(() => buildAgentLabels(props.workspaces, { titles: props.titles, names: agentNames }), [agentNames, props.titles, props.workspaces]);
  const exitedIds = useMemo(() => Object.keys(props.exited), [props.exited]);
  const workspaceNames = useMemo(() => Object.fromEntries(props.workspaces.map((workspace) => [workspace.id, workspace.name])), [props.workspaces]);
  const reported = useReportedStates();
  const agentStatus = (terminal: { id: string; suspended?: boolean }) => deriveAgentStatus({
    suspended: terminal.suspended,
    exited: terminal.id in props.exited,
    notifications: props.notifications[terminal.id],
    contextUsed: props.contextUsage[terminal.id],
    reported: reported[terminal.id],
  });
  const attentionCount = props.workspaces.reduce((count, workspace) => count + workspace.terminals.filter((terminal) => agentStatus(terminal) === "attention").length, 0);
  const railProjects = useMemo<CollapsedSidebarProject[]>(() => props.workspaces.map((workspace) => {
    const agents = workspace.terminals.map((terminal) => {
      const status = agentStatus(terminal);
      const label = agentLabels[terminal.id];
      const detail = t(`status.${status}Lower` as const);
      return { id: terminal.id, label: label?.primary ?? terminal.command, status, detail };
    });
    const suspended = workspace.terminals.length > 0 && workspace.terminals.every((terminal) => terminal.suspended);
    const status = agents.some((agent) => agent.status === "attention") ? "attention" as const : agents.some((agent) => agent.status === "working") ? "working" as const : "idle" as const;
    return { id: workspace.id, name: workspace.name, status, suspended, agents };
  }), [agentLabels, props.contextUsage, props.exited, props.notifications, props.workspaces, reported]);
  const inspectorTarget = resolveInspectorTarget({
    focusedId: props.focusedId,
    workspaces: props.workspaces,
    groups: props.groups,
    snapshot: props.snapshot,
    titles: props.titles,
    contextUsage: props.contextUsage,
    exited: props.exited,
    detachedTerminalIds: props.detachedTerminalIds,
  });
  const inspectorTerminal = inspectorTarget
    ? props.workspaces.flatMap((workspace) => workspace.terminals).find((terminal) => terminal.id === inspectorTarget.terminalId)
    : undefined;
  const inspectorSignals = inspectorTarget
    ? props.notificationItems.filter((item) => item.terminalId === inspectorTarget.terminalId).sort((a, b) => b.ts - a.ts)
    : [];
  const inspectorUsage = useAgentUsage(inspectorTarget?.workspaceId ?? null, inspectorTarget?.terminalId ?? null, inspectorActive);
  const inspectorPanel = (
    <AgentInspector
      target={inspectorTarget}
      label={inspectorTarget ? agentLabels[inspectorTarget.terminalId] ?? null : null}
      status={inspectorTerminal ? agentStatus(inspectorTerminal) : "working"}
      request={inspectorSignals.find((item) => !item.read && !item.system) ?? null}
      activity={inspectorSignals.slice(0, 4)}
      runtime={inspectorRuntime}
      usage={inspectorUsage}
      onAction={handleInspectorAction}
    />
  );
  const contextAlerts = props.workspaces.flatMap((workspace) => workspace.terminals
    .filter((terminal) => !terminal.suspended && !(terminal.id in props.exited) && (props.contextUsage[terminal.id] ?? 0) >= 85)
    .map((terminal) => ({ terminalId: terminal.id, workspaceId: workspace.id, used: props.contextUsage[terminal.id] ?? 0 })));
  const activeWorkspace = props.workspaces.find((workspace) => workspace.id === props.activeId) ?? null;
  const tasksPanel = (
    <TasksPanel
      workspaceId={activeWorkspace?.id ?? null}
      workspaceName={activeWorkspace?.name ?? null}
      agents={(activeWorkspace?.terminals ?? []).map((terminal) => ({
        id: terminal.id,
        label: agentLabels[terminal.id]?.primary ?? terminal.command,
      }))}
    />
  );
  const taskBoard = (
    <TaskBoard
      workspaceId={activeWorkspace?.id ?? null}
      workspaceName={activeWorkspace?.name ?? null}
      agents={(activeWorkspace?.terminals ?? []).map((terminal) => ({
        id: terminal.id,
        label: agentLabels[terminal.id]?.primary ?? terminal.command,
        running: !terminal.suspended && !(terminal.id in props.exited),
      }))}
      onSendPrompt={(terminalId, prompt) => sendPromptToTerminal(terminalId, prompt)}
    />
  );
  const dockTabs = [
    { id: "inspector", label: t("shell.dock.inspector") },
    { id: "tasks", label: t("shell.dock.tasks") },
    { id: "preview", label: t("shell.dock.preview") },
  ] as const;
  const focusedLabel = props.focusedId ? agentLabels[props.focusedId] ?? null : null;
  const muted = muteUntil > Date.now();
  // Re-render when the hour is up so the badge comes back on its own.
  useEffect(() => {
    if (muteUntil <= Date.now()) return;
    const timer = window.setTimeout(() => setMuteUntil(0), muteUntil - Date.now());
    return () => window.clearTimeout(timer);
  }, [muteUntil]);
  const voiceTargets = railProjects.map((project) => ({
    id: project.id,
    name: project.name,
    agents: project.agents.map((agent) => ({
      id: agent.id,
      primary: agentLabels[agent.id]?.primary ?? agent.label,
      tag: agentLabels[agent.id]?.tag ?? agent.label,
      status: agent.status,
      detail: agent.detail,
    })),
  }));
  const voiceOverlay = visualVoiceState === "idle" ? null : (
    <div className="terra-voice-overlay">
      {props.onVoiceTargetChange ? (
        <VoiceTargetPicker projects={voiceTargets} targetId={props.voiceTargetId ?? props.focusedId} onChange={props.onVoiceTargetChange} />
      ) : null}
      <VoiceCapsule
        state={visualVoiceState}
        disabled={!props.voiceEnabled}
        shortcut={formatHotkey(hotkeys.toggleVoice ?? DEFAULT_HOTKEYS.toggleVoice)}
        transcript={props.voiceTranscript}
        partialTranscript={props.voicePartialTranscript}
        finalTranscript={props.voiceFinalTranscript}
        intent={props.voiceIntent}
        targetAgent={props.voiceTargetAgent}
        level={props.voiceLevel}
        samples={props.voiceSamples}
        error={props.voiceError}
        submitted={props.voiceSubmitted}
        onStartListening={props.onVoiceStartListening ?? props.onToggleVoice}
        onStopListening={props.onVoiceStopListening ?? props.onToggleVoice}
        onCancel={props.onVoiceCancel ?? props.onToggleVoice}
        onRetry={props.onVoiceRetry}
        onSend={props.onVoiceSend}
        onConfirm={props.onVoiceConfirm}
        footer={<span role="status">{props.voiceFeedback || (props.voiceEnabled ? t("shell.voiceReady") : t("shell.voiceDisabled"))}</span>}
      />
    </div>
  );

  // A fullscreen project covers the sidebar and the inspector. Opening the
  // inspector leaves fullscreen so it is not opened out of sight, and Esc
  // (outside a terminal, where agents use it) leaves it too.
  const fullscreenIds = useMemo(
    () => (props.snapshot?.containers ?? []).filter((container) => container.fullscreen).map((container) => container.id),
    [props.snapshot],
  );
  useEffect(() => {
    if (shell.dock.open) fullscreenIds.forEach((id) => orchestration.setContainerFullscreen(id, false));
  }, [shell.dock.open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (fullscreenIds.length === 0) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest(".xterm, [role='dialog'], [role='menu']")) return;
      fullscreenIds.forEach((id) => orchestration.setContainerFullscreen(id, false));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fullscreenIds, orchestration]);

  const focusWorkbenchTab = (id: string, location?: WorkbenchLocation) => {
    if (location) {
      orchestration.setContainerActivePane(location.containerId, location.paneId);
      orchestration.setActivePane?.(location.paneId);
    }
    focusTerminal(id);
  };

  const attentionMessages = useMemo(() => {
    const latest: Record<string, { ts: number; message: string }> = {};
    for (const item of props.notificationItems) {
      if (item.read || item.system) continue;
      const current = latest[item.terminalId];
      if (!current || current.ts < item.ts) latest[item.terminalId] = { ts: item.ts, message: item.message };
    }
    return Object.fromEntries(Object.entries(latest).map(([id, value]) => [id, value.message]));
  }, [props.notificationItems]);

  const lastActivity = useMemo(() => {
    const latest: Record<string, number> = {};
    for (const item of props.notificationItems) {
      if (item.system) continue;
      latest[item.terminalId] = Math.max(latest[item.terminalId] ?? 0, item.ts);
    }
    return latest;
  }, [props.notificationItems]);

  const workspaceIdFor = (terminalId: string) => props.workspaces.find((workspace) => workspace.terminals.some((terminal) => terminal.id === terminalId))?.id ?? null;

  const worktreeBranches = Object.fromEntries(
    props.workspaces.flatMap((workspace) => workspace.terminals)
      .filter((terminal) => terminal.worktree)
      .map((terminal) => [terminal.id, terminal.worktree!.branch]),
  );
  const roleLabels: Record<string, string> = Object.fromEntries(
    props.workspaces.flatMap((workspace) => workspace.terminals)
      .filter((terminal) => terminal.role)
      .map((terminal) => [terminal.id, t(`roles.${terminal.role!}`)]),
  );
  const openReview = (terminalId: string) => {
    const workspaceId = workspaceIdFor(terminalId);
    if (!workspaceId) return;
    useReviewStore.getState().open({ workspaceId, terminalId, label: agentLabels[terminalId]?.primary ?? terminalId });
  };
  const buildPaneMenu = (ptyId: string, command: string): PaneMenuGroups => {
    const workspaceId = workspaceIdFor(ptyId);
    const detached = props.detachedTerminalIds.includes(ptyId);
    const resumeCommand = resolveResumeCommand(profileForCommand(command), command);
    const runAction = (action: FocusedAgentAction) => {
      if (workspaceId) props.onFocusedAgentAction?.(action, { workspaceId, terminalId: ptyId, command });
    };
    const label = agentLabels[ptyId]?.primary ?? command;
    return [
      [
        { id: "interrupt", label: t("pane.menu.interrupt"), icon: <Square size={13} />, shortcut: "⌃C", disabled: !workspaceId || !props.onFocusedAgentAction, onSelect: () => runAction("interrupt") },
        { id: "restart", label: t("pane.menu.restart"), icon: <RotateCcw size={13} />, onSelect: () => props.onRestart(ptyId, command) },
        detached
          ? { id: "reattach", label: t("pane.menu.reattach"), icon: <SquareArrowOutUpRight size={13} />, onSelect: () => props.onReattach(ptyId) }
          : { id: "detach", label: t("pane.menu.detach"), icon: <SquareArrowOutUpRight size={13} />, onSelect: () => props.onDetach(ptyId) },
        { id: "inspector", label: t("pane.menu.inspector"), icon: <PanelRight size={13} />, shortcut: "⌘I", onSelect: () => { props.onFocus(ptyId); shell.setDockOpen(true); } },
        ...(worktreeBranches[ptyId] ? [{ id: "review", label: t("review.open"), icon: <GitCompare size={13} />, onSelect: () => openReview(ptyId) }] : []),
      ],
      [
        { id: "copy-resume", label: t("pane.menu.copyResume"), detail: resumeCommand, icon: <Copy size={13} />, onSelect: () => { void window.navigator.clipboard?.writeText(resumeCommand).catch((error) => console.warn("failed to copy the resume command:", error)); } },
        ...(props.onRenameAgent ? [{ id: "rename", label: t("pane.menu.rename"), icon: <Pencil size={13} />, onSelect: () => props.onRenameAgent?.(ptyId) }] : []),
        { id: "clear-history", label: t("pane.menu.clearHistory"), icon: <Eraser size={13} />, disabled: !workspaceId || !props.onFocusedAgentAction, onSelect: () => runAction("clear-scrollback") },
      ],
      [
        {
          id: "kill",
          label: t("pane.menu.kill"),
          icon: <Power size={13} />,
          danger: true,
          disabled: !workspaceId || !props.onFocusedAgentAction,
          onSelect: () => setPendingCommandConfirmation({
            kind: "stop-agent",
            commandId: `pane:kill:${ptyId}`,
            title: t("pane.confirmKill.title"),
            description: t("pane.confirmKill.description"),
            resourceId: ptyId,
            resourceLabel: label,
            workspaceId: workspaceId ?? undefined,
            terminalId: ptyId,
            action: "stop",
          }),
        },
      ],
    ];
  };

  const renderTab = (context: WorkbenchTabRenderContext) => {
    const project = context.project;
    return (
      <Suspense fallback={<SurfaceLoading />}>
        <LazyTerminalTabSurface
          context={context}
          fontSize={props.fontSize}
          focusedId={props.focusedId}
          expandedId={props.expandedId}
          exited={props.exited}
          notifications={props.notifications}
          contextUsage={props.contextUsage}
          titles={props.titles}
          branch={project ? props.branches[project.id] : undefined}
          worktreeBranches={worktreeBranches}
          roleLabels={roleLabels}
          onOpenReview={openReview}
          detachedIds={new Set(props.detachedTerminalIds)}
          labels={agentLabels}
          attentionMessages={attentionMessages}
          buildMenu={buildPaneMenu}
          onClearNotifications={props.onClearNotifications}
          onFocus={(id) => focusWorkbenchTab(id, { containerId: context.container.id, paneId: context.pane.id, projectId: context.project?.id ?? null })}
          onToggleExpand={props.onToggleExpand}
          onRestart={props.onRestart}
          onDetach={props.onDetach}
          onKill={props.onKill}
        />
      </Suspense>
    );
  };

  const surface = shell.activeSurface;
  const branchList = Object.entries(props.branches).map(([workspaceId, name]) => ({ id: `${workspaceId}:${name}`, name, workspaceId }));
  const navigator = <NavigatorPanel {...navigatorActivityProps} flatten agentLabels={agentLabels} agentMenu={buildPaneMenu} headerSlot={<SurfaceSwitch surface={surface} attentionCount={attentionCount} onNavigate={(next) => navigate(next)} />} workspaces={props.workspaces} snapshot={props.snapshot} groups={wireGroups} activeWorkspaceId={props.activeId} activeContainerId={props.snapshot?.activeContainerId ?? null} activePaneId={props.snapshot?.activePaneId ?? null} activeTerminalId={props.focusedId} collapsedIds={shell.navigatorCollapsedIds} onCollapsedChange={shell.setNavigatorCollapsedIds} exited={props.exited} notifications={props.notifications} contextUsage={props.contextUsage} branches={branchList} containerVisibility={containerVisibility} onOpenWorkspace={(id) => navigate("workbench", id)} onOpenTerminal={(workspaceId, terminalId) => { props.onSelectWorkspace(workspaceId); focusTerminal(terminalId); }} onFocus={focusTerminal} onCreateGroup={props.onCreateGroup} onCreateProject={props.onCreateProject} onCreateAgent={(workspaceId) => props.onNewAgent(workspaceId)} onRenameNode={props.onRenameNode} onDeleteWorkspace={props.onDeleteWorkspace} onHideWorkspace={props.onHideWorkspace} onHideContainer={props.onHideContainer ?? props.onHideWorkspace} onSuspendGroup={props.onSuspendGroup} onResumeGroup={props.onResumeGroup} />;
  const sidebar = <Sidebar surface={surface} attentionCount={attentionCount} onNavigate={(next) => navigate(next)} activeAgents={activeCount} version={props.appVersion?.trim() || undefined} onOpenSettings={props.onOpenSettings}>{navigator}</Sidebar>;
  const collapsedSidebar = <CollapsedSidebar surface={surface} attentionCount={attentionCount} projects={railProjects} activeWorkspaceId={props.activeId} focusedAgentId={props.focusedId} onNavigate={(next) => navigate(next)} onOpenWorkspace={(id) => navigate("workbench", id)} onFocusAgent={(_workspaceId, terminalId) => focusTerminal(terminalId)} onOpenSettings={props.onOpenSettings} onExpand={() => shell.setSidebarCollapsed(false)} expandShortcut="⌘B" />;

  const content = surface === "settings" && props.settingsPage ? props.settingsPage : surface === "board" ? taskBoard : surface === "fleet" ? <FleetCommandCenter workspaces={props.workspaces} groups={wireGroups} reported={reported} exited={props.exited} notifications={props.notifications} contextUsage={props.contextUsage} titles={props.titles} branches={props.branches} lastActivity={lastActivity} labels={agentLabels} attentionMessages={attentionMessages} onFocus={(terminalId) => focusTerminal(terminalId)} onMarkRead={props.onClearNotifications} onBatchAction={(action, ids) => { if (action === "stop") props.onBatchStop(ids); else if (action === "resume") props.onBatchResume(ids); else if (action === "focus" && ids[0]) focusTerminal(ids[0]); else if (action === "voice") { if (ids[0]) focusTerminal(ids[0]); props.onToggleVoice(); } }} /> : (source ? <WorkspaceWorkbench source={source} renderTab={renderTab} onNewContainer={props.onNewWorkspace} onFocusTab={(tabId, location) => { if (location) orchestration.setContainerActivePane(location.containerId, location.paneId); const tab = props.snapshot?.tabs.find((candidate) => candidate.id === tabId); if (tab?.ptyId) focusWorkbenchTab(tab.ptyId, location); else props.onFocus(tabId); }} onNewTab={(location: WorkbenchLocation) => props.onNewAgent(location.projectId ?? props.activeId ?? "", location.paneId)} onQuickNewTab={props.onQuickNewAgent ? (location: WorkbenchLocation) => props.onQuickNewAgent?.(location.projectId ?? props.activeId ?? "") : undefined} onDetachTab={(tabId) => { const tab = props.snapshot?.tabs.find((candidate) => candidate.id === tabId); if (tab?.ptyId) props.onDetach(tab.ptyId); }} onKillTab={(tabId) => { const tab = props.snapshot?.tabs.find((candidate) => candidate.id === tabId); if (tab?.ptyId) props.onKill(tab.ptyId); }} onCollapseContainer={(containerId, collapsed) => { if (collapsed) orchestration.setContainerFullscreen(containerId, false); orchestration.setContainerCollapsed(containerId, collapsed); }} onFullscreenContainer={orchestration.setContainerFullscreen} onLayoutChange={({ containerId, layout }) => orchestration.setContainerState(containerId, { layout })} onWorkspaceLayoutChange={orchestration.setWorkspaceLayout} onHideContainer={props.onHideContainer ?? ((containerId) => { const container = props.snapshot?.containers.find((candidate) => candidate.id === containerId); if (container?.projectId) props.onHideWorkspace(container.projectId); })} emptyState={<div className="terra-workbench__empty"><LayoutGrid size={20} /><strong>{t("shell.workbenchEmpty")}</strong><button type="button" className="terra-button" onClick={props.onNewWorkspace}>{t("shell.newWorkspace")}</button></div>} /> : <div className="terra-workbench__empty"><LayoutGrid size={20} /><strong>{t("shell.workbenchNotLoaded")}</strong></div>);


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
        title: surface === "fleet" ? t("common.fleet") : surface === "board" ? t("common.board") : surface === "settings" ? t("common.settings") : t("common.appName"),
        sidebarCollapsed: shell.sidebarCollapsed,
        onToggleSidebar: shell.toggleSidebar,
        sidebarShortcut: "⌘B",
        onOpenLauncher: () => setCommandPaletteOpen(true),
        attentionCount: muted ? 0 : attentionCount,
        notificationsOpen,
        onNotificationsOpenChange: setNotificationsOpen,
        notificationsPanel: <NotificationCenter items={props.notificationItems} contextAlerts={contextAlerts} onFocusAgent={(terminalId) => { setNotificationsOpen(false); focusTerminal(terminalId); }} labels={agentLabels} workspaceNames={workspaceNames} muted={muted} onJump={(item) => { setNotificationsOpen(false); props.onJumpToNotification(item); }} onMarkRead={props.onClearNotifications} onMarkAllRead={props.onMarkAllRead} onToggleMute={() => setMuteUntil(muted ? 0 : Date.now() + 60 * 60 * 1000)} onOpenFleet={() => { setNotificationsOpen(false); navigate("fleet"); }} />,
        onToggleVoice: props.onToggleVoice,
        voiceActive,
        voiceLabel,
        voiceShortcut: formatHotkey(hotkeys.toggleVoice ?? DEFAULT_HOTKEYS.toggleVoice),
        inspectorOpen: shell.dock.open,
        onToggleInspector: () => shell.setDockOpen(!shell.dock.open),
        inspectorShortcut: "⌘I",
      }}
      rightDock={{
        open: shell.dock.open,
        onOpen: () => shell.setDockOpen(true),
        onClose: () => shell.setDockOpen(false),
        tabs: dockTabs,
        activeTab: shell.dock.activeTab,
        onTabChange: (tab) => shell.setDockTab(tab === "tasks" || tab === "preview" ? tab : "inspector"),
        content: shell.dock.activeTab === "tasks" ? tasksPanel : shell.dock.activeTab === "preview" ? <PreviewPanel workspaceId={activeWorkspace?.id ?? null} /> : inspectorPanel,
      }}
      overlay={voiceOverlay}
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
      // Workspace tabs are gone from the chrome; nothing to reopen.
      hasRecentlyClosedTabs={false}
      agentLabels={agentLabels}
      resumeCount={props.resumeCount ?? 0}
      exitedTerminalIds={exitedIds}
      dockOpen={shell.dock.open}
      voiceEnabled={props.voiceEnabled}
      voiceRecording={voiceRecording}
      callbacks={{
        onFocusedAgentAction: props.onFocusedAgentAction
          ? (action, context) => props.onFocusedAgentAction?.(action, context)
          : undefined,
        onNavigate: (route) => {
          if (route === "settings") {
            props.onOpenSettings();
            return;
          }
          navigate(route);
        },
        onOpenWorkspace: (id) => navigate("workbench", id),
        onOpenGroup: (id) => {
          const workspaceId = props.groups.find((group) => group.id === id)?.projectIds[0];
          navigate("workbench", workspaceId ?? null);
        },
        onOpenTerminal: (_workspaceId, terminalId) => focusTerminal(terminalId),
        onCreateProject: props.onCreateProject,
        onCreateGroup: props.onCreateGroup,
        onCreateAgent: (workspaceId, agentId) =>
          props.onNewAgent(workspaceId ?? props.activeId ?? "", null, agentId),
        onToggleDock: () => shell.setDockOpen(!shell.dock.open),
        onOpenVoiceSettings: props.onOpenVoiceSettings ?? props.onToggleVoice,
        onStartVoice: props.onVoiceStartListening ?? props.onToggleVoice,
        onStopVoice: props.onVoiceStopListening ?? props.onToggleVoice,
        onExportWorkspace: props.onExportWorkspace,
        onImportWorkspace: props.onImportWorkspace,
        onReattachTerminal: () => {
          const terminalId = props.detachedTerminalIds[0];
          if (terminalId) focusTerminal(terminalId);
        },
        onOpenResume: props.onOpenResume,
        onOpenLibrary: (dialog) => useLibraryStore.getState().openDialog(dialog),
        onReopenTab: () => {
          const candidate = shell.recentlyClosedTabs[0];
          if (shell.reopenWorkspaceTab() && candidate) props.onSelectWorkspace(candidate.workspaceId);
        },
      }}
      onRequestConfirm={(request) => {
        setPendingCommandConfirmation(request);
      }}
    />
    <ConfirmActionDialog
      open={pendingCommandConfirmation !== null}
      onOpenChange={(open) => {
        if (!open) setPendingCommandConfirmation(null);
      }}
      title={pendingCommandConfirmation?.title}
      description={pendingCommandConfirmation ? t("dialogs.resourceDescription", { resource: pendingCommandConfirmation.resourceLabel, description: pendingCommandConfirmation.description }) : ""}
      intent={pendingCommandConfirmation?.kind === "stop-agent" ? "destructive" : "default"}
      confirmLabel={pendingCommandConfirmation?.kind === "import-snapshot" ? t("system.continueImport") : pendingCommandConfirmation?.kind === "stop-agent" ? t("pane.confirmKill.confirm") : t("dialogs.confirmTitle")}
      onConfirm={() => {
        const request = pendingCommandConfirmation;
        if (!request) return;
        setPendingCommandConfirmation(null);
        if (request.kind === "import-snapshot") {
          props.onImportWorkspace?.();
          return;
        }
        if (request.action && request.workspaceId && request.terminalId) {
          props.onFocusedAgentAction?.(request.action, {
            workspaceId: request.workspaceId,
            terminalId: request.terminalId,
            command: request.resourceLabel,
          });
        }
      }}
    />
    <ConfirmActionDialog
      open={pendingInspectorAction !== null}
      onOpenChange={(open) => {
        if (!open) setPendingInspectorAction(null);
      }}
      title={pendingInspectorAction?.action === "kill" ? t("pane.confirmKill.confirm") : t("system.restartSession")}
      description={pendingInspectorAction
        ? `${pendingInspectorAction.target.displayName} · ${pendingInspectorAction.target.command}`
        : ""}
      intent={pendingInspectorAction?.action === "kill" ? "destructive" : "default"}
      confirmLabel={pendingInspectorAction?.action === "kill" ? t("pane.confirmKill.confirm") : t("system.restartSession")}
      onConfirm={() => {
        const request = pendingInspectorAction;
        if (!request) return;
        setPendingInspectorAction(null);
        if (request.action === "kill") props.onKill(request.target.terminalId);
        else props.onRestart(request.target.terminalId, request.target.command);
      }}
    />
  </>;
}
