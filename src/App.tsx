import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { MotionConfig } from "motion/react";
import { useShallow } from "zustand/react/shallow";
import { api } from "./api";
import { useBranchPolling } from "./app/useBranchPolling";
import { useFocusTracking } from "./app/useFocusTracking";
import { useAgentCatalog } from "./app/useAgentCatalog";
import { useAgentPicker } from "./app/useAgentPicker";
import { useAppInitialization } from "./app/useAppInitialization";
import { useGlobalHotkeys } from "./app/useGlobalHotkeys";
import { useGridLayout } from "./app/useGridLayout";
import { useGroupActions } from "./app/useGroupActions";
import { useResumeQueue } from "./app/useResumeQueue";
import { useSnapshotTransfer } from "./app/useSnapshotTransfer";
import { useSystemNotifications } from "./app/useSystemNotifications";
import { useVoiceCapture } from "./app/useVoiceCapture";
import { useVoiceSettings } from "./app/useVoiceSettings";
import { useWorkspaceNavigation } from "./app/useWorkspaceNavigation";
import { useWorkspaceCreator } from "./app/useWorkspaceCreator";
import { useWorkspaces } from "./app/useWorkspaces";
import { useWorktreeClose } from "./app/useWorktreeClose";
import { WorktreeReviewDialog } from "./components/review/WorktreeReviewDialog";
import { FileEditorDialog } from "./components/editor/FileEditorDialog";
import { PromptLibraryDialog } from "./components/library/PromptLibraryDialog";
import { TeamDialog } from "./components/library/TeamDialog";
import { orchestratorOf } from "./domain/agentRoles";
import { isTerminalRunning } from "./domain/agentStatus";
import { agentLabelText, buildAgentLabels } from "./domain/agentLabels";
import { resumeCommandFor } from "./domain/session/resumeItems";
import { useTerminalSessions } from "./app/useTerminalSessions";
import { useUpdater } from "./app/useUpdater";
import type { NotificationItem } from "./domain/notification.model";
import {
  AgentPickerDialog,
  RenameDialog,
  type RenameTargetKind,
  WorkspaceDialog,
  WorktreeCloseDialog,
} from "./components/integration/dialogs";
import { ConfirmActionDialog } from "./components/overlays/Dialog";
import type { FocusedAgentAction } from "./components/overlays/CommandPalette";
import { getTerminal } from "./terminalRegistry";
import {
  usePreferencesStore,
  type HotkeyActionId,
} from "./stores/preferencesStore";
import { useTerminalRuntimeStore } from "./stores/terminalRuntimeStore";
import { useUiStore } from "./stores/uiStore";
import { useShellStore } from "./stores/shellStore";
import { useOrchestrationStore } from "./stores/orchestrationStore";
import { translateNow, useLocale, useT } from "./i18n";
import type { SettingsSectionId } from "./components/settings";
import "./App.css";

const CTRL_C = "\u0003";

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

function AppLoadingSurface() {
  const translate = useT();
  return (
    <div className="terra-app-loading" role="status" aria-live="polite">
      <span>{translate("shell.loading")}</span>
    </div>
  );
}

function App() {
  // Re-render on a language switch so dialogs and labels built here follow it.
  useLocale();
  const workspaceData = useWorkspaces();
  const { workspaces, setWorkspaces, refresh } = workspaceData;
  const agentCatalog = useAgentCatalog();
  const { agents } = agentCatalog;
  const [renameTarget, setRenameTarget] = useState<{
    kind: RenameTargetKind;
    id: string;
    value: string;
  } | null>(null);
  const [workspaceToDelete, setWorkspaceToDelete] = useState<string | null>(null);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
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
  const [capturing, setCapturing] = useState<HotkeyActionId | null>(null);
  const voiceSettings = useVoiceSettings({
    settingsOpen: showSettings,
    voiceSectionOpen: showSettings && settingsSection === "voice",
  });
  const {
    activeId,
    expandedId,
    focusedId,
    setExpandedId,
    setFocusedId,
  } = useUiStore(
    useShallow((state) => ({
      activeId: state.activeId,
      expandedId: state.expandedId,
      focusedId: state.focusedId,
      setExpandedId: state.setExpandedId,
      setFocusedId: state.setFocusedId,
    })),
  );
  const {
    snapshot: orchestrationSnapshot,
    groups,
    flags,
    setFeatureFlag,
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
      setFeatureFlag: state.setFeatureFlag,
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
      setAgentName: state.setAgentName,
    })),
  );

  useEffect(() => {
    document.documentElement.classList.toggle("reduce-motion", reduceMotion);
  }, [reduceMotion]);

  useEffect(() => {
    api.setDurableScrollbackEnabled(flags.durableScrollback).catch((error) => {
      console.warn("failed to sync durable scrollback setting:", error);
    });
  }, [flags.durableScrollback]);

  useEffect(() => {
    if (!orchestrationPersistenceError) return;
    pushSystemNotification(
      translateNow("app.saveFailed", { what: orchestrationPersistenceError.operation, detail: orchestrationPersistenceError.message }),
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
  const { appVersion, updateVersion, updateInstalling, updateCheckState, manualUpdateCheck, installUpdate } = useUpdater();
  const sessions = useTerminalSessions({ workspaces, snapshot: orchestrationSnapshot, refresh });
  const resumeQueue = useResumeQueue(sessions, refresh);
  const worktreeClose = useWorktreeClose(workspaces, sessions);
  const snapshotTransfer = useSnapshotTransfer(sessions, refresh);
  const workspaceCreator = useWorkspaceCreator(refresh);
  const agentPicker = useAgentPicker(agentCatalog, sessions);
  const applyGridLayout = useGridLayout({ workspaces, setWorkspaces, refresh });
  const initialization = useAppInitialization({ workspaces: workspaceData, sessions, resumeQueue, agentCatalog, voiceSettings });

  const active = workspaces.find((workspace) => workspace.id === activeId) ?? null;
  const agentNames = usePreferencesStore((state) => state.agentNames);
  const promptTargets = useMemo(() => {
    if (!active) return [];
    const labels = buildAgentLabels([active], { titles, names: agentNames });
    return active.terminals
      .filter((terminal) => isTerminalRunning(terminal, exited))
      .map((terminal) => ({ id: terminal.id, label: labels[terminal.id] ? agentLabelText(labels[terminal.id]) : terminal.command }));
  }, [active, titles, agentNames, exited]);
  const showResume = resumeQueue.open;
  const modalOpen =
    workspaceCreator.open ||
    agentPicker.open ||
    showResume ||
    renameTarget !== null ||
    workspaceToDelete !== null ||
    showNewGroup ||
    snapshotTransfer.pendingImportPath !== null;

  useBranchPolling(workspaces);
  useSystemNotifications(workspaces);

  const { forgetWorkspace } = useFocusTracking({
    workspaces,
    activeId,
    focusedId,
    snapshot: orchestrationSnapshot,
    modalOpen,
  });

  const clearNotifications = (id: string) => {
    clearNotificationCount(id);
    markTerminalRead(id);
  };

  const jumpToNotification = (item: NotificationItem) => {
    const ws = workspaces.find((workspace) => workspace.id === item.workspaceId);
    if (ws?.terminals.some((terminal) => terminal.id === item.terminalId)) {
      selectWorkspace(item.workspaceId, item.terminalId);
      setFocusedId(item.terminalId);
    }
    clearNotifications(item.terminalId);
  };

  const renameWorkspace = async (id: string, name: string) => {
    await api.renameWorkspace(id, name).catch((error) => {
      console.error(`failed to rename workspace ${id}:`, error);
      pushSystemNotification(translateNow("app.renameFailed", { detail: String(error) }));
    });
    await refresh();
  };

  const submitRename = async () => {
    if (!renameTarget) return;
    const target = renameTarget;
    const nextName = target.value.trim();
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

  const { selectWorkspace, hideWorkspace, hideContainer } = useWorkspaceNavigation({
    workspaces,
    snapshot: orchestrationSnapshot,
    activeId,
    focusedId,
  });

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
    actions: { quickNewTerminal: agentPicker.quickNewTerminal, selectWorkspace, suspendGroup, resumeGroup },
  });

  const stopFleetTerminals = async (ids: string[]) => {
    try {
      await Promise.all(ids.map((id) => api.stopTerminal(id)));
      await refresh();
    } catch (err) {
      console.error("failed to stop fleet terminals:", err);
      pushSystemNotification(translateNow("app.stopSomeFailed"));
      await refresh();
    }
  };

  /** Detaching is visual-only and durable; the PTY remains alive for re-open. */
  const detachTab = (id: string) => {
    setTerminalDetached(id, true);
    setExpandedId((current) => (current === id ? null : current));
    setFocusedId((current) => (current === id ? null : current));
  };

  const closeWorkspace = async (id: string): Promise<boolean> => {
    const terms = workspaces.find((workspace) => workspace.id === id)?.terminals ?? [];
    try {
      await api.closeWorkspace(id);
    } catch (err) {
      console.error(`failed to close workspace ${id}:`, err);
      pushSystemNotification(translateNow("app.deleteFailed", { detail: String(err) }));
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

  useGlobalHotkeys({
    modalOpen,
    capturing,
    setCapturing,
    shortcutsSectionOpen: showSettings && settingsSection === "shortcuts",
    active,
    focusedId,
    workspaces,
    actions: {
      openWorkspaceCreator: () => workspaceCreator.openCreator(),
      renameWorkspace: (workspace) => setRenameTarget({ kind: "workspace", id: workspace.id, value: workspace.name }),
      closeWorkspace,
      quickNewTerminal: agentPicker.quickNewTerminal,
      closeTerminal: worktreeClose.request,
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
        await api.writeTerminal(terminal.id, CTRL_C).catch((error) => console.warn(`failed to interrupt ${terminal.id}:`, error));
        return;
      case "restart":
        await sessions.restart(terminal.id, terminal.command);
        return;
      case "stop":
        await worktreeClose.request(terminal.id);
        return;
      case "clear-scrollback":
        getTerminal(terminal.id)?.clear();
        clearTerminal(terminal.id);
        pushSystemNotification(translateNow("app.historyCleared"));
        return;
      case "resume":
        await sessions.respawn(workspace.id, terminal.id, resumeCommandFor(terminal.command));
        await refresh();
        return;
    }
  };

  const settingsPage = showSettings ? (
        <Suspense fallback={<AppLoadingSurface />}>
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
              <Suspense fallback={<AppLoadingSurface />}>
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
      {initialization.error ? (
        <div className="terra-initialization-error" role="alert" aria-live="assertive">
          <div>
            <strong>{translateNow("system.initFailed")}</strong>
            <span>{initialization.error}</span>
          </div>
          <button type="button" className="terra-button" onClick={initialization.retry} disabled={initialization.running}>
            {initialization.running ? translateNow("system.retrying") : translateNow("nav.retry")}
          </button>
        </div>
      ) : null}
      <Suspense fallback={<AppLoadingSurface />}>
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
        onNewWorkspace={() => workspaceCreator.openCreator()}
        onNewAgent={(workspaceId, paneId, agentId) => {
          if (agentId) {
            void sessions.spawnInto(
              workspaceId,
              agentId,
              { placement: paneId ? { paneId } : undefined },
            ).catch(sessions.reportSpawnError);
            return;
          }
          void agentPicker.chooseForPanel(workspaceId, paneId ?? null);
        }}
        onQuickNewAgent={(workspaceId) => void agentPicker.quickNewTerminal(workspaceId)}
        onClearNotifications={clearNotifications}
        onMarkAllRead={markAllRead}
        onClearAll={clearAllNotifications}
        onJumpToNotification={jumpToNotification}
        onRestart={sessions.restart}
        onKill={(id) => void worktreeClose.request(id)}
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
        onCreateProject={(groupId) => workspaceCreator.openCreator(groupId)}
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
        <Suspense fallback={<AppLoadingSurface />}>
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
        cwd={workspaceCreator.cwd}
        groupName={workspaceCreator.groupId ? groups.find((group) => group.id === workspaceCreator.groupId)?.name : null}
        name={workspaceCreator.name}
        onBrowse={workspaceCreator.pickFolder}
        onCwdChange={workspaceCreator.setCwd}
        onNameChange={workspaceCreator.setName}
        onOpenChange={workspaceCreator.setOpen}
        onSubmit={workspaceCreator.create}
        open={workspaceCreator.open}
      />

      <AgentPickerDialog
        agents={agents}
        defaultAgent={defaultAgent}
        onChoose={agentPicker.choose}
        onOpenChange={agentPicker.setOpen}
        onSaveDefaultChange={agentPicker.setSaveDefault}
        open={agentPicker.open}
        saveDefault={agentPicker.saveDefault}
        canIsolate={Boolean(agentPicker.target && branches[agentPicker.target])}
        isolate={agentPicker.isolate}
        onIsolateChange={agentPicker.setIsolate}
        role={agentPicker.role}
        onRoleChange={agentPicker.setRole}
      />

      <WorktreeCloseDialog {...worktreeClose.dialog} />
      <WorktreeReviewDialog />
      <FileEditorDialog />
      <PromptLibraryDialog
        projectName={active?.name ?? null}
        targets={promptTargets}
        defaultTargetId={(active ? orchestratorOf(active, exited) : null) ?? (focusedId && promptTargets.some((target) => target.id === focusedId) ? focusedId : null)}
      />
      <TeamDialog
        projectName={active?.name ?? null}
        agents={agents}
        defaultAgent={defaultAgent}
        canIsolate={Boolean(active && branches[active.id])}
        onSpawn={async (agent, options) => {
          if (!active) return;
          await sessions.spawnInto(active.id, agent, options);
        }}
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
        description={translateNow("app.importDescription")}
        onConfirm={() => snapshotTransfer.confirmImport()}
        onOpenChange={(open) => {
          if (!open) snapshotTransfer.cancelImport();
        }}
        open={snapshotTransfer.pendingImportPath !== null}
        title={translateNow("app.importTitle")}
        confirmLabel={translateNow("settingsPanels.importSnapshot")}
      />

      <ConfirmActionDialog
        description={(() => {
          const project = workspaceToDelete
            ? workspaces.find((workspace) => workspace.id === workspaceToDelete)
            : null;
          return project
            ? translateNow("app.deleteProjectNamed", { name: project.name })
            : translateNow("app.deleteProject");
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
        title={translateNow("app.deleteTitle")}
        confirmLabel={translateNow("app.deleteConfirm")}
      />

    </MotionConfig>
  );
}

export default App;
