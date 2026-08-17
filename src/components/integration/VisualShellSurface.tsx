import { lazy, Suspense, useEffect, useMemo, useReducer, useRef, useState, type ComponentProps, type CSSProperties } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  Activity,
  Bot,
  FolderKanban,
  Gauge,
  LayoutGrid,
  Mic,
  Plus,
  RotateCcw,
  Settings2,
} from "lucide-react";
import { ApplicationShell } from "../shell/ApplicationShell";
import { NavigatorPanel } from "../navigation/NavigatorPanel";
import type { ActivityTab, NavigatorFilesLoader, NavigatorGitLoader, NavigatorNodeRef } from "../navigation/types";
import { HomeDashboard, type HomeActiveGroup, type HomeRecentWorkspace, type HomeTimelineEvent } from "../home/HomeDashboard";
import type { WorkbenchLocation, WorkbenchTabRenderContext } from "../workbench/types";
import type { CommandConfirmRequest, FocusedAgentAction } from "../overlays/CommandPalette";
import { ConfirmActionDialog } from "../overlays/Dialog";
import { VoiceCapsule } from "../voice";
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
import { useShellStore, type DockTab, type ShellSurface } from "../../stores/shellStore";
import { useOrchestrationStore } from "../../stores/orchestrationStore";
import { DEFAULT_HOTKEYS, formatHotkey, usePreferencesStore } from "../../stores/preferencesStore";
import { useShallow as useOrchestrationShallow } from "zustand/react/shallow";
import { EventsSurface } from "./EventsSurface";
import { selectWorkspaceContainerId } from "../../lib/session/workspaceContainerSelection";
import { filterNotificationItemsForTarget } from "./notificationScope";
import { deriveTelemetryModel } from "./telemetry";
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
  type InspectorRuntimeState as InspectorRuntimeView,
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

function SurfaceLoading({ label }: { label: string }) {
  return (
    <div className="terra-surface-loading" role="status" aria-live="polite">
      Carregando {label}…
    </div>
  );
}

function FleetCommandCenter(props: ComponentProps<typeof LazyFleetCommandCenter>) {
  return (
    <Suspense fallback={<SurfaceLoading label="fleet" />}>
      <LazyFleetCommandCenter {...props} />
    </Suspense>
  );
}

function WorkspaceWorkbench(props: ComponentProps<typeof LazyWorkspaceWorkbench>) {
  return (
    <Suspense fallback={<SurfaceLoading label="workbench" />}>
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
  voiceLevel?: number;
  voiceSamples?: readonly number[];
  voiceError?: string | null;
  voiceSubmitted?: boolean;
  voiceFeedback?: string | null;
  onFocus: (id: string) => void;
  onSelectWorkspace: (id: string, focusedTerminalId?: string) => void;
  onNewWorkspace: () => void;
  onNewAgent: (workspaceId: string, paneId?: string | null, agentId?: string) => void;
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

function statusForWorkspace(
  workspace: Workspace,
  exited: Readonly<Record<string, number | null>>,
  notifications: Readonly<Record<string, number>>,
  contextUsage: Readonly<Record<string, number>>,
): "good" | "warn" | "bad" | "neutral" {
  if (workspace.terminals.length === 0) return "neutral";
  if (workspace.terminals.every((terminal) => terminal.id in exited)) return "bad";
  if (workspace.terminals.some((terminal) => (notifications[terminal.id] ?? 0) > 0 || (contextUsage[terminal.id] ?? 0) >= 85)) return "warn";
  return "good";
}

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
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

function inspectorContent(
  props: VisualShellSurfaceProps,
  onAction: (action: InspectorActionKind, target: InspectorTarget) => void,
  runtime: InspectorRuntimeView,
) {
  const target = resolveInspectorTarget({
    focusedId: props.focusedId,
    workspaces: props.workspaces,
    groups: props.groups,
    snapshot: props.snapshot,
    titles: props.titles,
    contextUsage: props.contextUsage,
    exited: props.exited,
    detachedTerminalIds: props.detachedTerminalIds,
  });
  if (!target) {
    return <div className="terra-dock-empty-copy"><Gauge size={18} /><strong>Nada em foco</strong><span>Selecione um agente no Navigator ou Workbench.</span></div>;
  }

  const value = (text: string | null) => text || "—";
  const stateLabel = target.state === "encerrado"
    ? "encerrado"
    : target.state === "suspenso"
      ? "suspenso"
      : "ativo";
  const runtimeStatus = runtime.status === "loading"
    ? "carregando…"
    : runtime.status === "ready"
      ? "disponível"
      : runtime.status === "error"
        ? "indisponível"
        : runtime.status === "unavailable"
          ? "não disponível"
          : "não consultado";
  const ptyState = runtime.status === "ready" && runtime.info
    ? runtime.info.running
      ? "executando"
      : runtime.info.reaped
        ? "encerrado"
        : "inativo"
    : runtime.status === "loading"
      ? "carregando…"
      : runtime.status === "error"
        ? "indisponível"
        : stateLabel;
  const pid = runtime.status === "ready" && runtime.info
    ? runtime.info.pid === null ? "não informado" : String(runtime.info.pid)
    : runtime.status === "loading"
      ? "carregando…"
      : "não disponível";
  const dimensions = runtime.status === "ready" && runtime.info
    ? `${runtime.info.cols} × ${runtime.info.rows}`
    : "não disponível";
  const generation = runtime.status === "ready" && runtime.info
    ? String(runtime.info.generation)
    : "não disponível";
  return (
    <div className="terra-inspector">
      <div className="terra-inspector-hero"><span className="terra-inspector-avatar"><Bot size={16} /></span><div><strong>{target.displayName}</strong><span>{target.workspaceName}</span></div></div>
      <dl>
        <div><dt>Estado</dt><dd>{stateLabel}</dd></div>
        <div><dt>Projeto</dt><dd>{target.projectName}</dd></div>
        <div><dt>Grupo</dt><dd>{value(target.groupName)}</dd></div>
        <div><dt>Container</dt><dd><code>{value(target.containerId)}</code></dd></div>
        <div><dt>Pane</dt><dd><code>{value(target.paneId)}</code></dd></div>
        <div><dt>Tab</dt><dd><code>{value(target.tabId)}</code></dd></div>
        <div><dt>PTY</dt><dd><code>{target.terminalId}</code></dd></div>
        <div><dt>Runtime</dt><dd>{runtimeStatus}</dd></div>
        <div><dt>Estado do PTY</dt><dd>{ptyState}</dd></div>
        <div><dt>PID</dt><dd><code>{pid}</code></dd></div>
        <div><dt>Dimensões</dt><dd><code>{dimensions}</code></dd></div>
        <div><dt>Geração</dt><dd><code>{generation}</code></dd></div>
        <div><dt>Perfil</dt><dd>{target.profileLabel} <code>({target.profileId})</code></dd></div>
        <div><dt>Comando</dt><dd><code>{target.command}</code></dd></div>
        <div><dt>Diretório</dt><dd><code>{value(target.cwd)}</code></dd></div>
        {target.contextUsage !== null ? <div><dt>Contexto</dt><dd>{target.contextUsage}%</dd></div> : null}
      </dl>
      <div className="terra-inspector-actions" aria-label="Ações do inspetor">
        <button type="button" onClick={() => onAction("focus", target)}>Focar</button>
        {target.detached ? (
          <button type="button" onClick={() => onAction("reattach", target)}>Reanexar</button>
        ) : (
          <button type="button" onClick={() => onAction("detach", target)}>Destacar</button>
        )}
        <button type="button" onClick={() => onAction("restart", target)}>Reiniciar</button>
        <button type="button" onClick={() => onAction("kill", target)}>Encerrar</button>
      </div>
    </div>
  );
}

function dockContent(
  tab: DockTab,
  props: VisualShellSurfaceProps,
  onInspectorAction: (action: InspectorActionKind, target: InspectorTarget) => void = () => {},
  runtime: InspectorRuntimeView = INITIAL_INSPECTOR_RUNTIME_STATE,
  voiceShortcut = formatHotkey(DEFAULT_HOTKEYS.toggleVoice),
) {
  if (tab === "inspector") return inspectorContent(props, onInspectorAction, runtime);
  if (tab === "events") {
    const scopedItems = filterNotificationItemsForTarget(props.notificationItems, {
      workspaceId: props.activeId,
      terminalId: props.focusedId,
      snapshot: props.snapshot,
    });
    return <EventsSurface items={scopedItems.slice(0, 12)} onFocus={props.onJumpToNotification} onMarkAllRead={props.onMarkAllRead} onClearAll={props.onClearAll} />;
  }
  if (tab === "context") {
    const used = props.focusedId ? props.contextUsage[props.focusedId] ?? 0 : 0;
    return <div className="terra-dock-context"><div className="terra-context-ring" style={{ "--terra-context-value": `${used}%` } as CSSProperties}><strong>{used}%</strong></div><div><strong>Janela de contexto</strong><span>{props.focusedId ? "Uso estimado do agente em foco." : "Foque um agente para acompanhar o contexto."}</span></div></div>;
  }
  return <VoiceCapsule
    state={props.voiceState ?? (props.voiceStatus === "recording" ? "listening" : props.voiceStatus === "transcribing" ? "transcribing" : "idle")}
    disabled={!props.voiceEnabled}
    shortcut={voiceShortcut}
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
    footer={<span role="status">{props.voiceFeedback || (props.voiceEnabled ? "Comandos e ditado estão disponíveis." : "Ative a voz em Configurações.")}</span>}
  />;
}

export function VisualShellSurface(props: VisualShellSurfaceProps) {
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
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
            : "Runtime indisponível.";
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

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!shouldOpenCommandPaletteShortcut(event)) return;
      event.preventDefault();
      setCommandPaletteOpen(true);
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  const wireGroups = useMemo(() => props.groups.map(toWireGroup), [props.groups]);
  const containerVisibility = useMemo(() => Object.fromEntries(props.workspaces.map((workspace) => {
    const containerId = selectWorkspaceContainerId(props.snapshot, props.workspaces, workspace.id, {
      focusedTerminalId: props.focusedId,
    });
    return [workspace.id, containerId ? props.snapshot?.containers.find((container) => container.id === containerId)?.visible !== false : true];
  })), [props.focusedId, props.snapshot, props.workspaces]);
  const source = useMemo(() => visibleSnapshot(props.snapshot, props.detachedTerminalIds, props.focusedId), [props.detachedTerminalIds, props.focusedId, props.snapshot]);

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
    const ids = new Set(props.workspaces.map((workspace) => workspace.id));
    // Keep an explicitly closed tab closed while the backend workspace still
    // exists. The workspace list is also the source for labels/status updates,
    // so blindly opening every listed workspace here re-opened a tab as soon
    // as closeWorkspaceTab changed the shell state (the topbar close action
    // looked like it had only reordered the tabs).
    const recentlyClosedIds = new Set(
      shell.recentlyClosedTabs.map((tab) => tab.workspaceId),
    );
    props.workspaces.forEach((workspace) => {
      if (recentlyClosedIds.has(workspace.id)) return;
      const existing = shell.workspaceTabs.find((tab) => tab.workspaceId === workspace.id);
      const state = workspace.terminals.some((terminal) => terminal.id in props.exited) ? "attention" : "ready";
      if (existing?.label === workspace.name && existing.state === state) return;
      shell.openWorkspaceTab({ id: workspace.id, workspaceId: workspace.id, label: workspace.name, state, pinned: existing?.pinned });
    });
    // Closed/deleted backend workspaces are removed from the visual tab strip;
    // this does not call a lifecycle command for any surviving PTY.
    shell.workspaceTabs.forEach((tab) => {
      if (!ids.has(tab.workspaceId)) shell.closeWorkspaceTab(tab.workspaceId);
    });
  }, [props.exited, props.workspaces, shell.closeWorkspaceTab, shell.openWorkspaceTab, shell.recentlyClosedTabs, shell.workspaceTabs]);

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

  const recent = useMemo<HomeRecentWorkspace[]>(() => props.workspaces.slice(0, 8).map((workspace) => ({ id: workspace.id, name: workspace.name, detail: workspace.cwd || "Diretório padrão", agentCount: workspace.terminals.length, status: statusForWorkspace(workspace, props.exited, props.notifications, props.contextUsage) })), [props.contextUsage, props.exited, props.notifications, props.workspaces]);
  const activeGroups = useMemo<HomeActiveGroup[]>(() => props.groups.map((group) => ({ id: group.id, name: group.name, workspaceCount: group.projectIds.length, agentCount: props.workspaces.filter((workspace) => group.projectIds.includes(workspace.id)).reduce((count, workspace) => count + workspace.terminals.length, 0), status: group.suspended ? "warn" : "good", detail: group.suspended ? "Grupo suspenso" : "Sessões coordenadas" })), [props.groups, props.workspaces]);
  const timeline = useMemo<HomeTimelineEvent[]>(() => props.notificationItems.slice(0, 8).map((item) => ({ id: String(item.key), label: item.message, detail: item.system ? "Terra" : item.workspaceId, time: timeLabel(item.ts), tone: item.read ? "neutral" : "warn", icon: item.system ? Activity : Bot })), [props.notificationItems]);
  const activeCount = props.workspaces.reduce((count, workspace) => count + workspace.terminals.filter((terminal) => !(terminal.id in props.exited) && !terminal.suspended).length, 0);
  const totalCount = props.workspaces.reduce((count, workspace) => count + workspace.terminals.length, 0);
  const visualVoiceState = props.voiceState ?? (props.voiceStatus === "recording" ? "listening" : props.voiceStatus === "transcribing" ? "transcribing" : "idle");
  const voiceActive = visualVoiceState === "listening" || visualVoiceState === "transcribing";
  const voiceRecording = visualVoiceState === "listening";
  const voiceLabel = visualVoiceState === "listening"
    ? "Ouvindo"
    : visualVoiceState === "transcribing"
      ? "Transcrevendo"
      : visualVoiceState === "preview"
        ? "Prévia de voz"
        : visualVoiceState === "error"
          ? "Erro de voz"
          : "Voz";
  const telemetry = deriveTelemetryModel({
    workspaces: props.workspaces,
    exited: props.exited,
    resumeCount: props.resumeCount,
    contextUsage: props.contextUsage,
    focusedId: props.focusedId,
    voiceEnabled: props.voiceEnabled,
    voiceActive,
    voiceLabel,
    orchestrationHydrated: orchestration.hydrated,
  });

  const focusWorkbenchTab = (id: string, location?: WorkbenchLocation) => {
    if (location) {
      orchestration.setContainerActivePane(location.containerId, location.paneId);
      orchestration.setActivePane?.(location.paneId);
    }
    focusTerminal(id);
  };

  const renderTab = (context: WorkbenchTabRenderContext) => {
    const project = context.project;
    return (
      <Suspense fallback={<SurfaceLoading label="terminal" />}>
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
          detachedIds={new Set(props.detachedTerminalIds)}
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

  const navigator = <NavigatorPanel {...navigatorActivityProps} workspaces={props.workspaces} snapshot={props.snapshot} groups={wireGroups} activeWorkspaceId={props.activeId} activeContainerId={props.snapshot?.activeContainerId ?? null} activePaneId={props.snapshot?.activePaneId ?? null} activeTerminalId={props.focusedId} collapsedIds={shell.navigatorCollapsedIds} onCollapsedChange={shell.setNavigatorCollapsedIds} exited={props.exited} notifications={props.notifications} contextUsage={props.contextUsage} branches={Object.entries(props.branches).map(([workspaceId, name]) => ({ id: `${workspaceId}:${name}`, name, workspaceId }))} containerVisibility={containerVisibility} onOpenWorkspace={(id) => navigate("workbench", id)} onOpenTerminal={(workspaceId, terminalId) => { props.onSelectWorkspace(workspaceId); focusTerminal(terminalId); }} onFocus={focusTerminal} onCreateGroup={props.onCreateGroup} onCreateProject={props.onCreateProject} onCreateAgent={(workspaceId) => props.onNewAgent(workspaceId)} onRenameNode={props.onRenameNode} onDeleteWorkspace={props.onDeleteWorkspace} onHideWorkspace={props.onHideWorkspace} onHideContainer={props.onHideWorkspace} onSuspendGroup={props.onSuspendGroup} onResumeGroup={props.onResumeGroup} emptyState={<div className="terra-navigator-empty"><FolderKanban size={18} /><span>Crie um projeto para começar.</span></div>} />;

  const surface = shell.activeSurface;
  const homeQuickActions = [
    { id: "new-workspace", label: "Novo workspace", description: "Abrir uma superfície de trabalho", shortcut: formatHotkey(hotkeys.newWorkspace ?? DEFAULT_HOTKEYS.newWorkspace), icon: Plus },
    { id: "new-agent", label: "Lançar agente", description: props.workspaces.length > 0 ? "Adicionar uma execução" : "Selecione um workspace para iniciar um agente", shortcut: formatHotkey(hotkeys.newTerminal ?? DEFAULT_HOTKEYS.newTerminal), icon: Bot, disabled: props.workspaces.length === 0 },
    { id: "open-fleet", label: "Abrir fleet", description: "Ver todos os agentes em movimento", icon: LayoutGrid },
    { id: "voice-command", label: "Comando de voz", description: "Orquestrar falando com Terra", shortcut: formatHotkey(hotkeys.toggleVoice ?? DEFAULT_HOTKEYS.toggleVoice), icon: Mic },
    ...(props.resumeCount && props.resumeCount > 0 && props.onOpenResume
      ? [{ id: "resume-sessions", label: "Retomar sessões", description: "Revisar sessões aguardando retomada", icon: RotateCcw }]
      : []),
    { id: "reopen-workspace", label: "Reabrir workspace", description: "Restaurar uma aba visual fechada", icon: RotateCcw, disabled: shell.recentlyClosedTabs.length === 0 },
  ];
  const content = surface === "home" ? <HomeDashboard greeting="Bom dia" subtitle="Uma console silenciosa para coordenar seus agentes." pulse={{ activeAgents: activeCount, totalAgents: totalCount, queuedRuns: props.resumeCount ?? 0, completedRuns: Object.keys(props.exited).length, throughput: activeCount ? `${activeCount} em execução` : "em espera", tone: activeCount ? "stable" : "offline", note: activeCount ? "A frota está pronta para o próximo handoff." : "Inicie um agente para acender o pulso da frota." }} quickActions={homeQuickActions} recentWorkspaces={recent} activeGroups={activeGroups} timeline={timeline} onQuickAction={(id) => { if (id === "new-workspace") props.onNewWorkspace(); else if (id === "new-agent") props.onNewAgent(props.activeId ?? props.workspaces[0]?.id ?? ""); else if (id === "open-fleet") navigate("fleet"); else if (id === "voice-command") props.onToggleVoice(); else if (id === "resume-sessions") props.onOpenResume?.(); else if (id === "reopen-workspace") { const candidate = shell.recentlyClosedTabs[0]; if (shell.reopenWorkspaceTab() && candidate) props.onSelectWorkspace(candidate.workspaceId); } }} onOpenWorkspace={(id) => navigate("workbench", id)} onOpenGroup={(id) => { const workspaceId = props.groups.find((group) => group.id === id)?.projectIds[0]; navigate("workbench", workspaceId ?? null); }} /> : surface === "workbench" ? (source ? <WorkspaceWorkbench source={source} renderTab={renderTab} onNewContainer={props.onNewWorkspace} onFocusTab={(tabId, location) => { if (location) orchestration.setContainerActivePane(location.containerId, location.paneId); const tab = props.snapshot?.tabs.find((candidate) => candidate.id === tabId); if (tab?.ptyId) focusWorkbenchTab(tab.ptyId, location); else props.onFocus(tabId); }} onNewTab={(location: WorkbenchLocation) => props.onNewAgent(location.projectId ?? props.activeId ?? "", location.paneId)} onDetachTab={(tabId) => { const tab = props.snapshot?.tabs.find((candidate) => candidate.id === tabId); if (tab?.ptyId) props.onDetach(tab.ptyId); }} onKillTab={(tabId) => { const tab = props.snapshot?.tabs.find((candidate) => candidate.id === tabId); if (tab?.ptyId) props.onKill(tab.ptyId); }} onCollapseContainer={orchestration.setContainerCollapsed} onFullscreenContainer={orchestration.setContainerFullscreen} onLayoutChange={({ containerId, layout }) => orchestration.setContainerState(containerId, { layout })} onWorkspaceLayoutChange={orchestration.setWorkspaceLayout} onHideContainer={props.onHideContainer ?? ((containerId) => { const container = props.snapshot?.containers.find((candidate) => candidate.id === containerId); if (container?.projectId) props.onHideWorkspace(container.projectId); })} emptyState={<div className="terra-workbench__empty"><LayoutGrid size={20} /><strong>Nenhum workspace visível</strong><button type="button" onClick={props.onNewWorkspace}>Novo workspace</button></div>} /> : <div className="terra-workbench__empty"><LayoutGrid size={20} /><strong>Nenhum workspace carregado</strong></div>) : surface === "fleet" ? <FleetCommandCenter workspaces={props.workspaces} groups={wireGroups} exited={props.exited} notifications={props.notifications} contextUsage={props.contextUsage} titles={props.titles} branches={props.branches} onFocus={(terminalId) => focusTerminal(terminalId)} onVoice={() => props.onToggleVoice()} onStop={(terminalId) => props.onBatchStop([terminalId])} onResume={(terminalId) => props.onBatchResume([terminalId])} onSuspendGroup={props.onSuspendGroup} onResumeGroup={props.onResumeGroup} onBatchAction={(action, ids) => { if (action === "stop") props.onBatchStop(ids); else if (action === "resume") props.onBatchResume(ids); else if (action === "focus" && ids[0]) focusTerminal(ids[0]); else if (action === "voice") props.onToggleVoice(); }} /> : surface === "events" ? <EventsSurface items={props.notificationItems} onFocus={props.onJumpToNotification} onMarkAllRead={props.onMarkAllRead} onClearAll={props.onClearAll} /> : <div className="terra-settings-surface"><Settings2 size={22} /><h1>Configurações</h1><p>Preferências, voz, atalhos e portabilidade do workspace.</p><button type="button" onClick={props.onOpenSettings}>Abrir configurações</button></div>;

  const selectedLabel = props.focusedId ? props.titles[props.focusedId] || props.focusedId : null;
  return <>
    <ApplicationShell defaultLayout={shell.panelLayout ?? undefined} onLayoutChanged={shell.setPanelLayout} chrome={{ activeSurface: surface, workspaceTabs: shell.workspaceTabs.filter((tab) => props.workspaces.some((workspace) => workspace.id === tab.workspaceId)).map((tab) => ({ id: tab.workspaceId, label: tab.label, state: tab.state, closable: true })), activeWorkspaceId: shell.activeWorkspaceId ?? props.activeId, canGoBack: shell.historyIndex > 0, canGoForward: shell.historyIndex < shell.historyLength - 1, onBack: shell.goBack, onForward: shell.goForward, onSelectWorkspace: (id) => navigate("workbench", id), onCloseWorkspace: (id) => { shell.closeWorkspaceTab(id); props.onHideWorkspace(id); }, onReorderWorkspaceTabs: shell.reorderWorkspaceTabs, onNewWorkspace: props.onNewWorkspace, onToggleVoice: props.onToggleVoice, voiceActive, voiceLabel, resources: { active: telemetry.activeAgents, queued: telemetry.queuedRuns }, onOpenLauncher: () => setCommandPaletteOpen(true) }} activity={{ activeSurface: surface, onNavigate: (next) => { if (next === "settings") props.onOpenSettings(); navigate(next); } }} navigator={navigator} rightDock={{ open: shell.dock.open, activeTab: shell.dock.activeTab, onTabChange: shell.setDockTab, onOpen: () => shell.setDockOpen(true), onClose: () => shell.setDockOpen(false), selectedLabel, panels: [{ id: "inspector", label: "Inspetor", content: dockContent("inspector", props, handleInspectorAction, inspectorRuntime) }, { id: "events", label: "Eventos", count: props.notificationItems.filter((item) => !item.read).length, content: dockContent("events", props, handleInspectorAction) }, { id: "context", label: "Contexto", content: dockContent("context", props, handleInspectorAction) }, { id: "voice", label: "Voz", content: dockContent("voice", props, handleInspectorAction, undefined, formatHotkey(hotkeys.toggleVoice ?? DEFAULT_HOTKEYS.toggleVoice)) }] }} telemetry={<>{props.appVersion?.trim() ? <span className="terra-shell-telemetry-item terra-shell-version" aria-label={`Versão ${props.appVersion.trim()}`} title="Versão do aplicativo">v{props.appVersion.trim()}</span> : null}<span className="terra-shell-telemetry-item"><Gauge size={12} /> contexto {telemetry.focusedContext === null ? "—" : `${telemetry.focusedContext}%`}</span><span className="terra-shell-telemetry-item"><Activity size={12} /> {telemetry.syncState === "synced" ? "sincronizado" : "sincronizando"}</span></>}>
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
      dockOpen={shell.dock.open}
      voiceEnabled={props.voiceEnabled}
      voiceRecording={voiceRecording}
      callbacks={{
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
      description={pendingCommandConfirmation ? `${pendingCommandConfirmation.resourceLabel}: ${pendingCommandConfirmation.description}` : ""}
      confirmLabel={pendingCommandConfirmation?.kind === "import-snapshot" ? "Continuar importação" : "Confirmar ação"}
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
      title={pendingInspectorAction?.action === "kill" ? "Encerrar sessão" : "Reiniciar sessão"}
      description={pendingInspectorAction
        ? `${pendingInspectorAction.target.displayName} · ${pendingInspectorAction.target.command}`
        : ""}
      intent={pendingInspectorAction?.action === "kill" ? "destructive" : "default"}
      confirmLabel={pendingInspectorAction?.action === "kill" ? "Encerrar sessão" : "Reiniciar sessão"}
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
