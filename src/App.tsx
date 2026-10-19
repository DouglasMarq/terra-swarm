import { lazy, Suspense, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { MotionConfig } from "motion/react";
import { useShallow } from "zustand/react/shallow";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { api } from "./api";
import { checkForUpdate, installPendingUpdate } from "./updater";
import type {
  AgentInfo,
  ContextPayload,
  ExitPayload,
  NotificationItem,
  NotificationPayload,
  ResumeItem,
  SpawnedTerminal,
  TitlePayload,
  VoiceDownloadProgress,
  VoiceModelInfo,
  VoiceStatus,
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
import {
  createInitialVoiceCapsuleModel,
  canExecuteVoiceIntent,
  isDestructiveVoiceIntent,
  reduceVoiceCapsuleModel,
  type VoiceCapsuleIntent,
  type VoiceSendPayload,
} from "./components/voice";
import { getTerminal } from "./terminalRegistry";
import { createDebouncedTask } from "./lib/async/debounce";
import {
  GRID_COL_OPTIONS,
  HOTKEY_ACTIONS,
  matchHotkey,
  type Hotkey,
  usePreferencesStore,
} from "./stores/preferencesStore";
import { useTerminalRuntimeStore } from "./stores/terminalRuntimeStore";
import { useUiStore } from "./stores/uiStore";
import { useShellStore } from "./stores/shellStore";
import { useOrchestrationStore } from "./stores/orchestrationStore";
import { planResume } from "./lib/session/resumePlanner";
import { buildAgentLabels } from "./domain/agentLabels";
import { createSpawnQueue } from "./lib/session/spawnQueue";
import { createInitializationGate, type InitializationGate } from "./lib/session/initializationGate";
import { dismissResumeItems } from "./lib/session/resumeDismiss";
import { isCurrentSpawnedTerminalRunning } from "./lib/session/terminalLifecycle";
import { workspaceIdForTerminal } from "./lib/session/terminalOwnership";
import { selectWorkspaceContainerId } from "./lib/session/workspaceContainerSelection";
import {
  isTerminalSuspended,
  suspendedGroupIds,
} from "./lib/session/resumeSelection";
import { parseVoiceCommand } from "./lib/voiceCommands";
import {
  buildVoicePrompt,
  profileForCommand,
  resolveResumeCommand,
} from "./lib/features/agentProfiles";
import type { SettingsSectionId } from "./components/settings";
import type {
  SnapshotFeedback,
  SnapshotOperation,
} from "./components/integration/settings/SettingsPanels";
import "./App.css";

const BRANCH_POLL_MS = 10000;
const UPDATE_CHECK_MS = 60 * 60 * 1000;

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

function AppLoadingSurface({ label }: { label: string }) {
  return (
    <div className="terra-app-loading" role="status" aria-live="polite">
      <span>Carregando {label}…</span>
    </div>
  );
}

function resumeCommandFor(command: string): string {
  const profile = profileForCommand(command);
  return resolveResumeCommand(profile, command);
}

/** Compare spoken labels without making callers know about locale accents. */
function normalizeVoiceLookup(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[!?.,:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("pt-BR");
}

type DurableScrollbackApi = {
  setDurableScrollbackEnabled?: (enabled: boolean) => Promise<void>;
};

function describeSnapshotError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "A operação do snapshot falhou. Nada foi alterado.";
}

function describeInitializationError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Não foi possível carregar os workspaces. Tente novamente.";
}

function App() {
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
  const [showSettings, setShowSettings] = useState(false);
  const [autoResumePending, setAutoResumePending] = useState(false);
  const [showResumeQueue, setShowResumeQueue] = useState(false);
  const [initializationError, setInitializationError] = useState<string | null>(null);
  const [initializationRunning, setInitializationRunning] = useState(false);
  const [pendingImportPath, setPendingImportPath] = useState<string | null>(null);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSectionId>("terminal");
  const [capturing, setCapturing] = useState<string | null>(null);
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
    setGroupSuspended,
    setActivePane: setActivePaneSnapshot,
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
      setGroupSuspended: state.setGroupSuspended,
      setActivePane: state.setActivePane,
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
    setContextUsage,
    setTitles,
    addNotification,
    clearNotificationCount,
    markTerminalRead,
    markAllRead,
    clearAllNotifications,
    pushSystemNotification,
    notifyUpdateAvailable,
    setBranches,
    setResumeItems,
    setResumeSavedAt,
    dropResumeItem,
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
      setContextUsage: state.setContextUsage,
      setTitles: state.setTitles,
      addNotification: state.addNotification,
      clearNotificationCount: state.clearNotificationCount,
      markTerminalRead: state.markTerminalRead,
      markAllRead: state.markAllRead,
      clearAllNotifications: state.clearAllNotifications,
      pushSystemNotification: state.pushSystemNotification,
      notifyUpdateAvailable: state.notifyUpdateAvailable,
      setBranches: state.setBranches,
      setResumeItems: state.setResumeItems,
      setResumeSavedAt: state.setResumeSavedAt,
      dropResumeItem: state.dropResumeItem,
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
    voiceModel,
    voiceInputDevice,
    setDefaultAgent,
    setHotkeys,
    resetHotkeys,
    changeFontSize,
    resetFontSize,
    setDefaultShell,
    setReduceMotion,
    setAutoResume,
    setGridCols,
    setVoiceEnabled,
    setVoiceLang,
    setVoiceModel,
    setVoiceInputDevice,
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
      voiceModel: state.voiceModel,
      voiceInputDevice: state.voiceInputDevice,
      setDefaultAgent: state.setDefaultAgent,
      setHotkeys: state.setHotkeys,
      resetHotkeys: state.resetHotkeys,
      changeFontSize: state.changeFontSize,
      resetFontSize: state.resetFontSize,
      setDefaultShell: state.setDefaultShell,
      setReduceMotion: state.setReduceMotion,
      setAutoResume: state.setAutoResume,
      setGridCols: state.setGridCols,
      setVoiceEnabled: state.setVoiceEnabled,
      setVoiceLang: state.setVoiceLang,
      setVoiceModel: state.setVoiceModel,
      setVoiceInputDevice: state.setVoiceInputDevice,
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
      `Não foi possível salvar ${orchestrationPersistenceError.operation}: ${orchestrationPersistenceError.message}`,
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
  const [availableShells, setAvailableShells] = useState<string[]>([]);
  const [voiceInputDevices, setVoiceInputDevices] = useState<string[]>([]);
  const [micTesting, setMicTesting] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>("idle");
  const [voiceCapsule, dispatchVoiceCapsule] = useReducer(
    reduceVoiceCapsuleModel,
    undefined,
    createInitialVoiceCapsuleModel,
  );
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [voiceSamples, setVoiceSamples] = useState<number[]>([]);
  const [voiceFeedback, setVoiceFeedback] = useState<string | null>(null);
  const [voiceSubmitted, setVoiceSubmitted] = useState(false);
  const [voiceModels, setVoiceModels] = useState<VoiceModelInfo[]>([]);
  const [voiceDl, setVoiceDl] = useState<{
    id: string;
    percent: number;
  } | null>(null);
  const [micAvailable, setMicAvailable] = useState<boolean | null>(null);
  const [appVersion, setAppVersion] = useState<string>("");
  const [snapshotOperation, setSnapshotOperation] =
    useState<SnapshotOperation | null>(null);
  const [snapshotFeedback, setSnapshotFeedback] =
    useState<SnapshotFeedback | null>(null);
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [updateCheckState, setUpdateCheckState] = useState<
    "idle" | "checking" | "uptodate" | "error"
  >("idle");
  const inited = useRef(false);
  const initializationGateRef = useRef<InitializationGate | null>(null);
  if (!initializationGateRef.current) {
    initializationGateRef.current = createInitializationGate();
  }
  // Authoritative set of terminal ids the UI tracks; mutated only by
  // spawn/close paths (never rebuilt from `workspaces`, which would race
  // with pending refreshes and silently drop live ids).
  const liveIdsRef = useRef<Set<string>>(new Set());
  const spawnSeqRef = useRef<Record<string, number>>({});
  const lastFocusByWs = useRef<Record<string, string>>({});
  const prevActiveId = useRef<string | null>(null);
  const persistedPaneSelectionRef = useRef<string | null>(null);
  const resumingTerminalIdsRef = useRef<Set<string>>(new Set());
  const resumeQueueMutationRef = useRef(false);

  /**
   * `spawn_terminal` can resolve after a short-lived child has already been
   * reaped and its exit event emitted. Register the id before the query, then
   * reconcile the returned generation with the backend's live snapshot so a
   * missed event cannot leave dead metadata rendered as an active terminal.
   */
  const registerSpawnedTerminal = async (result: SpawnedTerminal) => {
    const id = result.meta.id;
    liveIdsRef.current.add(id);
    spawnSeqRef.current[id] = result.seq;
    try {
      const running = await api.runningTerminals();
      const isRunning = isCurrentSpawnedTerminalRunning(id, result.seq, running);
      setExited((previous) => {
        const next = { ...previous };
        if (isRunning) {
          delete next[id];
        } else if (!(id in next)) {
          // The exit event may have been emitted before liveIdsRef was
          // registered. Preserve a code received by a concurrent listener;
          // otherwise null is the intentional unknown-code marker.
          next[id] = null;
        }
        return next;
      });
      if (!isRunning) {
        setContextUsage((previous) => {
          const next = { ...previous };
          delete next[id];
          return next;
        });
      }
    } catch (error) {
      // Registration remains authoritative even when this best-effort
      // reconciliation cannot query an older native binary.
      console.warn(`failed to reconcile spawned terminal ${id}:`, error);
    }
  };

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
    for (const ws of list) {
      for (const t of ws.terminals) liveIdsRef.current.add(t.id);
    }
    for (const r of running) {
      spawnSeqRef.current[r.id] = r.seq;
    }
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
      setResumeItems(items);
      if (usePreferencesStore.getState().autoResume) setAutoResumePending(true);
      else setShowResumeQueue(true);
      api.storeSavedAt().then(setResumeSavedAt).catch(() => {});
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

    getVersion()
      .then(setAppVersion)
      .catch(() => {});

    // Push persisted voice settings into the backend (model load is async).
    // If the mic is gone while the feature was left enabled, disable it.
    if (voiceEnabled) {
      api
        .voiceMicAvailable()
        .then((avail) => {
          setMicAvailable(avail);
          if (!avail) disableVoiceInput(false);
        })
        .catch(() => {});
      api.voiceSetLanguage(voiceLang).catch(() => {});
      api.voiceSetInputDevice(voiceInputDevice).catch(() => {});
      if (voiceModel) {
        api.voiceSetModel(voiceModel).catch(handleVoiceModelLoadError);
      }
    }
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

  // Global backend event listeners. Registered in a dedicated effect (no
  // one-time guard) so StrictMode's unmount/remount cycle re-registers them.
  useEffect(() => {
    const unlisten = listen<ExitPayload>("terminal-exit", (e) => {
      if (!liveIdsRef.current.has(e.payload.id)) return;
      // Ignore exit events from a previous process generation (e.g. the old
      // PTY's death arriving right after a restart respawned the id).
      const known = spawnSeqRef.current[e.payload.id];
      if (known != null && e.payload.seq !== known) return;
      setExited((prev) => ({ ...prev, [e.payload.id]: e.payload.code }));
      setContextUsage((prev) => {
        const next = { ...prev };
        delete next[e.payload.id];
        return next;
      });
    });
    const unlistenNotif = listen<NotificationPayload>(
      "terminal-notification",
      (e) => {
        if (!liveIdsRef.current.has(e.payload.id)) return;
        addNotification(e.payload);
      },
    );
    const unlistenCtx = listen<ContextPayload>("terminal-context", (e) => {
      if (!liveIdsRef.current.has(e.payload.id)) return;
      setContextUsage((prev) => ({ ...prev, [e.payload.id]: e.payload.used }));
    });
    const unlistenTitle = listen<TitlePayload>("terminal-title", (e) => {
      if (!liveIdsRef.current.has(e.payload.id)) return;
      setTitles((prev) => ({ ...prev, [e.payload.id]: e.payload.title }));
    });
    const refreshWorkspaces = createDebouncedTask(() => {
      void refresh();
    }, 75);
    const unlistenWs = listen("workspaces-changed", () => {
      // Layout drags and group updates can emit several events in one turn;
      // rearming a short debounce keeps secondary windows current without
      // issuing a request per intermediate frame.
      refreshWorkspaces.schedule();
    });
    return () => {
      refreshWorkspaces.cancel();
      unlisten.then((u) => u());
      unlistenNotif.then((u) => u());
      unlistenCtx.then((u) => u());
      unlistenTitle.then((u) => u());
      unlistenWs.then((u) => u());
    };
  }, [refresh]);

  const active = workspaces.find((w) => w.id === activeId) ?? null;
  const showResume =
    showResumeQueue && resumeItems !== null && resumeItems.length > 0;
  const modalOpen =
    showNewWs ||
    showAgentPicker ||
    showSettings ||
    showResume ||
    renameTarget !== null ||
    workspaceToDelete !== null ||
    showNewGroup ||
    pendingImportPath !== null;

  // Poll git branches for all workspace directories. Keyed off the id:cwd
  // signature so terminal spawns/resizes don't restart the interval.
  const wsCwdSig = workspaces.map((w) => `${w.id}:${w.cwd}`).join("|");
  useEffect(() => {
    const targets = workspaces.map((w) => ({ id: w.id, cwd: w.cwd }));
    let cancelled = false;
    const poll = async () => {
      const entries = await Promise.all(
        targets.map(
          async (t) =>
            [t.id, await api.gitBranch(t.cwd).catch(() => null)] as const,
        ),
      );
      if (cancelled) return;
      setBranches((prev) => {
        const next: Record<string, string> = {};
        for (const [id, b] of entries) if (b) next[id] = b;
        const keys = Object.keys(next);
        const same =
          keys.length === Object.keys(prev).length &&
          keys.every((k) => prev[k] === next[k]);
        return same ? prev : next;
      });
    };
    poll();
    const iv = setInterval(poll, BRANCH_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [wsCwdSig]);

  useEffect(() => {
    if (!activeId || !focusedId) return;
    const ws = workspaces.find((w) => w.id === activeId);
    if (ws?.terminals.some((t) => t.id === focusedId)) {
      lastFocusByWs.current[activeId] = focusedId;
    }
  }, [activeId, focusedId, workspaces]);

  useEffect(() => {
    if (prevActiveId.current === activeId) return;
    prevActiveId.current = activeId;
    if (!activeId) return;
    const ws = workspaces.find((w) => w.id === activeId);
    if (!ws) return;
    const saved = lastFocusByWs.current[activeId];
    setFocusedId((cur) => {
      if (cur && ws.terminals.some((t) => t.id === cur)) return cur;
      return saved && ws.terminals.some((t) => t.id === saved) ? saved : null;
    });
  }, [activeId, workspaces]);

  // Persist the selected pane whenever the workspace or focused tab changes.
  // The backend API currently stores the pane; including the focused terminal
  // in the dedupe key keeps the local active-tab projection in step without
  // issuing a request for every workspace refresh or terminal event.
  useEffect(() => {
    if (!activeId || !orchestrationSnapshot) return;
    const workspace = workspaces.find((candidate) => candidate.id === activeId);
    if (!workspace) return;
    const focused = focusedId
      ? workspace.terminals.find((terminal) => terminal.id === focusedId)
      : undefined;
    const snapshotTab = focusedId
      ? orchestrationSnapshot.tabs.find(
          (tab) => tab.ptyId === focusedId || tab.id === focused?.tabId,
        )
      : undefined;
    const project = orchestrationSnapshot.projects.find(
      (candidate) => candidate.id === activeId,
    );
    // A migrated legacy workspace may have a synthetic pane in the frontend
    // snapshot while the Rust store still has no pane metadata. Only persist
    // a selection when there is a focused terminal, and materialize that
    // terminal's placement before selecting a synthetic pane backend-side.
    if (!focused) return;
    const paneId = focused.paneId ?? snapshotTab?.paneId ?? project?.activePaneId ?? null;
    if (!paneId) return;
    const tabId = focused.tabId ?? snapshotTab?.id ?? `tab-${focused.id}`;
    const selectionKey = `${activeId}:${paneId ?? ""}:${focusedId ?? ""}`;
    if (persistedPaneSelectionRef.current === selectionKey) return;
    // Set the key before the async boundary: a failed IPC call should be
    // visible in logs but must not create a retry storm during refreshes.
    persistedPaneSelectionRef.current = selectionKey;
    const timer = window.setTimeout(() => {
      // setTerminalPlacement is also the backend's authoritative way to mark
      // the active tab inside a pane, so call it on a deduped focus change
      // even when the terminal already has placement metadata.
      api.setTerminalPlacement({
        workspaceId: activeId,
        terminalId: focused.id,
        paneId,
        tabId,
      })
        .then(() => api.setActivePane({ workspaceId: activeId, paneId }))
        .then(() => setActivePaneSnapshot(paneId))
        .catch((error) => {
          console.warn("failed to persist active pane/tab:", error);
        });
    }, 100);
    return () => window.clearTimeout(timer);
  }, [
    activeId,
    focusedId,
    workspaces,
    orchestrationSnapshot,
    setActivePaneSnapshot,
  ]);

  useEffect(() => {
    if (!focusedId || !activeId || modalOpen) return;
    const ae = document.activeElement as HTMLElement | null;
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "SELECT")) return;
    const raf = requestAnimationFrame(() => getTerminal(focusedId)?.focus());
    return () => cancelAnimationFrame(raf);
  }, [activeId, focusedId, modalOpen]);

  const spawnTerminalInto = async (
    wsId: string,
    command: string,
    placement?: { paneId: string; tabId?: string },
  ) => {
    // Spawn at an existing pane's size when possible: the PTY otherwise
    // starts at 80x24 and the child draws its first frame at the wrong size
    // before the pane's fit can correct it (worst on Windows/ConPTY).
    const sibling = workspaces
      .find((w) => w.id === wsId)
      ?.terminals.map((t) => getTerminal(t.id))
      .find((t) => t && t.cols > 0 && t.rows > 0);
    const res = await api.spawnTerminal(
      wsId,
      command,
      undefined,
      sibling?.cols,
      sibling?.rows,
      defaultShell || undefined,
    );
    await registerSpawnedTerminal(res);
    if (placement?.paneId) {
      await api
        .setTerminalPlacement({
          workspaceId: wsId,
          terminalId: res.meta.id,
          paneId: placement.paneId,
          tabId: placement.tabId ?? `tab-${res.meta.id}`,
        })
        .catch((err) => {
          console.error("failed to persist terminal placement:", err);
          pushSystemNotification("Terminal started, but its tab placement was not saved");
        });
    }
    setFocusedId(res.meta.id);
    await refresh();
  };

  const reportSpawnError = (err: unknown) => {
    console.error("failed to spawn terminal:", err);
    pushSystemNotification(`Failed to start terminal: ${String(err)}`);
  };

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
      spawnTerminalInto(wsId, defaultAgent, paneId ? { paneId } : undefined).catch(reportSpawnError);
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
      await spawnTerminalInto(
        target,
        agentId,
        targetPane ? { paneId: targetPane } : undefined,
      ).catch(reportSpawnError);
    }
  };

  const closeTerminal = async (id: string) => {
    liveIdsRef.current.delete(id);
    delete spawnSeqRef.current[id];
    await api.killTerminal(id).catch(() => {});
    clearTerminal(id);
    if (expandedId === id) setExpandedId(null);
    if (focusedId === id) {
      const ws = workspaces.find((w) => w.terminals.some((t) => t.id === id));
      const idx = ws ? ws.terminals.findIndex((t) => t.id === id) : -1;
      const next = ws?.terminals[idx - 1] ?? ws?.terminals[idx + 1] ?? null;
      setFocusedId(next ? next.id : null);
    }
    await refresh();
  };

  const restartTerminal = async (id: string, command: string) => {
    const ownerWorkspaceId = workspaceIdForTerminal(workspaces, orchestrationSnapshot, id);
    if (!ownerWorkspaceId) {
      console.warn(`cannot restart terminal ${id}: workspace owner is unknown`);
      return;
    }
    liveIdsRef.current.add(id);
    try {
      // Kill the old PTY first (store entry is kept so position/width are
      // preserved), then respawn. Spawning onto a live id would leak the old
      // process and double-emit output. Spawn at the xterm's current size:
      // it fitted to the pane long ago, so nothing would re-send the real
      // dimensions and the new PTY would stay stuck at the 80x24 default.
      const term = getTerminal(id);
      await api.stopTerminal(id);
      const res = await api.spawnTerminal(
        ownerWorkspaceId,
        command,
        id,
        term?.cols,
        term?.rows,
        defaultShell || undefined,
      );
      await registerSpawnedTerminal(res);
    } catch (err) {
      console.error(`failed to restart terminal ${id}:`, err);
      setExited((prev) => ({ ...prev, [id]: null }));
      await refresh();
      return;
    }
    clearTerminal(id);
    await refresh();
  };

  const spawnResumed = async (item: ResumeItem) => {
    try {
      // Respawn onto the persisted id so position/width are kept; the store
      // entry's command is updated to the resume variant backend-side. Spawn
      // at the xterm's current size: the pane mounted (and fitted) while the
      // old process was dead, so no resize would be sent after the respawn
      // and the PTY would stay at the 80x24 default under a full-width pane.
      const term = getTerminal(item.terminalId);
      const res = await api.spawnTerminal(
        item.wsId,
        item.resumeCommand,
        item.terminalId,
        term?.cols,
        term?.rows,
        defaultShell || undefined,
      );
      await registerSpawnedTerminal(res);
    } catch (err) {
      console.error(`failed to resume terminal ${item.terminalId}:`, err);
      setExited((prev) => ({ ...prev, [item.terminalId]: null }));
      throw err;
    }
  };

  const resumeItemsWithQueue = async (items: readonly ResumeItem[]) => {
    const queue = createSpawnQueue<ResumeItem, void>({
      concurrency: 2,
      run: (item) => spawnResumed(item),
    });
    const pending = items.map((item) =>
      queue.enqueue({ id: item.terminalId, input: item }),
    );
    await queue.whenIdle();
    return Promise.all(pending);
  };

  const notifyResumeFailures = (
    results: ReadonlyArray<Awaited<ReturnType<typeof resumeItemsWithQueue>>[number]>,
    labels: ReadonlyMap<string, string>,
  ) => {
    for (const result of results) {
      if (result.status === "succeeded") continue;
      const detail =
        result.error instanceof Error
          ? result.error.message
          : String(result.error ?? result.status);
      const label = labels.get(result.id) ?? result.id;
      pushSystemNotification(`Failed to resume ${label}: ${detail}`);
    }
  };

  const resumeOne = async (item: ResumeItem) => {
    if (resumeQueueMutationRef.current || resumingTerminalIdsRef.current.has(item.terminalId)) return;
    resumeQueueMutationRef.current = true;
    resumingTerminalIdsRef.current.add(item.terminalId);
    try {
      await spawnResumed(item);
      dropResumeItem(item.terminalId);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      pushSystemNotification(`Failed to resume ${item.wsName}: ${detail}`);
    } finally {
      resumingTerminalIdsRef.current.delete(item.terminalId);
      resumeQueueMutationRef.current = false;
    }
    await refresh();
  };

  const dismissOne = async (item: ResumeItem) => {
    if (resumeQueueMutationRef.current) return;
    resumeQueueMutationRef.current = true;
    try {
      // Only clear local ownership after the backend confirms deletion. A
      // rejected kill must leave the item retryable and the runtime refs intact.
      const [result] = await dismissResumeItems([item], (candidate) => api.killTerminal(candidate.terminalId));
      if (result?.status === "failed") {
        const detail = result.error instanceof Error ? result.error.message : String(result.error);
        console.error(`failed to dismiss resume item ${item.terminalId}:`, result.error);
        pushSystemNotification(
          `Não foi possível descartar ${item.wsName}. A sessão permanece na fila; tente novamente. ${detail}`,
        );
        return;
      }
      liveIdsRef.current.delete(item.terminalId);
      delete spawnSeqRef.current[item.terminalId];
      dropResumeItem(item.terminalId);
      await refresh();
    } finally {
      resumeQueueMutationRef.current = false;
    }
  };

  const resumeAll = async () => {
    const items = resumeItems ?? [];
    if (items.length === 0 || resumeQueueMutationRef.current) return;
    resumeQueueMutationRef.current = true;
    try {
      // Close the modal while the bounded queue owns these stable terminal IDs;
      // failed items are put back below for an explicit retry.
      setResumeItems(null);
      const results = await resumeItemsWithQueue(items);
      const labels = new Map(items.map((item) => [item.terminalId, item.wsName]));
      notifyResumeFailures(results, labels);
      const failed = new Set(
        results
          .filter((result) => result.status !== "succeeded")
          .map((result) => result.id),
      );
      setResumeItems(failed.size > 0 ? items.filter((item) => failed.has(item.terminalId)) : null);
      await refresh();
    } finally {
      resumeQueueMutationRef.current = false;
    }
  };

  // "Always resume without asking": run the queue once it is loaded.
  useEffect(() => {
    if (!autoResumePending || !resumeItems || resumeItems.length === 0) return;
    setAutoResumePending(false);
    void resumeAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoResumePending, resumeItems]);

  const dismissAll = async () => {
    const items = resumeItems ?? [];
    if (items.length === 0 || resumeQueueMutationRef.current) return;
    resumeQueueMutationRef.current = true;
    try {
      const results = await dismissResumeItems(items, (item) => api.killTerminal(item.terminalId));
      const failed: ResumeItem[] = [];
      for (const result of results) {
        if (result.status === "failed") {
          failed.push(result.item);
          const detail = result.error instanceof Error ? result.error.message : String(result.error);
          console.error(`failed to dismiss resume item ${result.item.terminalId}:`, result.error);
          pushSystemNotification(
            `Não foi possível descartar ${result.item.wsName}. A sessão permanece na fila; tente novamente. ${detail}`,
          );
          continue;
        }
        liveIdsRef.current.delete(result.item.terminalId);
        delete spawnSeqRef.current[result.item.terminalId];
      }
      setResumeItems(failed.length > 0 ? failed : null);
      await refresh();
    } finally {
      resumeQueueMutationRef.current = false;
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
    if (!nextName) return;
    setRenameTarget(null);
    if (target.kind === "workspace") {
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
    setActiveId(id);
    setExpandedId(null);
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
    await api.createGroup(name).then(() => refresh()).catch((err) => {
      console.error("failed to create group:", err);
    });
  };

  const renameGroup = async (id: string, name: string) => {
    await api.renameGroup(id, name).then(() => refresh()).catch((err) => {
      console.error(`failed to rename group ${id}:`, err);
    });
  };

  const groupWorkspaceIds = (groupId: string): string[] => {
    const group = groups.find((candidate) => candidate.id === groupId);
    const fromGroup = group?.projectIds ?? [];
    const fromWorkspaces = workspaces
      .filter((workspace) => workspace.groupId === groupId)
      .map((workspace) => workspace.id);
    return [...new Set([...fromGroup, ...fromWorkspaces])];
  };

  const terminalEntriesForGroup = (groupId: string) =>
    groupWorkspaceIds(groupId).flatMap((workspaceId) => {
      const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
      return (workspace?.terminals ?? []).map((terminal) => ({ workspace, terminal }));
    }).filter((entry): entry is { workspace: Workspace; terminal: Workspace["terminals"][number] } => Boolean(entry.workspace));

  const suspendGroup = async (groupId: string) => {
    const entries = terminalEntriesForGroup(groupId);
    try {
      // The backend owns the group lifecycle now: it marks metadata first and
      // then stops every PTY without deleting scrollback or terminal records.
      await api.suspendGroup(groupId);
    } catch (err) {
      console.error(`failed to suspend group ${groupId}:`, err);
      return;
    }
    setGroupSuspended(groupId, true);
    const suspendedIds = new Set(entries.map(({ terminal }) => terminal.id));
    setWorkspaces((previous) => previous.map((workspace) => ({
      ...workspace,
      terminals: workspace.terminals.map((terminal) =>
        suspendedIds.has(terminal.id) ? { ...terminal, suspended: true } : terminal,
      ),
    })));
    await refresh();
  };

  const resumeGroup = async (groupId: string) => {
    const group = groups.find((candidate) => candidate.id === groupId);
    const groupName = group?.name ?? groupId;
    const entries = terminalEntriesForGroup(groupId);
    const candidates = entries.map(({ workspace, terminal }) => ({
      terminalId: terminal.id,
      projectId: workspace.id,
      projectName: workspace.name,
      groupId,
      groupName,
      cwd: workspace.cwd,
      command: terminal.command,
      resumeCommand: resumeCommandFor(terminal.command),
    }));
    const plan = planResume(candidates);
    const resumeItems: ResumeItem[] = plan.items.map((candidate) => ({
      terminalId: candidate.terminalId,
      wsId: candidate.projectId,
      wsName: candidate.projectName,
      cwd: candidate.cwd ?? "",
      command: candidate.command ?? "shell",
      agentId: candidate.agentId ?? candidate.command?.trim().split(/\s+/)[0] ?? "shell",
      resumeCommand: candidate.resumeCommand ?? candidate.command ?? "shell",
    }));
    const results = await resumeItemsWithQueue(resumeItems);
    const labels = new Map(resumeItems.map((item) => [item.terminalId, groupName]));
    notifyResumeFailures(results, labels);
    const failed = results.filter((result) => result.status !== "succeeded");
    if (failed.length > 0) {
      // Restore the group-wide suspended invariant. Successful spawns are
      // stopped again so a retry never leaves a half-active group behind.
      await api.suspendGroup(groupId).catch((err) => {
        console.error(`failed to restore suspended group ${groupId}:`, err);
      });
      setGroupSuspended(groupId, true);
      pushSystemNotification(
        `${failed.length} agent${failed.length === 1 ? "" : "s"} in ${groupName} could not be resumed; the group remains suspended`,
      );
      await refresh();
      return;
    }
    try {
      await api.resumeGroup(groupId);
      setGroupSuspended(groupId, false);
    } catch (err) {
      console.error(`failed to resume group ${groupId}:`, err);
      await api.suspendGroup(groupId).catch((restoreError) => {
        console.error(`failed to restore suspended group ${groupId}:`, restoreError);
      });
      setGroupSuspended(groupId, true);
      pushSystemNotification(`Could not activate group ${groupName}`);
    }
    await refresh();
  };

  const resolveVoiceTerminal = (target: string) => {
    const needle = normalizeVoiceLookup(target);
    if (!needle) return null;
    const labels = buildAgentLabels(workspaces, { titles });
    for (const workspace of workspaces) {
      const terminal = workspace.terminals.find((candidate) => {
        const title = titles[candidate.id] ?? "";
        const command = candidate.command.trim();
        const label = labels[candidate.id];
        // Exact: id, raw title, command, kind, numbered tag ("claude 2"),
        // task title or given name.
        return [candidate.id, title, command, command.split(/\s+/)[0] ?? "", label?.tag ?? "", label?.title ?? "", label?.name ?? ""]
          .some((value) => value && normalizeVoiceLookup(value) === needle);
      });
      if (terminal) return { workspace, terminal };
    }
    // Loose: the spoken words appear in the task title ("o claude das animações").
    for (const workspace of workspaces) {
      const terminal = workspace.terminals.find((candidate) => {
        const title = labels[candidate.id]?.title;
        return title ? normalizeVoiceLookup(title).includes(needle) || needle.includes(normalizeVoiceLookup(title)) : false;
      });
      if (terminal) return { workspace, terminal };
    }
    const workspace = workspaces.find(
      (candidate) =>
        normalizeVoiceLookup(candidate.id) === needle ||
        normalizeVoiceLookup(candidate.name) === needle,
    );
    const terminal = workspace?.terminals[0];
    return workspace && terminal ? { workspace, terminal } : null;
  };

  const focusVoiceTarget = (target: string): boolean => {
    const match = resolveVoiceTerminal(target);
    if (!match) return false;
    reattachTerminal(match.terminal.id);
    selectWorkspace(match.workspace.id);
    setFocusedId(match.terminal.id);
    return true;
  };

  const targetLabelForVoiceIntent = (intent: VoiceCapsuleIntent | null): string | null => {
    if (!intent) return focusedId ? titles[focusedId] ?? focusedId : null;
    switch (intent.type) {
      case "focus":
      case "stop":
        return intent.target ?? null;
      case "suspend-group":
      case "resume-group":
        return intent.group;
      case "new-agent":
        return intent.agent ?? "Agente padrão";
      case "open-fleet":
        return "Frota Terra";
    }
  };

  const resolveVoiceGroup = (target: string): string | null => {
    const needle = normalizeVoiceLookup(target);
    return groups.find(
      (group) =>
        normalizeVoiceLookup(group.id) === needle ||
        normalizeVoiceLookup(group.name) === needle,
    )?.id ?? null;
  };

  const startVoiceAgent = async (agentTarget?: string) => {
    if (!active) {
      pushSystemNotification("Select a workspace before starting an agent");
      return;
    }
    if (!agentTarget) {
      await quickNewTerminal(active.id);
      return;
    }
    const needle = normalizeVoiceLookup(agentTarget);
    const agent = agents.find(
      (candidate) =>
        candidate.available &&
        (normalizeVoiceLookup(candidate.id) === needle ||
          normalizeVoiceLookup(candidate.label) === needle),
    );
    if (!agent) {
      pushSystemNotification(`Agent not available: ${agentTarget}`);
      return;
    }
    await spawnTerminalInto(active.id, agent.id);
  };

  const executeVoiceIntent = async (
    intent: VoiceCapsuleIntent,
    confirmed = false,
  ): Promise<boolean> => {
    if (!canExecuteVoiceIntent(intent, confirmed)) {
      setVoiceFeedback("Confirme a ação destrutiva na cápsula para continuar.");
      return false;
    }
    try {
      switch (intent.type) {
        case "open-fleet":
          useShellStore.getState().navigate("fleet");
          setVoiceFeedback("Frota aberta.");
          return true;
        case "focus":
          if (!focusVoiceTarget(intent.target)) {
            pushSystemNotification(`Terminal não encontrado: ${intent.target}`);
            setVoiceFeedback(`Não encontrei o terminal ${intent.target}.`);
            return false;
          }
          setVoiceFeedback(`Foco alterado para ${intent.target}.`);
          return true;
        case "suspend-group": {
          const groupId = resolveVoiceGroup(intent.group);
          if (!groupId) {
            pushSystemNotification(`Grupo não encontrado: ${intent.group}`);
            setVoiceFeedback(`Não encontrei o grupo ${intent.group}.`);
            return false;
          }
          await suspendGroup(groupId);
          setVoiceFeedback(`Grupo ${intent.group} suspenso.`);
          return true;
        }
        case "resume-group": {
          const groupId = resolveVoiceGroup(intent.group);
          if (!groupId) {
            pushSystemNotification(`Grupo não encontrado: ${intent.group}`);
            setVoiceFeedback(`Não encontrei o grupo ${intent.group}.`);
            return false;
          }
          await resumeGroup(groupId);
          setVoiceFeedback(`Grupo ${intent.group} retomado.`);
          return true;
        }
        case "new-agent":
          await startVoiceAgent(intent.agent);
          setVoiceFeedback(intent.agent ? `Agente ${intent.agent} iniciado.` : "Novo agente preparado.");
          return true;
        case "stop": {
          const match = intent.target ? resolveVoiceTerminal(intent.target) : null;
          if (!match) {
            setVoiceFeedback(intent.target ? `Não encontrei o terminal ${intent.target}.` : "Informe qual terminal deve parar.");
            return false;
          }
          await closeTerminal(match.terminal.id);
          setVoiceFeedback(`Terminal ${intent.target} parado.`);
          return true;
        }
      }
    } catch (err) {
      console.error("voice orchestration command failed:", err);
      setVoiceFeedback("Não foi possível executar a ação de voz.");
      pushSystemNotification("Falha ao executar a ação de voz");
      return false;
    }
  };

  const stopFleetTerminals = async (ids: string[]) => {
    try {
      await Promise.all(ids.map((id) => api.stopTerminal(id)));
      await refresh();
    } catch (err) {
      console.error("failed to stop fleet terminals:", err);
      pushSystemNotification("Could not stop all selected agents");
      await refresh();
    }
  };

  const resumeFleetTerminals = async (ids: string[]) => {
    const entries = ids.flatMap((id) => {
      for (const workspace of workspaces) {
        const terminal = workspace.terminals.find((candidate) => candidate.id === id);
        if (terminal) return [{ workspace, terminal }];
      }
      return [];
    });
    const queue = createSpawnQueue<(typeof entries)[number], void>({
      concurrency: 2,
      run: async ({ workspace, terminal }) => {
        const term = getTerminal(terminal.id);
        const result = await api.spawnTerminal(
          workspace.id,
          resolveResumeCommand(profileForCommand(terminal.command), terminal.command),
          terminal.id,
          term?.cols,
          term?.rows,
          defaultShell || undefined,
        );
        await registerSpawnedTerminal(result);
      },
    });
    const pending = entries.map(({ workspace, terminal }) =>
      queue.enqueue({
        id: terminal.id,
        input: { workspace, terminal },
      }),
    );
    await queue.whenIdle();
    const results = await Promise.all(pending);
    for (const result of results) {
      if (result.status === "succeeded") continue;
      const detail =
        result.error instanceof Error
          ? result.error.message
          : String(result.error ?? result.status);
      pushSystemNotification(`Failed to resume fleet agent ${result.id}: ${detail}`);
    }
    await refresh();
  };

  /** Detaching is visual-only and durable; the PTY remains alive for re-open. */
  const detachTab = (id: string) => {
    setTerminalDetached(id, true);
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

  const exportWorkspaceSnapshot = async () => {
    if (snapshotOperation) return;
    setSnapshotOperation("exporting");
    try {
      const path = await saveDialog({
        title: "Export Terra Swarm snapshot",
        defaultPath: "terra-swarm-snapshot.json",
        filters: [{ name: "Terra Swarm snapshot", extensions: ["json"] }],
      });
      // Tauri returns null when the native picker is cancelled. Keep that a
      // true no-op: no IPC call and no replacement of the current feedback.
      if (typeof path !== "string" || !path.trim()) return;
      setSnapshotFeedback(null);
      const transfer = await api.exportWorkspaceSnapshot(path);
      setSnapshotFeedback({
        kind: "success",
        message: `Snapshot exportado (${transfer.workspaceCount} workspace${transfer.workspaceCount === 1 ? "" : "s"}, ${transfer.terminalCount} terminal${transfer.terminalCount === 1 ? "" : "s"}).`,
        backupPath: transfer.path,
      });
    } catch (error) {
      console.error("workspace snapshot export failed:", error);
      setSnapshotFeedback({
        kind: "error",
        message: describeSnapshotError(error),
      });
    } finally {
      setSnapshotOperation(null);
    }
  };

  const performImportWorkspaceSnapshot = async (path: string) => {
    if (snapshotOperation || !path.trim()) return;
    setPendingImportPath(null);
    setSnapshotOperation("importing");
    try {
      setSnapshotFeedback(null);
      const transfer = await api.importWorkspaceSnapshot(path);

      // Import is metadata-only and the backend stops every PTY before the
      // store is replaced. Drop stale runtime references without respawning
      // imported sessions implicitly; the user can resume them explicitly.
      const previousTerminalIds = [...liveIdsRef.current];
      liveIdsRef.current.clear();
      spawnSeqRef.current = {};
      clearTerminals(previousTerminalIds);
      clearAllNotifications();
      setExited({});
      setContextUsage({});
      setTitles({});
      setResumeItems(null);
      setResumeSavedAt(null);
      setExpandedId(null);
      setFocusedId(null);
      await refresh();

      setSnapshotFeedback({
        kind: "success",
        message: `Snapshot importado (${transfer.workspaceCount} workspace${transfer.workspaceCount === 1 ? "" : "s"}, ${transfer.suspendedTerminalCount} terminal${transfer.suspendedTerminalCount === 1 ? "" : "s"} suspenso${transfer.suspendedTerminalCount === 1 ? "" : "s"}).`,
        backupPath: transfer.backupPath,
      });
    } catch (error) {
      console.error("workspace snapshot import failed:", error);
      setSnapshotFeedback({
        kind: "error",
        message: describeSnapshotError(error),
      });
    } finally {
      setSnapshotOperation(null);
    }
  };

  const importWorkspaceSnapshot = async () => {
    if (snapshotOperation || pendingImportPath) return;
    try {
      const path = await openDialog({
        title: "Importar snapshot do Terra Swarm",
        multiple: false,
        directory: false,
        filters: [{ name: "Snapshot Terra Swarm", extensions: ["json"] }],
      });
      // Tauri returns null when the native picker is cancelled. Do not ask
      // for confirmation or mutate anything when no file was selected.
      if (typeof path !== "string" || !path.trim()) return;
      setPendingImportPath(path);
    } catch (error) {
      console.error("workspace snapshot picker failed:", error);
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
      pushSystemNotification(`Não foi possível excluir o projeto: ${String(err)}`);
      return false;
    }
    for (const t of terms) {
      liveIdsRef.current.delete(t.id);
      delete spawnSeqRef.current[t.id];
    }
    delete lastFocusByWs.current[id];
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

  const refreshVoiceModels = useCallback(() => {
    api.voiceListModels().then(setVoiceModels).catch(() => {});
  }, []);

  const refreshVoiceInputDevices = useCallback(() => {
    api.voiceListInputDevices().then(setVoiceInputDevices).catch(() => {});
  }, []);

  const toggleVoice = useCallback(() => {
    if (!voiceEnabled) {
      setSettingsSection("voice");
      setShowSettings(true);
      return;
    }
    api
      .voiceToggleRecording()
      .catch((err) => console.error("voice toggle failed:", err));
  }, [voiceEnabled]);

  const handleUpdateAvailable = useCallback((version: string, current: string) => {
    setUpdateVersion(version);
    notifyUpdateAvailable(version, current);
  }, [notifyUpdateAvailable]);

  const runUpdateCheck = useCallback(() => {
    void checkForUpdate()
      .then((result) => {
        if (result.kind === "update") {
          handleUpdateAvailable(result.version, result.current);
        }
      })
      .catch((error) => {
        console.warn("update check failed:", error);
      });
  }, [handleUpdateAvailable]);

  useEffect(() => {
    runUpdateCheck();
    const interval = window.setInterval(runUpdateCheck, UPDATE_CHECK_MS);
    return () => window.clearInterval(interval);
  }, [runUpdateCheck]);

  const manualUpdateCheck = () => {
    setUpdateCheckState("checking");
    checkForUpdate().then((result) => {
      if (result.kind === "update") {
        handleUpdateAvailable(result.version, result.current);
        setUpdateCheckState("idle");
      } else {
        setUpdateCheckState(result.kind === "none" ? "uptodate" : "error");
      }
    });
  };

  const installUpdate = () => {
    if (updateInstalling) return;
    setUpdateInstalling(true);
    installPendingUpdate().catch((err) => {
      console.error("update install failed:", err);
      setUpdateInstalling(false);
      pushSystemNotification("Update failed to install — try again later");
    });
  };

  const handleVoiceModelLoadError = (err: unknown) => {
    console.error("voice model load failed:", err);
    setVoiceModel(null);
    refreshVoiceModels();
    pushSystemNotification("Voice model failed to load — select it again");
  };

  const disableVoiceInput = (notify: boolean) => {
    setVoiceEnabled(false);
    if (notify) {
      pushSystemNotification("Microphone disconnected — voice input disabled");
    }
  };

  const updateVoiceEnabled = (on: boolean) => {
    if (!on) {
      setVoiceEnabled(false);
      return;
    }
    // Never enable without a microphone connected
    api
      .voiceMicAvailable()
      .then((avail) => {
        setMicAvailable(avail);
        if (!avail) return;
        setVoiceEnabled(true);
        api.voiceSetLanguage(voiceLang).catch(() => {});
        api.voiceSetInputDevice(voiceInputDevice).catch(() => {});
        if (voiceModel) {
          api.voiceSetModel(voiceModel).catch(handleVoiceModelLoadError);
        }
        refreshVoiceModels();
        refreshVoiceInputDevices();
      })
      .catch(() => {});
  };

  const updateVoiceLang = (lang: string) => {
    setVoiceLang(lang);
    api.voiceSetLanguage(lang).catch(() => {});
  };

  const updateVoiceInputDevice = (device: string) => {
    const value = device === "" ? null : device;
    setVoiceInputDevice(value);
    api.voiceSetInputDevice(value).catch(() => {});
    // Switch the live test stream to the newly picked device so the meter
    // reflects whatever is actually selected.
    if (micTesting) {
      api.voiceTestMicStart(value).catch(() => {});
    }
  };

  const stopMicTest = useCallback(() => {
    setMicTesting(false);
    api.voiceTestMicStop().catch(() => {});
  }, []);

  const toggleMicTest = () => {
    if (micTesting) {
      stopMicTest();
      return;
    }
    api
      .voiceTestMicStart(voiceInputDevice)
      .then(() => setMicTesting(true))
      .catch((err) => {
        console.error("mic test failed:", err);
        const detail = typeof err === "string" ? err : "Could not start microphone test";
        pushSystemNotification(detail);
      });
  };

  const selectVoiceModel = (id: string) => {
    api.voiceSetModel(id).catch(handleVoiceModelLoadError);
  };

  const downloadVoiceModel = (id: string) => {
    setVoiceDl({ id, percent: 0 });
    api.voiceDownloadModel(id).catch((err) => {
      setVoiceDl(null);
      console.error("voice model download failed:", err);
    });
  };

  // Latest focused terminal for the voice paste target, readable from
  // listeners that are registered once.
  const voiceFocusRef = useRef<string | null>(null);
  // "Enviar para": an explicit voice target wins over the focused terminal.
  const [voiceTargetId, setVoiceTargetId] = useState<string | null>(null);
  voiceFocusRef.current = voiceTargetId ?? focusedId;
  const exitedRef = useRef(exited);
  exitedRef.current = exited;

  // Writes dictated text to a terminal. An exited target is first resumed
  // with its agent's continuation command, then receives the prompt.
  const deliverDictation = async (id: string, text: string): Promise<void> => {
    const meta = workspaces.flatMap((workspace) => workspace.terminals).find((candidate) => candidate.id === id);
    if (meta && id in exitedRef.current) {
      setVoiceFeedback("Retomando o agente para enviar o ditado…");
      await restartTerminal(id, resolveResumeCommand(profileForCommand(meta.command), meta.command));
      // Give the agent's CLI a moment to draw its prompt before pasting.
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    const term = getTerminal(id);
    if (!term) {
      setVoiceFeedback("O terminal escolhido não está disponível.");
      return;
    }
    const prompt = voiceCommandsEnabledRef.current && meta
      ? buildVoicePrompt(profileForCommand(meta.command), text)
      : text;
    const data = term.modes.bracketedPasteMode
      ? `\u001b[200~${prompt}\u001b[201~`
      : prompt;
    try {
      await api.writeTerminal(id, data);
      term.focus();
      setVoiceSubmitted(true);
      setVoiceFeedback("Ditado enviado.");
    } catch (error) {
      console.error("voice dictation write failed:", error);
      dispatchVoiceCapsule({ type: "fail", message: "Não foi possível enviar o ditado ao terminal." });
      setVoiceFeedback("Não foi possível enviar o ditado ao terminal.");
    }
  };
  const deliverDictationRef = useRef(deliverDictation);
  deliverDictationRef.current = deliverDictation;

  // A chosen target lasts for one capture; the next one starts at the focus.
  useEffect(() => {
    if (voiceCapsule.state === "idle") setVoiceTargetId(null);
  }, [voiceCapsule.state]);
  const voiceEnabledRef = useRef(voiceEnabled);
  voiceEnabledRef.current = voiceEnabled;
  const voiceCommandsEnabledRef = useRef(flags.voiceCommands);
  voiceCommandsEnabledRef.current = flags.voiceCommands;

  const isVoiceModelError = (message: unknown): boolean => {
    const text = String(message ?? "").toLocaleLowerCase("pt-BR");
    return text.includes("model") || text.includes("modelo") || text.includes("whisper");
  };

  // Voice backend events. Parsed intents stop at the capsule preview; they
  // are executed only by the explicit Send/Confirm action below. Everything
  // else becomes a profile-aware prompt; transcript text is never interpreted
  // as a shell command.
  useEffect(() => {
    const unRecStart = listen("voice-recording-started", () => {
      setVoiceStatus("recording");
      setVoiceFeedback(null);
      setVoiceSubmitted(false);
      setVoiceLevel(0);
      setVoiceSamples([]);
      dispatchVoiceCapsule({ type: "start-listening" });
    });
    const unRecStop = listen("voice-recording-stopped", () => {
      setVoiceStatus("transcribing");
      dispatchVoiceCapsule({ type: "stop-listening" });
    });
    const unAudioLevel = listen<number>("voice-audio-level", (e) => {
      const level = Math.max(0, Math.min(1, Number(e.payload) || 0));
      setVoiceLevel(level);
      setVoiceSamples((previous) => [...previous.slice(-31), level]);
    });
    const unTrStart = listen("voice-transcription-started", () => {
      setVoiceStatus("transcribing");
      dispatchVoiceCapsule({ type: "begin-transcription" });
    });
    const unTrDone = listen<string>("voice-transcription-complete", (e) => {
      setVoiceStatus("idle");
      const text = e.payload.trim();
      if (!text) {
        dispatchVoiceCapsule({ type: "transcription-ready", transcript: "", intent: null });
        setVoiceFeedback("Não ouvi uma transcrição. Tente novamente.");
        return;
      }
      if (voiceCommandsEnabledRef.current) {
        const intent = parseVoiceCommand(text);
        if (intent) {
          dispatchVoiceCapsule({ type: "transcription-ready", transcript: text, intent });
          setVoiceSubmitted(false);
          setVoiceFeedback(isDestructiveVoiceIntent(intent)
            ? "Revise o alvo e confirme a ação para executar."
            : "Revise a intenção e envie quando estiver pronto.");
          return;
        }
      }

      // Ordinary dictation keeps the useful legacy behavior: it is pasted
      // into the focused terminal as text and never evaluated by the voice
      // layer. The transcript remains visible after the send.
      dispatchVoiceCapsule({ type: "transcription-ready", transcript: text, intent: null });
      setVoiceSubmitted(false);
      const id = voiceFocusRef.current;
      if (!id) {
        setVoiceFeedback("Transcrição pronta; selecione um terminal para enviar o ditado.");
        return;
      }
      void deliverDictationRef.current(id, text);
    });
    const unTrErr = listen<string>("voice-transcription-error", (e) => {
      setVoiceStatus("idle");
      dispatchVoiceCapsule({ type: "fail", message: e.payload || "Falha na transcrição." });
      setVoiceFeedback(e.payload || "Falha na transcrição.");
      console.error("voice transcription error:", e.payload);
      if (isVoiceModelError(e.payload)) {
        setSettingsSection("voice");
        setShowSettings(true);
      }
    });
    const unRecErr = listen<string>("voice-recording-error", (e) => {
      setVoiceStatus("idle");
      dispatchVoiceCapsule({ type: "fail", message: e.payload || "Falha ao capturar o microfone." });
      setVoiceFeedback(e.payload || "Falha ao capturar o microfone.");
      console.error("voice recording error:", e.payload);
      if (isVoiceModelError(e.payload)) {
        setSettingsSection("voice");
        setShowSettings(true);
      }
    });
    const unDlProg = listen<VoiceDownloadProgress>(
      "voice-model-download-progress",
      (e) => setVoiceDl({ id: e.payload.model_id, percent: e.payload.percent }),
    );
    const unDlDone = listen("voice-model-download-complete", () => {
      setVoiceDl(null);
      refreshVoiceModels();
    });
    const unModelChanged = listen<string>("voice-model-changed", (e) => {
      setVoiceModel(e.payload);
      refreshVoiceModels();
    });
    const unMicChanged = listen<boolean>("voice-mic-changed", (e) => {
      setMicAvailable(e.payload);
      refreshVoiceInputDevices();
      if (!e.payload && voiceEnabledRef.current) disableVoiceInput(true);
    });
    return () => {
      unRecStart.then((u) => u());
      unRecStop.then((u) => u());
      unAudioLevel.then((u) => u());
      unTrStart.then((u) => u());
      unTrDone.then((u) => u());
      unTrErr.then((u) => u());
      unRecErr.then((u) => u());
      unDlProg.then((u) => u());
      unDlDone.then((u) => u());
      unModelChanged.then((u) => u());
      unMicChanged.then((u) => u());
    };
  }, [refreshVoiceModels, refreshVoiceInputDevices, workspaces]);

  // Refresh mic presence and the model list whenever the settings page opens
  useEffect(() => {
    if (!showSettings) return;
    api
      .voiceMicAvailable()
      .then(setMicAvailable)
      .catch(() => {});
    if (voiceEnabled) {
      refreshVoiceModels();
      refreshVoiceInputDevices();
    }
    api
      .listShells()
      .then(setAvailableShells)
      .catch(() => {});
  }, [showSettings, voiceEnabled, refreshVoiceModels, refreshVoiceInputDevices]);

  // A live test stream must not outlive the settings page or the voice tab —
  // otherwise the mic stays open and blocks real recording from starting.
  useEffect(() => {
    if (showSettings && settingsSection === "voice") return;
    if (micTesting) stopMicTest();
  }, [showSettings, settingsSection, micTesting, stopMicTest]);

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

  // Latest-values ref so the global hotkey listener can be registered once
  // instead of being torn down and re-added on every render.
  const hotkeyCtx = useRef({
    modalOpen,
    capturing,
    hotkeys,
    active,
    focusedId,
    workspaces,
  });
  hotkeyCtx.current = {
    modalOpen,
    capturing,
    hotkeys,
    active,
    focusedId,
    workspaces,
  };
  const hotkeyActions = useRef({
    closeWorkspace,
    quickNewTerminal,
    closeTerminal,
    changeFontSize,
    resetFontSize,
    toggleVoice,
  });
  hotkeyActions.current = {
    closeWorkspace,
    quickNewTerminal,
    closeTerminal,
    changeFontSize,
    resetFontSize,
    toggleVoice,
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const { modalOpen, capturing, hotkeys, active, focusedId, workspaces } =
        hotkeyCtx.current;
      const actions = hotkeyActions.current;
      if (modalOpen || capturing) return;
      const target = e.target as HTMLElement | null;
      if (
        target?.closest("input, select") ||
        target?.closest("textarea:not(.xterm-helper-textarea)")
      )
        return;
      for (const [action, hk] of Object.entries(hotkeys)) {
        if (!matchHotkey(e, hk)) continue;
        e.preventDefault();
        e.stopPropagation();
        switch (action) {
          case "newWorkspace":
            openWorkspaceCreator();
            break;
          case "renameWorkspace":
            if (active) {
              setRenameTarget({ kind: "workspace", id: active.id, value: active.name });
            }
            break;
          case "deleteWorkspace":
            if (active) actions.closeWorkspace(active.id);
            break;
          case "newTerminal":
            if (active) actions.quickNewTerminal(active.id);
            break;
          case "closeTerminal":
            if (focusedId) actions.closeTerminal(focusedId);
            break;
          case "maximizeTerminal": {
            const last = active?.terminals[active.terminals.length - 1];
            const target =
              focusedId && active?.terminals.some((t) => t.id === focusedId)
                ? focusedId
                : last?.id;
            if (target) {
              setExpandedId((prev) => (prev === target ? null : target));
            }
            break;
          }
          case "minimizeTerminal":
            setExpandedId(null);
            break;
          case "increaseFontSize":
            actions.changeFontSize(1);
            break;
          case "decreaseFontSize":
            actions.changeFontSize(-1);
            break;
          case "resetFontSize":
            actions.resetFontSize();
            break;
          case "toggleVoice":
            actions.toggleVoice();
            break;
          default: {
            const wsMatch = /^selectWorkspace([1-9])$/.exec(action);
            if (wsMatch) {
              const ws = workspaces[Number(wsMatch[1]) - 1];
              if (ws) {
                setActiveId(ws.id);
                setExpandedId(null);
              }
              break;
            }
            const termMatch = /^selectTerminal([1-9])$/.exec(action);
            if (termMatch) {
              const t = active?.terminals[Number(termMatch[1]) - 1];
              if (t) {
                setFocusedId(t.id);
                setExpandedId((cur) => (cur === t.id ? cur : null));
              }
            }
            break;
          }
        }
        return;
      }
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, []);

  useEffect(() => {
    if (!capturing) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturing(null);
        return;
      }
      if (["Meta", "Shift", "Control", "Alt"].includes(e.key)) return;
      const hk: Hotkey = {
        key: e.key,
        meta: e.metaKey,
        shift: e.shiftKey,
        ctrl: e.ctrlKey,
        alt: e.altKey,
      };
      if (!hk.meta && !hk.ctrl && !hk.alt) return;
      // Reject duplicates: dispatch stops at the first match, so a combo
      // already bound to another action would silently never fire.
      const conflict = HOTKEY_ACTIONS.find(
        (a) =>
          a.id !== capturing &&
          hotkeys[a.id] &&
          hotkeys[a.id].key === hk.key &&
          hotkeys[a.id].meta === hk.meta &&
          hotkeys[a.id].shift === hk.shift &&
          hotkeys[a.id].ctrl === hk.ctrl &&
          hotkeys[a.id].alt === hk.alt,
      );
      if (conflict) {
        pushSystemNotification(
          `Shortcut already assigned to "${conflict.label}"`,
        );
        setCapturing(null);
        return;
      }
      const next = { ...hotkeys, [capturing]: hk };
      setHotkeys(next);
      setCapturing(null);
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, [capturing, hotkeys]);

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
        await restartTerminal(terminal.id, terminal.command);
        return;
      case "stop":
        await closeTerminal(terminal.id);
        return;
      case "clear-scrollback":
        // Clear what the user sees, not only the cached runtime state.
        getTerminal(terminal.id)?.clear();
        clearTerminal(terminal.id);
        pushSystemNotification("Histórico visual limpo para o agente em foco");
        return;
      case "resume": {
        const term = getTerminal(terminal.id);
        const result = await api.spawnTerminal(
          workspace.id,
          resolveResumeCommand(profileForCommand(terminal.command), terminal.command),
          terminal.id,
          term?.cols,
          term?.rows,
          defaultShell || undefined,
        );
        await registerSpawnedTerminal(result);
        await refresh();
        return;
      }
    }
  };

  const startVoiceCapture = () => {
    if (!voiceEnabled) {
      toggleVoice();
      return;
    }
    api.voiceToggleRecording().catch((error) => {
      console.error("voice start failed:", error);
      setVoiceFeedback("Não foi possível iniciar a captura de voz.");
    });
  };

  const stopVoiceCapture = () => {
    if (voiceStatus !== "recording") return;
    api.voiceToggleRecording().catch((error) => {
      console.error("voice stop failed:", error);
      setVoiceFeedback("Não foi possível parar a captura de voz.");
    });
  };

  const cancelVoiceCapture = () => {
    if (voiceStatus === "recording") {
      api.voiceToggleRecording().catch(() => {});
    }
    dispatchVoiceCapsule({ type: "cancel" });
    setVoiceStatus("idle");
    setVoiceSubmitted(false);
    setVoiceFeedback(null);
    setVoiceLevel(0);
    setVoiceSamples([]);
  };

  const retryVoiceCapture = () => {
    if (!voiceEnabled) {
      toggleVoice();
      return;
    }
    dispatchVoiceCapsule({ type: "retry" });
    setVoiceSubmitted(false);
    setVoiceFeedback(null);
    api.voiceToggleRecording().catch((error) => {
      console.error("voice retry failed:", error);
      dispatchVoiceCapsule({ type: "fail", message: "Não foi possível iniciar uma nova captura." });
      setVoiceFeedback("Não foi possível iniciar uma nova captura.");
    });
  };

  const sendVoicePayload = async (payload: VoiceSendPayload, confirmed: boolean) => {
    if (payload.intent) {
      const success = await executeVoiceIntent(payload.intent, confirmed);
      if (success) setVoiceSubmitted(true);
      return;
    }

    // A transcript without a parsed intent is ordinary dictation. It can be
    // retried from the capsule if no terminal was focused when transcription
    // completed, but is always sent as text (never interpreted here).
    const id = voiceFocusRef.current;
    if (!id) {
      setVoiceFeedback("Selecione um terminal para enviar o ditado.");
      return;
    }
    await deliverDictation(id, payload.transcript);
  };

  return (
    <MotionConfig reducedMotion={reduceMotion ? "always" : "user"}>
      {initializationError ? (
        <div className="terra-initialization-error" role="alert" aria-live="assertive">
          <div>
            <strong>Falha ao carregar o Terra</strong>
            <span>{initializationError}</span>
          </div>
          <button type="button" onClick={startInitialization} disabled={initializationRunning}>
            {initializationRunning ? "Tentando novamente…" : "Tentar novamente"}
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
        onOpenResume={() => setShowResumeQueue(true)}
        detachedTerminalIds={detachedTerminalIds}
        fontSize={fontSize}
        voiceEnabled={voiceEnabled}
        voiceStatus={voiceStatus}
        voiceState={voiceCapsule.state}
        voiceTranscript={voiceCapsule.partialTranscript}
        voicePartialTranscript={voiceCapsule.partialTranscript}
        voiceFinalTranscript={voiceCapsule.finalTranscript}
        voiceIntent={voiceCapsule.intent}
        voiceTargetAgent={targetLabelForVoiceIntent(voiceCapsule.intent)}
        voiceTargetId={voiceTargetId ?? focusedId}
        onVoiceTargetChange={setVoiceTargetId}
        voiceLevel={voiceLevel}
        voiceSamples={voiceSamples}
        voiceError={voiceCapsule.error}
        voiceSubmitted={voiceSubmitted}
        voiceFeedback={voiceFeedback}
        onFocus={setFocusedId}
        onSelectWorkspace={selectWorkspace}
        onNewWorkspace={() => openWorkspaceCreator()}
        onNewAgent={(workspaceId, paneId, agentId) => {
          if (agentId) {
            void spawnTerminalInto(
              workspaceId,
              agentId,
              paneId ? { paneId } : undefined,
            ).catch(reportSpawnError);
            return;
          }
          void chooseAgentForPanel(workspaceId, paneId ?? null);
        }}
        onClearNotifications={clearNotifications}
        onMarkAllRead={markAllRead}
        onClearAll={clearAllNotifications}
        onJumpToNotification={jumpToNotification}
        onRestart={restartTerminal}
        onKill={closeTerminal}
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
          void resumeFleetTerminals(ids);
        }}
        onOpenSettings={() => {
          setSettingsSection("terminal");
          setShowSettings(true);
        }}
        onOpenVoiceSettings={() => {
          setSettingsSection("voice");
          setShowSettings(true);
        }}
        onToggleVoice={toggleVoice}
        onVoiceStartListening={startVoiceCapture}
        onVoiceStopListening={stopVoiceCapture}
        onVoiceCancel={cancelVoiceCapture}
        onVoiceRetry={retryVoiceCapture}
        onVoiceSend={(payload) => {
          void sendVoicePayload(payload, false);
        }}
        onVoiceConfirm={(payload) => {
          void sendVoicePayload(payload, true);
        }}
        onExportWorkspace={() => {
          void exportWorkspaceSnapshot();
        }}
        onImportWorkspace={() => {
          void importWorkspaceSnapshot();
        }}
        onFocusedAgentAction={(action, context) => {
          void handleFocusedAgentAction(action, context);
        }}
        />
      </Suspense>

      {showResume ? (
        <Suspense fallback={<AppLoadingSurface label="fila de retomada" />}>
          <LazyResumeDialog
            items={resumeItems}
            savedAt={resumeSavedAt}
            onResume={resumeOne}
            onDismiss={dismissOne}
            onResumeAll={resumeAll}
            onDismissAll={dismissAll}
            onDefer={() => setShowResumeQueue(false)}
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
        description="A importação substituirá os metadados atuais dos workspaces. Os terminais ativos serão interrompidos e os processos não serão incluídos no arquivo."
        onConfirm={() => pendingImportPath ? performImportWorkspaceSnapshot(pendingImportPath) : undefined}
        onOpenChange={(open) => {
          if (!open) setPendingImportPath(null);
        }}
        open={pendingImportPath !== null}
        title="Importar snapshot?"
        confirmLabel="Importar snapshot"
      />

      <ConfirmActionDialog
        description={(() => {
          const project = workspaceToDelete
            ? workspaces.find((workspace) => workspace.id === workspaceToDelete)
            : null;
          return project
            ? `Excluir o projeto “${project.name}” e encerrar seus agentes? Esta ação não pode ser desfeita.`
            : "Excluir este projeto e encerrar seus agentes? Esta ação não pode ser desfeita.";
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
        title="Excluir projeto?"
        confirmLabel="Excluir projeto"
      />

      {showSettings ? (
        <Suspense fallback={<AppLoadingSurface label="configurações" />}>
          <LazySettingsDialog
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
            title="Configurações"
            description="Preferências do workbench, agentes e ambiente local."
            renderSection={({ section }) => (
              <Suspense fallback={<AppLoadingSurface label="seção" />}>
                <LazySettingsSectionPanel
                  section={section}
                  agents={agents}
                  defaultAgent={defaultAgent}
                  onDefaultAgentChange={setDefaultAgent}
                  availableShells={availableShells}
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
                  onVoiceEnabledChange={updateVoiceEnabled}
                  voiceLang={voiceLang}
                  onVoiceLangChange={updateVoiceLang}
                  voiceInputDevice={voiceInputDevice}
                  voiceInputDevices={voiceInputDevices}
                  onVoiceInputDeviceChange={updateVoiceInputDevice}
                  micAvailable={micAvailable}
                  micTesting={micTesting}
                  onMicTestToggle={toggleMicTest}
                  voiceModels={voiceModels}
                  voiceDownload={voiceDl}
                  onVoiceModelSelect={selectVoiceModel}
                  onVoiceModelDownload={downloadVoiceModel}
                  hotkeys={hotkeys}
                  capturing={capturing}
                  onCaptureHotkey={setCapturing}
                  onResetHotkeys={() => {
                    resetHotkeys();
                    setCapturing(null);
                  }}
                  snapshotOperation={snapshotOperation}
                  snapshotFeedback={snapshotFeedback}
                  onExportSnapshot={() => {
                    void exportWorkspaceSnapshot();
                  }}
                  onImportSnapshot={() => {
                    void importWorkspaceSnapshot();
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
            footerSlot={
              <button
                type="button"
                className="settings-dialog-done"
                onClick={() => {
                  setShowSettings(false);
                  setCapturing(null);
                }}
              >
                Concluído
              </button>
            }
          />
        </Suspense>
      ) : null}
    </MotionConfig>
  );
}

export default App;
