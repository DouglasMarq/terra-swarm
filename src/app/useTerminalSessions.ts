import { useEffect, useRef } from "react";
import { api } from "../api";
import { onTerminalContext, onTerminalExit, onTerminalNotification, onTerminalTitle } from "../lib/tauri/pty";
import { onWorkspacesChanged } from "../lib/tauri/workspace";
import type { AgentLaunchExtras, AgentRole } from "../domain/agent.model";
import type { ResumeItem, RunningTerminal, SpawnedTerminal } from "../domain/terminal.model";
import type { Workspace, WorkspaceSnapshotV2 } from "../domain/workspace.model";
import { getTerminal } from "../terminalRegistry";
import { translateNow } from "../i18n";
import { agentLabelText, buildAgentLabels } from "../domain/agentLabels";
import { agentNamesInUse, pickAgentName } from "../domain/agentNames";
import { createDebouncedTask } from "../lib/async/debounce";
import { createSpawnQueue } from "../domain/session/spawnQueue";
import { isCurrentSpawnedTerminalRunning } from "../domain/session/terminalLifecycle";
import { neighborTerminalId, workspaceIdForTerminal } from "../domain/session/terminalOwnership";
import { freshCommand, profileForCommand } from "../domain/agentProfiles";
import { resumableItems } from "../domain/session/resumeItems";
import { launchExtrasFrom } from "../domain/agentLaunchEnv";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useTerminalRuntimeStore } from "../stores/terminalRuntimeStore";
import { useUiStore } from "../stores/uiStore";
import { errorMessage } from "../lib/errors/errorMessage";
import { omitKey } from "../lib/records/records";

const RESUME_CONCURRENCY = 2;

const WORKSPACES_REFRESH_DEBOUNCE_MS = 75;

interface TerminalSessionsInput {
  workspaces: readonly Workspace[];
  snapshot: WorkspaceSnapshotV2 | null;
  refresh: () => Promise<void>;
}

export interface SpawnIntoOptions {
  placement?: { paneId: string; tabId?: string };
  shouldUseWorktree?: boolean;
  role?: AgentRole | null;
}

export function useTerminalSessions({ workspaces, snapshot, refresh }: TerminalSessionsInput) {
  const liveIds = useRef<Set<string>>(new Set());
  const spawnSeq = useRef<Record<string, number>>({});
  const runtime = () => useTerminalRuntimeStore.getState();
  const defaultShell = () => usePreferencesStore.getState().defaultShell || undefined;
  const launchExtras = (command: string): AgentLaunchExtras | undefined =>
    launchExtrasFrom(usePreferencesStore.getState().agentLaunch[profileForCommand(command).id]);

  useEffect(() => {
    const unlistenExit = onTerminalExit((payload) => {
      if (!liveIds.current.has(payload.id)) return;
      const known = spawnSeq.current[payload.id];
      if (known != null && payload.seq !== known) return;
      runtime().setExited((previous) => ({ ...previous, [payload.id]: payload.code }));
      runtime().setContextUsage((previous) => omitKey(previous, payload.id));
    });
    const unlistenNotification = onTerminalNotification((payload) => {
      if (liveIds.current.has(payload.id)) runtime().addNotification(payload);
    });
    const unlistenContext = onTerminalContext((payload) => {
      if (!liveIds.current.has(payload.id)) return;
      runtime().setContextUsage((previous) => ({ ...previous, [payload.id]: payload.used }));
    });
    const unlistenTitle = onTerminalTitle((payload) => {
      if (!liveIds.current.has(payload.id)) return;
      runtime().setTitles((previous) => ({ ...previous, [payload.id]: payload.title }));
    });
    const refreshWorkspaces = createDebouncedTask(() => {
      void refresh();
    }, WORKSPACES_REFRESH_DEBOUNCE_MS);
    const unlistenWorkspaces = onWorkspacesChanged(() => refreshWorkspaces.schedule());
    return () => {
      refreshWorkspaces.cancel();
      for (const pending of [unlistenExit, unlistenNotification, unlistenContext, unlistenTitle, unlistenWorkspaces]) {
        void pending.then((stop) => stop());
      }
    };
  }, [refresh]);

  const track = (ids: Iterable<string>, running: readonly RunningTerminal[]) => {
    for (const id of ids) liveIds.current.add(id);
    for (const terminal of running) spawnSeq.current[terminal.id] = terminal.seq;
  };

  const forget = (ids: Iterable<string>) => {
    for (const id of ids) {
      liveIds.current.delete(id);
      delete spawnSeq.current[id];
    }
  };

  const forgetAll = (): string[] => {
    const previous = [...liveIds.current];
    liveIds.current.clear();
    spawnSeq.current = {};
    return previous;
  };

  const registerSpawned = async (result: SpawnedTerminal) => {
    const id = result.meta.id;
    liveIds.current.add(id);
    spawnSeq.current[id] = result.seq;
    try {
      const running = await api.runningTerminals();
      const isRunning = isCurrentSpawnedTerminalRunning(id, result.seq, running);
      runtime().setExited((previous) => {
        const next = { ...previous };
        if (isRunning) delete next[id];
        else if (!(id in next)) next[id] = null;
        return next;
      });
      if (!isRunning) {
        runtime().setContextUsage((previous) => omitKey(previous, id));
      }
    } catch (error) {
      console.warn(`failed to reconcile spawned terminal ${id}:`, error);
    }
  };

  const nameNewAgent = (terminalId: string) => {
    const prefs = usePreferencesStore.getState();
    if (!prefs.shouldAutoNameAgents || prefs.agentNames[terminalId]) return;
    const inUse = agentNamesInUse(workspaces, prefs.agentNames);
    const name = pickAgentName(inUse, prefs.agentNameList, { shouldAvoidSimilar: prefs.shouldAvoidSimilarNames, exhausted: prefs.namesExhausted });
    if (name) prefs.setAgentName(terminalId, name);
  };

  const spawnInto = async (workspaceId: string, command: string, options: SpawnIntoOptions = {}) => {
    const { placement } = options;
    const sibling = workspaces
      .find((workspace) => workspace.id === workspaceId)
      ?.terminals.map((terminal) => getTerminal(terminal.id))
      .find((terminal) => terminal && terminal.cols > 0 && terminal.rows > 0);
    const extras = {
      ...launchExtras(command),
      ...(options.shouldUseWorktree ? { shouldUseWorktree: true } : {}),
      ...(options.role ? { role: options.role } : {}),
    };
    const result = await api.spawnTerminal({
      workspaceId,
      command,
      cols: sibling?.cols,
      rows: sibling?.rows,
      shell: defaultShell(),
      launch: extras,
    });
    await registerSpawned(result);
    nameNewAgent(result.meta.id);
    if (placement?.paneId) {
      await api
        .setTerminalPlacement({
          workspaceId,
          terminalId: result.meta.id,
          paneId: placement.paneId,
          tabId: placement.tabId ?? `tab-${result.meta.id}`,
        })
        .catch((error) => {
          console.error("failed to persist terminal placement:", error);
          runtime().pushSystemNotification(translateNow("app.placementNotSaved"));
        });
    }
    useUiStore.getState().setFocusedId(result.meta.id);
    await refresh();
  };

  const reportSpawnError = (error: unknown) => {
    console.error("failed to spawn terminal:", error);
    runtime().pushSystemNotification(translateNow("app.spawnFailed", { detail: String(error) }));
  };

  const close = async (id: string) => {
    forget([id]);
    usePreferencesStore.getState().setAgentName(id, null);
    await api.killTerminal(id).catch((error) => console.warn(`failed to kill terminal ${id}:`, error));
    runtime().clearTerminal(id);
    const ui = useUiStore.getState();
    if (ui.expandedId === id) ui.setExpandedId(null);
    if (ui.focusedId === id) ui.setFocusedId(neighborTerminalId(workspaces, id));
    await refresh();
  };

  const respawn = async (workspaceId: string, terminalId: string, command: string) => {
    const term = getTerminal(terminalId);
    const result = await api.spawnTerminal({
      workspaceId,
      command,
      terminalId,
      cols: term?.cols,
      rows: term?.rows,
      shell: defaultShell(),
      launch: launchExtras(command),
    });
    await registerSpawned(result);
  };

  const restart = async (id: string, command: string) => {
    const owner = workspaceIdForTerminal(workspaces, snapshot, id);
    if (!owner) {
      console.warn(`cannot restart terminal ${id}: workspace owner is unknown`);
      return;
    }
    liveIds.current.add(id);
    try {
      await api.stopTerminal(id);
      await respawn(owner, id, freshCommand(command));
    } catch (error) {
      console.error(`failed to restart terminal ${id}:`, error);
      runtime().setExited((previous) => ({ ...previous, [id]: null }));
      await refresh();
      return;
    }
    runtime().clearTerminal(id);
    await refresh();
  };

  const resumeItem = async (item: ResumeItem) => {
    try {
      await respawn(item.wsId, item.terminalId, item.resumeCommand);
    } catch (error) {
      console.error(`failed to resume terminal ${item.terminalId}:`, error);
      runtime().setExited((previous) => ({ ...previous, [item.terminalId]: null }));
      throw error;
    }
  };

  const resumeItems = async (items: readonly ResumeItem[]) => {
    const queue = createSpawnQueue<ResumeItem, void>({ concurrency: RESUME_CONCURRENCY, run: (item) => resumeItem(item), now: Date.now });
    const pending = items.map((item) => queue.enqueue({ id: item.terminalId, input: item }));
    await queue.whenIdle();
    return Promise.all(pending);
  };

  type ResumeResults = Awaited<ReturnType<typeof resumeItems>>;

  const notifyResumeFailures = (results: ResumeResults, labels: ReadonlyMap<string, string>) => {
    for (const result of results) {
      if (result.status === "succeeded") continue;
      const label = labels.get(result.id) ?? result.id;
      runtime().pushSystemNotification(translateNow("app.resumeFailed", { name: label, detail: errorMessage(result.error, result.status) }));
    }
  };

  const resumeTerminals = async (ids: readonly string[]) => {
    const items = resumableItems(workspaces, ids, runtime().exited);
    if (items.length === 0) return;
    const results = await resumeItems(items);
    const labels = buildAgentLabels(workspaces as Workspace[], {
      titles: runtime().titles,
      names: usePreferencesStore.getState().agentNames,
    });
    for (const result of results) {
      if (result.status === "succeeded") continue;
      const label = labels[result.id];
      runtime().pushSystemNotification(
        translateNow("app.resumeAgentFailed", { name: label ? agentLabelText(label) : result.id, detail: errorMessage(result.error, result.status) }),
      );
    }
    await refresh();
  };

  return {
    track,
    forget,
    forgetAll,
    registerSpawned,
    spawnInto,
    reportSpawnError,
    close,
    respawn,
    restart,
    resumeItem,
    resumeItems,
    notifyResumeFailures,
    resumeTerminals,
  };
}

export type TerminalSessions = ReturnType<typeof useTerminalSessions>;
