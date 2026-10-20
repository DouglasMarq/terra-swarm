import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { MotionConfig } from "motion/react";
import { useShallow } from "zustand/react/shallow";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api } from "./api";
import { useBranchPolling } from "./app/useBranchPolling";
import { useFocusTracking } from "./app/useFocusTracking";
import { useGlobalHotkeys } from "./app/useGlobalHotkeys";
import { useGroupActions } from "./app/useGroupActions";
import { useResumeQueue } from "./app/useResumeQueue";
import { useSnapshotTransfer } from "./app/useSnapshotTransfer";
import { useVoiceCapture } from "./app/useVoiceCapture";
import { useVoiceSettings } from "./app/useVoiceSettings";
import { resumeCommandFor, useTerminalSessions } from "./app/useTerminalSessions";
import { useUpdater } from "./app/useUpdater";
import type {
  AgentInfo,
  NotificationItem,
  ResumeItem,
  WorkspaceGroup,
  Workspace,
} from "./types";
import {
  AgentPickerDialog,
  RenameDialog,
  type RenameTargetKind,
  WorkspaceDialog,
} from "./components/integration/dialogs";
import { ConfirmActionDialog } from "./components/overlays/Dialog";
import type { FocusedAgentAction } from "./components/overlays/CommandPalette";
import { getTerminal } from "./terminalRegistry";
import {
  GRID_COL_OPTIONS,
  usePreferencesStore,
} from "./stores/preferencesStore";
import { useTerminalRuntimeStore } from "./stores/terminalRuntimeStore";
import { useUiStore } from "./stores/uiStore";
import { useShellStore } from "./stores/shellStore";
import { useOrchestrationStore } from "./stores/orchestrationStore";
import { t, useLocale } from "./i18n";
import { createInitializationGate, type InitializationGate } from "./lib/session/initializationGate";
import { selectWorkspaceContainerId } from "./lib/session/workspaceContainerSelection";
import {
  isTerminalSuspended,
  suspendedGroupIds,
} from "./lib/session/resumeSelection";
import type { SettingsSectionId } from "./components/settings";
import "./App.css";

const LazyResumeDialog = lazy(async () => {
  const module = await import("./components/ResumeDialog");
  return { default: module.ResumeDialog };
});

const LazyVisualShellSurface = lazy(async () => {
  const module = await import("./components/integration/VisualShellSurface");
  return { default: module.VisualShellSurface };
});

const LazySettingsDialog = lazy(async () => {
  const module = await import("./components/settings/SettingsDialog");
  return { default: module.SettingsDialog };
});

const LazySettingsSectionPanel = lazy(async () => {
  const module = await import("./components/integration/settings/SettingsPanels");
  return { default: module.SettingsSectionPanel };
});

function AppLoadingSurface(_props: { label?: string }) {
  return (
    <div className="terra-app-loading" role="status" aria-live="polite">
      <span>{t("shell.loading")}</span>
    </div>
  );
}

type DurableScrollbackApi = {
  setDurableScrollbackEnabled?: (enabled: boolean) => Promise<void>;
};

function describeInitializationError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return t("app.loadFailed");
}

function App() {
  // Re-render on a language switch so dialogs and labels built here follow it.
  useLocale();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [showNewWs, setShowNewWs] = useState(false);
  const [newWsName, setNewWsName] = useState("");
  const [newWsCwd, setNewWsCwd] = useState("");
  const [newWsGroupId, setNewWsGroupId] = useState<string | null>(null);
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const [pickerTarget, setPickerTarget] = useState<string | null>(null);
  const [pickerTargetPane, setPickerTargetPane] = useState<string | null>(null);
  const [pickerSaveDefault, setPickerSaveDefault] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{
    kind: RenameTargetKind;
    id: string;
    value: string;
  } | null>(null);
  const [workspaceToDelete, setWorkspaceToDelete] = useState<string | null>(null);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  // Settings is a surface of the shell (v3), not a modal.
  const showSettings = useShellStore((state) => state.activeSurface === "settings");
  const setShowSettings = (open: boolean) => {
    const shell = useShellStore.getState();
    if (open) shell.navigate("settings", shell.activeWorkspaceId);
    else if (shell.activeSurface === "settings") shell.navigate("workbench", shell.activeWorkspaceId);
  };
  const [settingsSection, setSettingsSection] =
    useState<SettingsSectionId>("general");
  const openVoiceSettings = useCallback(() => {
    setSettingsSection("voice");
    setShowSettings(true);
  }, []);
  const [initializationError, setInitializationError] = useState<string | null>(null);
  const [initializationRunning, setInitializationRunning] = useState(false);
  const [capturing, setCapturing] = useState<string | null>(null);
  const voiceSettings = useVoiceSettings({
    settingsOpen: showSettings,
    voiceSectionOpen: showSettings && settingsSection === "voice",
  });
  const {
    activeId,
    expandedId,
    focusedId,
    setActiveId,
    setExpandedId,
    setFocusedId,
  } = useUiStore(
    useShallow((state) => ({
      activeId: state.activeId,
      expandedId: state.expandedId,
      focusedId: state.focusedId,
      setActiveId: state.setActiveId,
      setExpandedId: state.setExpandedId,
      setFocusedId: state.setFocusedId,
    })),
  );
  const {
    snapshot: orchestrationSnapshot,
    groups,
    flags,
    sync: syncOrchestration,
    setFeatureFlag,
    setContainerVisible,
    persistenceError: orchestrationPersistenceError,
    clearPersistenceError,
    detachedTerminalIds,
    setTerminalDetached,
    reattachTerminal,
  } = useOrchestrationStore(
    useShallow((state) => ({
      snapshot: state.snapshot,
      groups: state.groups,
      flags: state.flags,
      sync: state.sync,
      setFeatureFlag: state.setFeatureFlag,
      setContainerVisible: state.setContainerVisible,
      persistenceError: state.persistenceError,
      clearPersistenceError: state.clearPersistenceError,
      detachedTerminalIds: state.detachedTerminalIds,
      setTerminalDetached: state.setTerminalDetached,
      reattachTerminal: state.reattachTerminal,
    })),
  );
  const {
    exited,
    notifications,
    notifItems,
    branches,
    contextUsage,
    titles,
    resumeItems,
    resumeSavedAt,
    setExited,
    clearNotificationCount,
    markTerminalRead,
    markAllRead,
    clearAllNotifications,
    pushSystemNotification,
    clearTerminal,
    clearTerminals,
  } = useTerminalRuntimeStore(
    useShallow((state) => ({
      exited: state.exited,
      notifications: state.notifications,
      notifItems: state.notifItems,
      branches: state.branches,
      contextUsage: state.contextUsage,
      titles: state.titles,
      resumeItems: state.resumeItems,
      resumeSavedAt: state.resumeSavedAt,
      setExited: state.setExited,
      clearNotificationCount: state.clearNotificationCount,
      markTerminalRead: state.markTerminalRead,
      markAllRead: state.markAllRead,
      clearAllNotifications: state.clearAllNotifications,
      pushSystemNotification: state.pushSystemNotification,
      clearTerminal: state.clearTerminal,
      clearTerminals: state.clearTerminals,
    })),
  );
  const {
    defaultAgent,
    hotkeys,
    fontSize,
    defaultShell,
    reduceMotion,
    autoResume,
    gridCols,
    voiceEnabled,
    voiceLang,
    voiceInputDevice,
    setDefaultAgent,
    resetHotkeys,
    changeFontSize,
    resetFontSize,
    setDefaultShell,
    setReduceMotion,
    setAutoResume,
    setGridCols,
    setAgentName,
  } = usePreferencesStore(
    useShallow((state) => ({
      defaultAgent: state.defaultAgent,
      hotkeys: state.hotkeys,
      fontSize: state.fontSize,
      defaultShell: state.defaultShell,
      reduceMotion: state.reduceMotion,
      autoResume: state.autoResume,
      gridCols: state.gridCols,
      voiceEnabled: state.voiceEnabled,
      voiceLang: state.voiceLang,
      voiceInputDevice: state.voiceInputDevice,
      setDefaultAgent: state.setDefaultAgent,
      resetHotkeys: state.resetHotkeys,
      changeFontSize: state.changeFontSize,
      resetFontSize: state.resetFontSize,
      setDefaultShell: state.setDefaultShell,
      setReduceMotion: state.setReduceMotion,
      setAutoResume: state.setAutoResume,
      setGridCols: state.setGridCols,
      setAgentName: state.setAgentName,
    })),
  );

  useEffect(() => {
    document.documentElement.classList.toggle("reduce-motion", reduceMotion);
  }, [reduceMotion]);

  // Keep the backend's scrollback writer aligned with the opt-in flag. The
  // optional lookup is a fail-closed bridge while older native binaries are
  // upgraded; once the command is available, a disabled flag explicitly
  // turns persistence off and failures stay contained to this feature.
  useEffect(() => {
    const setter = (api as typeof api & DurableScrollbackApi)
      .setDurableScrollbackEnabled;
    if (typeof setter !== "function") {
      console.warn("durable scrollback command is unavailable; keeping it disabled");
      return;
    }
    setter(flags.durableScrollback).catch((error) => {
      console.warn("failed to sync durable scrollback setting:", error);
    });
  }, [flags.durableScrollback]);

  useEffect(() => {
    if (!orchestrationPersistenceError) return;
    pushSystemNotification(
      t("app.saveFailed", { what: orchestrationPersistenceError.operation, detail: orchestrationPersistenceError.message }),
    );
    clearPersistenceError();
  }, [
    orchestrationPersistenceError,
    clearPersistenceError,
    pushSystemNotification,
  ]);

  const updateReduceMotion = (on: boolean) => {
    setReduceMotion(on);
  };
  const agentsRef = useRef<AgentInfo[]>([]);
  const agentsReadyRef = useRef<Promise<void>>(Promise.resolve());
  const { appVersion, updateVersion, updateInstalling, updateCheckState, manualUpdateCheck, installUpdate } = useUpdater();
  const inited = useRef(false);
  const initializationGateRef = useRef<InitializationGate | null>(null);
  if (!initializationGateRef.current) {
    initializationGateRef.current = createInitializationGate();
  }

  const refresh = useCallback(async () => {
    try {
      const list = await api.listWorkspaces();
      const loadedGroups = await api.listGroups().catch(() => [] as WorkspaceGroup[]);
      syncOrchestration(list, loadedGroups);
      setWorkspaces(list);
      const visibleIds = new Set(
        (useOrchestrationStore.getState().snapshot?.containers ?? [])
          .filter((container) => container.visible)
          .map((container) => container.projectId)
          .filter((id): id is string => Boolean(id)),
      );
      setActiveId((prev) =>
        prev && visibleIds.has(prev)
          ? prev
          : (list.find((workspace) => visibleIds.has(workspace.id))?.id ?? list[0]?.id ?? null),
      );
    } catch (err) {
      console.error("failed to list workspaces:", err);
    }
  }, [syncOrchestration]);

  const sessions = useTerminalSessions({ workspaces, snapshot: orchestrationSnapshot, refresh });
  const resumeQueue = useResumeQueue(sessions, refresh);
  const snapshotTransfer = useSnapshotTransfer(sessions, refresh);

  // Load workspaces and offer to resume terminals that were running at last
  // close. The gate coalesces StrictMode/concurrent attempts, while a failed
  // attempt clears `inited` so the visible retry action can safely run again.
  const initializeApplication = async () => {
    let list = await api.listWorkspaces();
    if (list.length === 0) {
      await api.createWorkspace("default", "");
      list = await api.listWorkspaces();
    }
    const loadedGroups = await api.listGroups().catch(() => [] as WorkspaceGroup[]);
    syncOrchestration(list, loadedGroups);
    setWorkspaces(list);
    const visibleIds = new Set(
      (useOrchestrationStore.getState().snapshot?.containers ?? [])
        .filter((container) => container.visible)
        .map((container) => container.projectId)
        .filter((id): id is string => Boolean(id)),
    );
    setActiveId((previous) =>
      previous && visibleIds.has(previous)
        ? previous
        : (list.find((workspace) => visibleIds.has(workspace.id))?.id ?? list[0]?.id ?? null),
    );

    const running = await api.runningTerminals();
    const runningIds = new Set(running.map((r) => r.id));
    sessions.track(list.flatMap((ws) => ws.terminals.map((terminal) => terminal.id)), running);
    const suspendedGroups = suspendedGroupIds(loadedGroups);
    const suspendedProjects = new Set(
      loadedGroups
        .filter((group) => group.suspended === true)
        .flatMap((group) => group.projectIds),
    );
    // Persisted terminals that are no longer alive were running when the
    // app last closed; offer to resume them instead of silently respawning.
    const items: ResumeItem[] = [];
    const deadIds: string[] = [];
    for (const ws of list) {
      for (const t of ws.terminals) {
        if (runningIds.has(t.id)) continue;
        // Suspended sessions are deliberate dormant state. This also covers
        // imported snapshots, whose backend marks every session suspended.
        if (
          isTerminalSuspended(ws, t, suspendedGroups) ||
          suspendedProjects.has(ws.id)
        ) {
          continue;
        }
        deadIds.push(t.id);
        items.push({
          terminalId: t.id,
          wsId: ws.id,
          wsName: ws.name,
          cwd: ws.cwd,
          command: t.command,
          agentId: t.command.trim().split(/\s+/)[0] || "shell",
          resumeCommand: resumeCommandFor(t.command),
        });
      }
    }
    if (items.length > 0) {
      // Mark persisted-dead terminals as exited up front so panes show the
      // exited overlay instead of a blank live-looking terminal.
      setExited((prev) => {
        const next = { ...prev };
        for (const id of deadIds) next[id] = null;
        return next;
      });
      resumeQueue.offer(items);
    }

    const agentsReady = api
      .detectAgents()
      .then((a) => {
        agentsRef.current = a;
        setAgents(a);
      })
      .catch(() => {});
    agentsReadyRef.current = agentsReady;
    await agentsReady;

    voiceSettings.applyStoredSettings();
  };

  const startInitialization = () => {
    const gate = initializationGateRef.current;
    if (!gate || gate.isRunning()) return;
    inited.current = true;
    setInitializationError(null);
    setInitializationRunning(true);
    void gate.run(initializeApplication).then(
      () => {
        setInitializationRunning(false);
      },
      (error) => {
        console.error("initialization failed:", error);
        inited.current = false;
        setInitializationError(describeInitializationError(error));
        setInitializationRunning(false);
      },
    );
  };

  useEffect(() => {
    if (inited.current) return;
    startInitialization();
  }, []);

  const active = workspaces.find((w) => w.id === activeId) ?? null;
  const showResume = resumeQueue.open;
  const modalOpen =
    showNewWs ||
    showAgentPicker ||
    showResume ||
    renameTarget !== null ||
    workspaceToDelete !== null ||
    showNewGroup ||
    snapshotTransfer.pendingImportPath !== null;

  useBranchPolling(workspaces);

  const { forgetWorkspace } = useFocusTracking({
    workspaces,
    activeId,
    focusedId,
    snapshot: orchestrationSnapshot,
    modalOpen,
  });

  const quickNewTerminal = async (wsId: string, paneId: string | null = null) => {
    setActiveId(wsId);
    setExpandedId(null);
    // Wait for agent detection: at startup `agents` is still empty, and
    // deciding on a stale list would open the picker despite a saved default.
    await agentsReadyRef.current;
    const defAvailable =
      defaultAgent &&
      agentsRef.current.some((a) => a.id === defaultAgent && a.available);
    if (defAvailable) {
      sessions.spawnInto(wsId, defaultAgent, paneId ? { paneId } : undefined).catch(sessions.reportSpawnError);
    } else {
      setPickerTarget(wsId);
      setPickerTargetPane(paneId);
      setPickerSaveDefault(false);
      setShowAgentPicker(true);
    }
  };

  /**
   * The in-panel empty state is an explicit agent-creation affordance. Keep
   * it chooser-first even when a default exists so the user can change the
   * profile for this launch and optionally persist that choice as the new
   * default.
   */
  const chooseAgentForPanel = async (wsId: string, paneId: string | null = null) => {
    setActiveId(wsId);
    setExpandedId(null);
    await agentsReadyRef.current;
    setPickerTarget(wsId);
    setPickerTargetPane(paneId);
    setPickerSaveDefault(true);
    setShowAgentPicker(true);
  };

  const chooseAgent = async (agentId: string) => {
    if (pickerSaveDefault) {
      setDefaultAgent(agentId);
    }
    setShowAgentPicker(false);
    const target = pickerTarget;
    const targetPane = pickerTargetPane;
    setPickerTarget(null);
    setPickerTargetPane(null);
    setPickerSaveDefault(false);
    if (target) {
      await sessions.spawnInto(
        target,
        agentId,
        targetPane ? { paneId: targetPane } : undefined,
      ).catch(sessions.reportSpawnError);
    }
  };

  const clearNotifications = (id: string) => {
    clearNotificationCount(id);
    markTerminalRead(id);
  };

  const jumpToNotification = (item: NotificationItem) => {
    const ws = workspaces.find((w) => w.id === item.workspaceId);
    if (ws?.terminals.some((t) => t.id === item.terminalId)) {
      selectWorkspace(item.workspaceId, item.terminalId);
      setFocusedId(item.terminalId);
    }
    clearNotifications(item.terminalId);
  };

  const renameWorkspace = async (id: string, name: string) => {
    await api.renameWorkspace(id, name).catch(() => {});
    await refresh();
  };

  const submitRename = async () => {
    if (!renameTarget) return;
    const target = renameTarget;
    const nextName = target.value.trim();
    // An empty agent name removes it (back to the task title / kind).
    if (!nextName && target.kind !== "terminal") return;
    setRenameTarget(null);
    if (target.kind === "terminal") {
      setAgentName(target.id, nextName || null);
    } else if (target.kind === "workspace") {
      await renameWorkspace(target.id, nextName);
    } else {
      await renameGroup(target.id, nextName);
    }
  };

  const containerIdForWorkspace = (
    workspaceId: string,
    visibleOnly = false,
    focusedTerminalId = focusedId,
  ): string | null =>
    selectWorkspaceContainerId(orchestrationSnapshot, workspaces, workspaceId, {
      focusedTerminalId,
      visibleOnly,
    });

  /** Hide exactly one visual container. PTYs and sibling containers remain intact. */
  const hideContainer = (containerId: string) => {
    const before = useOrchestrationStore.getState().snapshot;
    const container = before?.containers.find((candidate) => candidate.id === containerId);
    if (!container) return;
    setContainerVisible(containerId, false);
    if (!container.projectId || activeId !== container.projectId) return;

    const after = useOrchestrationStore.getState().snapshot;
    const visibleContainers = (after?.containers ?? []).filter(
      (candidate) => candidate.visible && candidate.id !== containerId && candidate.projectId,
    );
    const next =
      visibleContainers.find((candidate) => candidate.projectId !== container.projectId) ??
      visibleContainers[0];
    setActiveId(next?.projectId ?? null);
    setExpandedId(null);
    setFocusedId(null);
  };

  /** Hide the workspace's persisted active container when invoked by chrome/navigation. */
  const hideWorkspace = (id: string) => {
    const containerId = containerIdForWorkspace(id);
    if (containerId) {
      hideContainer(containerId);
      return;
    }
    if (activeId !== id) return;
    const next = workspaces.find((workspace) => {
      if (workspace.id === id) return false;
      return Boolean(containerIdForWorkspace(workspace.id, true));
    });
    setActiveId(next?.id ?? null);
    setExpandedId(null);
    setFocusedId(null);
  };

  const selectWorkspace = (id: string, focusedTerminalId?: string) => {
    const containerId = containerIdForWorkspace(id, false, focusedTerminalId);
    if (containerId) setContainerVisible(containerId, true);
    // Clicking into a pane of the open project must not undo its maximize.
    if (id !== activeId) setExpandedId(null);
    setActiveId(id);
  };

  const createGroup = () => {
    setNewGroupName("");
    setShowNewGroup(true);
  };

  const submitNewGroup = async () => {
    const name = newGroupName.trim();
    if (!name) return;
    setShowNewGroup(false);
    setNewGroupName("");
    await groupActions.createGroup(name);
  };

  const groupActions = useGroupActions({ workspaces, groups, sessions, refresh, setWorkspaces });
  const { renameGroup, suspendGroup, resumeGroup } = groupActions;

  const voice = useVoiceCapture({
    workspaces,
    groups,
    agents,
    activeWorkspace: active,
    focusedId,
    titles,
    voiceEnabled,
    voiceCommandsEnabled: flags.voiceCommands,
    sessions,
    openVoiceSettings,
    actions: { quickNewTerminal, selectWorkspace, suspendGroup, resumeGroup },
  });

  const stopFleetTerminals = async (ids: string[]) => {
    try {
      await Promise.all(ids.map((id) => api.stopTerminal(id)));
      await refresh();
    } catch (err) {
      console.error("failed to stop fleet terminals:", err);
      pushSystemNotification(t("app.stopSomeFailed"));
      await refresh();
    }
  };

  /** Detaching is visual-only and durable; the PTY remains alive for re-open. */
  const detachTab = (id: string) => {
    setTerminalDetached(id, true);
    setExpandedId((current) => (current === id ? null : current));
    setFocusedId((current) => (current === id ? null : current));
  };

  const pickFolder = async () => {
    try {
      const dir = await openDialog({ directory: true, multiple: false });
      if (typeof dir === "string") {
        setNewWsCwd(dir);
        if (!newWsName) {
          const base = dir.split(/[\\/]/).filter(Boolean).pop();
          if (base) setNewWsName(base);
        }
      }
    } catch (err) {
      console.error("folder picker failed:", err);
    }
  };

  const createWorkspace = async () => {
    try {
      const ws = await api.createWorkspace(
        newWsName.trim() || "workspace",
        newWsCwd,
      );
      if (newWsGroupId) {
        await api.setWorkspaceGroup(ws.id, newWsGroupId).catch((error) => {
          console.error(`failed to assign new workspace ${ws.id} to group:`, error);
        });
      }
      setShowNewWs(false);
      setNewWsName("");
      setNewWsCwd("");
      setNewWsGroupId(null);
      await refresh();
      setActiveId(ws.id);
    } catch (err) {
      console.error("failed to create workspace:", err);
    }
  };

  const openWorkspaceCreator = (groupId: string | null = null) => {
    setNewWsGroupId(groupId);
    setShowNewWs(true);
  };

  const closeWorkspace = async (id: string): Promise<boolean> => {
    const terms = workspaces.find((w) => w.id === id)?.terminals ?? [];
    try {
      await api.closeWorkspace(id);
    } catch (err) {
      console.error(`failed to close workspace ${id}:`, err);
      pushSystemNotification(t("app.deleteFailed", { detail: String(err) }));
      return false;
    }
    sessions.forget(terms.map((term) => term.id));
    forgetWorkspace(id);
    clearTerminals(terms.map((term) => term.id));
    if (activeId === id) {
      setExpandedId(null);
      setFocusedId(null);
    }
    await refresh();
    return true;
  };

  const requestDeleteWorkspace = (id: string) => {
    if (workspaces.some((workspace) => workspace.id === id)) {
      setWorkspaceToDelete(id);
    }
  };

  const applyGridLayout = async (cols: number) => {
    if (!(GRID_COL_OPTIONS as readonly number[]).includes(cols)) return;
    setGridCols(cols);
    // Even out every pane to an equal share of the row, then reload the
    // workspaces so all grids re-layout on the new column count.
    const basis = Math.floor(100 / cols);
    const targets = workspaces.flatMap((w) =>
      w.terminals.map((t) => ({ wsId: w.id, id: t.id })),
    );
    setWorkspaces((prev) =>
      prev.map((w) => ({
        ...w,
        terminals: w.terminals.map((t) => ({ ...t, width: basis })),
      })),
    );
    await Promise.all(
      targets.map(({ wsId, id }) =>
        api.setTerminalWidth(wsId, id, basis).catch(() => {}),
      ),
    );
    await refresh();
  };

  useGlobalHotkeys({
    modalOpen,
    capturing,
    setCapturing,
    shortcutsSectionOpen: showSettings && settingsSection === "shortcuts",
    active,
    focusedId,
    workspaces,
    actions: {
      openWorkspaceCreator: () => openWorkspaceCreator(),
      renameWorkspace: (workspace) => setRenameTarget({ kind: "workspace", id: workspace.id, value: workspace.name }),
      closeWorkspace,
      quickNewTerminal,
      closeTerminal: sessions.close,
      toggleVoice: voice.toggle,
    },
  });

  const handleFocusedAgentAction = async (
    action: FocusedAgentAction,
    context: { workspaceId: string; terminalId: string; command: string },
  ) => {
    const workspace = workspaces.find((candidate) => candidate.id === context.workspaceId);
    const terminal = workspace?.terminals.find((candidate) => candidate.id === context.terminalId);
    if (!workspace || !terminal) return;
    switch (action) {
      case "interrupt":
        await api.writeTerminal(terminal.id, "\u0003").catch(() => {});
        return;
      case "restart":
        await sessions.restart(terminal.id, terminal.command);
        return;
      case "stop":
        await sessions.close(terminal.id);
        return;
      case "clear-scrollback":
        // Clear what the user sees, not only the cached runtime state.
        getTerminal(terminal.id)?.clear();
        clearTerminal(terminal.id);
        pushSystemNotification(t("app.historyCleared"));
        return;
      case "resume":
        await sessions.respawn(workspace.id, terminal.id, resumeCommandFor(terminal.command));
        await refresh();
        return;
    }
  };

  const settingsPage = showSettings ? (
        <Suspense fallback={<AppLoadingSurface label={t("common.settings")} />}>
          <LazySettingsDialog
            variant="page"
            open
            onOpenChange={(open) => {
              setShowSettings(open);
              if (!open) setCapturing(null);
            }}
            activeSection={settingsSection}
            onActiveSectionChange={(section) => {
              setSettingsSection(section);
              setCapturing(null);
            }}
            renderSection={({ section }) => (
              <Suspense fallback={<AppLoadingSurface label={t("settings.title")} />}>
                <LazySettingsSectionPanel
                  section={section}
                  agents={agents}
                  defaultAgent={defaultAgent}
                  onDefaultAgentChange={setDefaultAgent}
                  availableShells={voiceSettings.availableShells}
                  defaultShell={defaultShell}
                  onDefaultShellChange={setDefaultShell}
                  fontSize={fontSize}
                  onFontSizeChange={changeFontSize}
                  onFontSizeReset={resetFontSize}
                  gridCols={gridCols}
                  onGridLayoutChange={applyGridLayout}
                  reduceMotion={reduceMotion}
                  onReduceMotionChange={updateReduceMotion}
                  flags={flags}
                  onFeatureFlagChange={setFeatureFlag}
                  voiceEnabled={voiceEnabled}
                  onVoiceEnabledChange={voiceSettings.setEnabled}
                  voiceLang={voiceLang}
                  onVoiceLangChange={voiceSettings.setLanguage}
                  voiceInputDevice={voiceInputDevice}
                  voiceInputDevices={voiceSettings.inputDevices}
                  onVoiceInputDeviceChange={voiceSettings.setInputDevice}
                  micAvailable={voiceSettings.micAvailable}
                  micTesting={voiceSettings.micTesting}
                  onMicTestToggle={voiceSettings.toggleMicTest}
                  voiceModels={voiceSettings.models}
                  voiceModelsStatus={voiceSettings.modelsStatus}
                  onRetryVoiceModels={voiceSettings.refreshModels}
                  voiceDownload={voiceSettings.download}
                  onVoiceModelSelect={voiceSettings.selectModel}
                  onVoiceModelDownload={voiceSettings.downloadModel}
                  hotkeys={hotkeys}
                  capturing={capturing}
                  onCaptureHotkey={setCapturing}
                  onResetHotkeys={() => {
                    resetHotkeys();
                    setCapturing(null);
                  }}
                  snapshotOperation={snapshotTransfer.operation}
                  snapshotFeedback={snapshotTransfer.feedback}
                  onExportSnapshot={() => {
                    void snapshotTransfer.exportSnapshot();
                  }}
                  onImportSnapshot={() => {
                    void snapshotTransfer.pickImport();
                  }}
                  appVersion={appVersion}
                  updateVersion={updateVersion}
                  updateInstalling={updateInstalling}
                  updateCheckState={updateCheckState}
                  onManualUpdateCheck={manualUpdateCheck}
                  onInstallUpdate={installUpdate}
                />
              </Suspense>
            )}
          />
        </Suspense>
  ) : null;

  return (
    <MotionConfig reducedMotion={reduceMotion ? "always" : "user"}>
      {initializationError ? (
        <div className="terra-initialization-error" role="alert" aria-live="assertive">
          <div>
            <strong>{t("system.initFailed")}</strong>
            <span>{initializationError}</span>
          </div>
          <button type="button" className="terra-button" onClick={startInitialization} disabled={initializationRunning}>
            {initializationRunning ? t("system.retrying") : t("nav.retry")}
          </button>
        </div>
      ) : null}
      <Suspense fallback={<AppLoadingSurface label="workspace" />}>
        <LazyVisualShellSurface
        workspaces={workspaces}
        groups={groups}
        agents={agents}
        snapshot={orchestrationSnapshot}
        activeId={activeId}
        focusedId={focusedId}
        expandedId={expandedId}
        exited={exited}
        notifications={notifications}
        contextUsage={contextUsage}
        titles={titles}
        branches={branches}
        notificationItems={notifItems}
        resumeCount={resumeItems?.length ?? 0}
        appVersion={appVersion}
        onOpenResume={resumeQueue.show}
        detachedTerminalIds={detachedTerminalIds}
        fontSize={fontSize}
        voiceEnabled={voiceEnabled}
        voiceStatus={voice.status}
        voiceState={voice.capsule.state}
        voiceTranscript={voice.capsule.partialTranscript}
        voicePartialTranscript={voice.capsule.partialTranscript}
        voiceFinalTranscript={voice.capsule.finalTranscript}
        voiceIntent={voice.capsule.intent}
        voiceTargetAgent={voice.targetLabel}
        voiceTargetId={voice.targetId}
        settingsPage={settingsPage}
        onRenameAgent={(terminalId) => {
          setRenameTarget({ kind: "terminal", id: terminalId, value: usePreferencesStore.getState().agentNames[terminalId] ?? "" });
        }}
        onVoiceTargetChange={voice.setTargetId}
        voiceLevel={voice.level}
        voiceSamples={voice.samples}
        voiceError={voice.capsule.error}
        voiceSubmitted={voice.submitted}
        voiceFeedback={voice.feedback}
        onFocus={setFocusedId}
        onSelectWorkspace={selectWorkspace}
        onNewWorkspace={() => openWorkspaceCreator()}
        onNewAgent={(workspaceId, paneId, agentId) => {
          if (agentId) {
            void sessions.spawnInto(
              workspaceId,
              agentId,
              paneId ? { paneId } : undefined,
            ).catch(sessions.reportSpawnError);
            return;
          }
          void chooseAgentForPanel(workspaceId, paneId ?? null);
        }}
        onQuickNewAgent={(workspaceId) => void quickNewTerminal(workspaceId)}
        onClearNotifications={clearNotifications}
        onMarkAllRead={markAllRead}
        onClearAll={clearAllNotifications}
        onJumpToNotification={jumpToNotification}
        onRestart={sessions.restart}
        onKill={sessions.close}
        onDetach={detachTab}
        onReattach={(id) => {
          reattachTerminal(id);
          setFocusedId(id);
        }}
        onToggleExpand={setExpandedId}
        onHideWorkspace={hideWorkspace}
        onDeleteWorkspace={requestDeleteWorkspace}
        onHideContainer={hideContainer}
        loadFiles={api.listWorkspaceFiles}
        loadGitStatus={api.gitStatus}
        onCreateGroup={createGroup}
        onCreateProject={(groupId) => openWorkspaceCreator(groupId)}
        onRenameNode={(node) => {
          if (node.kind === "project") {
            const workspace = workspaces.find((candidate) => candidate.id === node.id);
            setRenameTarget({
              kind: "workspace",
              id: node.id,
              value: workspace?.name ?? node.id,
            });
          } else if (node.kind === "group") {
            const group = groups.find((candidate) => candidate.id === node.id);
            setRenameTarget({
              kind: "group",
              id: node.id,
              value: group?.name ?? node.id,
            });
          }
        }}
        onSuspendGroup={(groupId) => {
          void suspendGroup(groupId);
        }}
        onResumeGroup={(groupId) => {
          void resumeGroup(groupId);
        }}
        onBatchStop={(ids) => {
          void stopFleetTerminals(ids);
        }}
        onBatchResume={(ids) => {
          void sessions.resumeTerminals(ids);
        }}
        onOpenSettings={() => {
          setShowSettings(true);
        }}
        onOpenVoiceSettings={openVoiceSettings}
        onToggleVoice={voice.toggle}
        onVoiceStartListening={voice.start}
        onVoiceStopListening={voice.stop}
        onVoiceCancel={voice.cancel}
        onVoiceRetry={voice.retry}
        onVoiceSend={(payload) => {
          void voice.send(payload, false);
        }}
        onVoiceConfirm={(payload) => {
          void voice.send(payload, true);
        }}
        onExportWorkspace={() => {
          void snapshotTransfer.exportSnapshot();
        }}
        onImportWorkspace={() => {
          void snapshotTransfer.pickImport();
        }}
        onFocusedAgentAction={(action, context) => {
          void handleFocusedAgentAction(action, context);
        }}
        />
      </Suspense>

      {showResume ? (
        <Suspense fallback={<AppLoadingSurface label="fila de retomada" />}>
          <LazyResumeDialog
            items={resumeItems ?? []}
            savedAt={resumeSavedAt}
            onResume={resumeQueue.resumeOne}
            onDismiss={resumeQueue.dismissOne}
            onResumeAll={resumeQueue.resumeAll}
            onDismissAll={resumeQueue.dismissAll}
            onDefer={resumeQueue.defer}
            autoResume={autoResume}
            onAutoResumeChange={setAutoResume}
          />
        </Suspense>
      ) : null}

      <WorkspaceDialog
        cwd={newWsCwd}
        groupName={newWsGroupId ? groups.find((group) => group.id === newWsGroupId)?.name : null}
        name={newWsName}
        onBrowse={pickFolder}
        onCwdChange={setNewWsCwd}
        onNameChange={setNewWsName}
        onOpenChange={setShowNewWs}
        onSubmit={createWorkspace}
        open={showNewWs}
      />

      <AgentPickerDialog
        agents={agents}
        defaultAgent={defaultAgent}
        onChoose={chooseAgent}
        onOpenChange={(open) => {
          setShowAgentPicker(open);
          if (!open) {
            setPickerTarget(null);
            setPickerTargetPane(null);
            setPickerSaveDefault(false);
          }
        }}
        onSaveDefaultChange={setPickerSaveDefault}
        open={showAgentPicker}
        saveDefault={pickerSaveDefault}
      />

      <RenameDialog
        kind={renameTarget?.kind ?? "workspace"}
        onChange={(value) => {
          setRenameTarget((current) => current ? { ...current, value } : current);
        }}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
        onSubmit={submitRename}
        open={renameTarget !== null}
        value={renameTarget?.value ?? ""}
      />

      <RenameDialog
        kind="group"
        mode="create"
        onChange={setNewGroupName}
        onOpenChange={(open) => {
          setShowNewGroup(open);
          if (!open) setNewGroupName("");
        }}
        onSubmit={submitNewGroup}
        open={showNewGroup}
        value={newGroupName}
      />

      <ConfirmActionDialog
        description={t("app.importDescription")}
        onConfirm={() => snapshotTransfer.confirmImport()}
        onOpenChange={(open) => {
          if (!open) snapshotTransfer.cancelImport();
        }}
        open={snapshotTransfer.pendingImportPath !== null}
        title={t("app.importTitle")}
        confirmLabel={t("settingsPanels.importSnapshot")}
      />

      <ConfirmActionDialog
        description={(() => {
          const project = workspaceToDelete
            ? workspaces.find((workspace) => workspace.id === workspaceToDelete)
            : null;
          return project
            ? t("app.deleteProjectNamed", { name: project.name })
            : t("app.deleteProject");
        })()}
        onConfirm={async () => {
          if (!workspaceToDelete) return;
          const deleted = await closeWorkspace(workspaceToDelete);
          if (deleted) setWorkspaceToDelete(null);
        }}
        onOpenChange={(open) => {
          if (!open) setWorkspaceToDelete(null);
        }}
        open={workspaceToDelete !== null}
        title={t("app.deleteTitle")}
        confirmLabel={t("app.deleteConfirm")}
      />

    </MotionConfig>
  );
}

export default App;
