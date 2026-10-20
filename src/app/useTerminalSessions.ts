import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../api";
import type {
  AgentLaunchExtras,
  AgentRole,
  ContextPayload,
  ExitPayload,
  NotificationPayload,
  ResumeItem,
  RunningTerminal,
  SpawnedTerminal,
  TitlePayload,
  Workspace,
  WorkspaceSnapshotV2,
} from "../types";
import { getTerminal } from "../terminalRegistry";
import { t } from "../i18n";
import { agentKind, agentLabelText, buildAgentLabels } from "../domain/agentLabels";
import { pickAgentName } from "../domain/agentNames";
import { createDebouncedTask } from "../lib/async/debounce";
import { createSpawnQueue } from "../lib/session/spawnQueue";
import { isCurrentSpawnedTerminalRunning } from "../lib/session/terminalLifecycle";
import { workspaceIdForTerminal } from "../lib/session/terminalOwnership";
import { freshCommand, profileForCommand, resolveResumeCommand } from "../lib/features/agentProfiles";
import { parseEnvLines, usePreferencesStore } from "../stores/preferencesStore";
import { useTerminalRuntimeStore } from "../stores/terminalRuntimeStore";
import { useUiStore } from "../stores/uiStore";
import { errorMessage } from "../lib/errors/errorMessage";

export function resumeCommandFor(command: string): string {
  return resolveResumeCommand(profileForCommand(command), command);
}

export function resumeItemFor(workspace: Workspace, terminal: Workspace["terminals"][number]): ResumeItem {
  return {
    terminalId: terminal.id,
    wsId: workspace.id,
    wsName: workspace.name,
    cwd: workspace.cwd,
    command: terminal.command,
    agentId: agentKind(terminal.command),
    resumeCommand: resumeCommandFor(terminal.command),
  };
}

interface TerminalSessionsInput {
  workspaces: readonly Workspace[];
  snapshot: WorkspaceSnapshotV2 | null;
  refresh: () => Promise<void>;
}

/**
 * Terminal lifecycle as the UI sees it: which ids are live and at which
 * process generation, spawning, closing, restarting and resuming, and the
 * backend events that update per-terminal runtime state.
 */
export function useTerminalSessions({ workspaces, snapshot, refresh }: TerminalSessionsInput) {
  // Authoritative set of terminal ids the UI tracks; mutated only by
  // spawn/close paths (never rebuilt from `workspaces`, which would race with
  // pending refreshes and silently drop live ids).
  const liveIds = useRef<Set<string>>(new Set());
  const spawnSeq = useRef<Record<string, number>>({});
  const runtime = () => useTerminalRuntimeStore.getState();
  const defaultShell = () => usePreferencesStore.getState().defaultShell || undefined;
  /** The user's extra arguments and variables for the command's agent. */
  const launchExtras = (command: string): AgentLaunchExtras | undefined => {
    const settings = usePreferencesStore.getState().agentLaunch[profileForCommand(command).id];
    if (!settings) return undefined;
    return { args: settings.args.trim() || undefined, env: parseEnvLines(settings.env).env };
  };

  // Backend events. Registered without a one-time guard so StrictMode's
  // unmount/remount cycle registers them again.
  useEffect(() => {
    const unlistenExit = listen<ExitPayload>("terminal-exit", (event) => {
      if (!liveIds.current.has(event.payload.id)) return;
      // Ignore exits of a previous process generation (the old PTY dying
      // right after a restart respawned the same id).
      const known = spawnSeq.current[event.payload.id];
      if (known != null && event.payload.seq !== known) return;
      runtime().setExited((previous) => ({ ...previous, [event.payload.id]: event.payload.code }));
      runtime().setContextUsage((previous) => {
        const next = { ...previous };
        delete next[event.payload.id];
        return next;
      });
    });
    const unlistenNotification = listen<NotificationPayload>("terminal-notification", (event) => {
      if (liveIds.current.has(event.payload.id)) runtime().addNotification(event.payload);
    });
    const unlistenContext = listen<ContextPayload>("terminal-context", (event) => {
      if (!liveIds.current.has(event.payload.id)) return;
      runtime().setContextUsage((previous) => ({ ...previous, [event.payload.id]: event.payload.used }));
    });
    const unlistenTitle = listen<TitlePayload>("terminal-title", (event) => {
      if (!liveIds.current.has(event.payload.id)) return;
      runtime().setTitles((previous) => ({ ...previous, [event.payload.id]: event.payload.title }));
    });
    // Layout drags and group updates can emit several events in one turn; a
    // short debounce keeps other windows current without a request per frame.
    const refreshWorkspaces = createDebouncedTask(() => {
      void refresh();
    }, 75);
    const unlistenWorkspaces = listen("workspaces-changed", () => refreshWorkspaces.schedule());
    return () => {
      refreshWorkspaces.cancel();
      for (const pending of [unlistenExit, unlistenNotification, unlistenContext, unlistenTitle, unlistenWorkspaces]) {
        void pending.then((stop) => stop());
      }
    };
  }, [refresh]);

  /** Start tracking terminals found at startup. */
  const track = (ids: Iterable<string>, running: readonly RunningTerminal[]) => {
    for (const id of ids) liveIds.current.add(id);
    for (const terminal of running) spawnSeq.current[terminal.id] = terminal.seq;
  };

  /** Stop tracking terminals that are gone for good. */
  const forget = (ids: Iterable<string>) => {
    for (const id of ids) {
      liveIds.current.delete(id);
      delete spawnSeq.current[id];
    }
  };

  /** Drop every tracked terminal (the store was replaced by an import). */
  const forgetAll = (): string[] => {
    const previous = [...liveIds.current];
    liveIds.current.clear();
    spawnSeq.current = {};
    return previous;
  };

  /**
   * `spawn_terminal` can resolve after a short-lived child was already reaped
   * and its exit emitted. Register the id first, then reconcile the returned
   * generation with the live snapshot so a missed event cannot leave dead
   * metadata rendered as an active terminal.
   */
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
        // The exit may have arrived before the id was registered. Keep a code
        // a concurrent listener stored; otherwise null marks "unknown code".
        else if (!(id in next)) next[id] = null;
        return next;
      });
      if (!isRunning) {
        runtime().setContextUsage((previous) => {
          const next = { ...previous };
          delete next[id];
          return next;
        });
      }
    } catch (error) {
      // Registration stays authoritative even when this best-effort check
      // cannot query an older native binary.
      console.warn(`failed to reconcile spawned terminal ${id}:`, error);
    }
  };

  /** Optional automatic names: a fresh agent gets the next free name. */
  const nameNewAgent = (terminalId: string) => {
    const prefs = usePreferencesStore.getState();
    if (!prefs.agentAutoNames || prefs.agentNames[terminalId]) return;
    const openIds = new Set(workspaces.flatMap((workspace) => workspace.terminals.map((terminal) => terminal.id)));
    const inUse = Object.entries(prefs.agentNames).filter(([id]) => openIds.has(id)).map(([, name]) => name);
    const name = pickAgentName(inUse, prefs.agentNameList, { avoidSimilar: prefs.avoidSimilarNames, exhausted: prefs.namesExhausted });
    if (name) prefs.setAgentName(terminalId, name);
  };

  /** Open a new agent in a project, optionally in a given pane. */
  const spawnInto = async (
    workspaceId: string,
    command: string,
    placement?: { paneId: string; tabId?: string },
    options: { worktree?: boolean; role?: AgentRole | null } = {},
  ) => {
    // Spawn at an existing pane's size when possible: otherwise the PTY starts
    // at 80x24 and the child draws its first frame at the wrong size (worst
    // on Windows/ConPTY).
    const sibling = workspaces
      .find((workspace) => workspace.id === workspaceId)
      ?.terminals.map((terminal) => getTerminal(terminal.id))
      .find((terminal) => terminal && terminal.cols > 0 && terminal.rows > 0);
    const extras = {
      ...launchExtras(command),
      ...(options.worktree ? { worktree: true } : {}),
      ...(options.role ? { role: options.role } : {}),
    };
    const result = await api.spawnTerminal(workspaceId, command, undefined, sibling?.cols, sibling?.rows, defaultShell(), extras);
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
          runtime().pushSystemNotification(t("app.placementNotSaved"));
        });
    }
    useUiStore.getState().setFocusedId(result.meta.id);
    await refresh();
  };

  const reportSpawnError = (error: unknown) => {
    console.error("failed to spawn terminal:", error);
    runtime().pushSystemNotification(t("app.spawnFailed", { detail: String(error) }));
  };

  /** End an agent for good: process, record, name and runtime state. */
  const close = async (id: string) => {
    forget([id]);
    usePreferencesStore.getState().setAgentName(id, null);
    await api.killTerminal(id).catch((error) => console.warn(`failed to kill terminal ${id}:`, error));
    runtime().clearTerminal(id);
    const ui = useUiStore.getState();
    if (ui.expandedId === id) ui.setExpandedId(null);
    if (ui.focusedId === id) {
      const workspace = workspaces.find((candidate) => candidate.terminals.some((terminal) => terminal.id === id));
      const index = workspace ? workspace.terminals.findIndex((terminal) => terminal.id === id) : -1;
      const next = workspace?.terminals[index - 1] ?? workspace?.terminals[index + 1] ?? null;
      ui.setFocusedId(next ? next.id : null);
    }
    await refresh();
  };

  /**
   * Start a terminal again under the same id, so its position, width and
   * name are kept. Spawned at the xterm's current size: it fitted to the
   * pane long ago and nothing else would send the real dimensions.
   */
  const respawn = async (workspaceId: string, terminalId: string, command: string) => {
    const term = getTerminal(terminalId);
    const result = await api.spawnTerminal(workspaceId, command, terminalId, term?.cols, term?.rows, defaultShell(), launchExtras(command));
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
      // Stop the old PTY first (its record is kept): spawning onto a live id
      // would leak the old process and double-emit output.
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

  /** Resume one persisted session with its agent's continuation command. */
  const resumeItem = async (item: ResumeItem) => {
    try {
      await respawn(item.wsId, item.terminalId, item.resumeCommand);
    } catch (error) {
      console.error(`failed to resume terminal ${item.terminalId}:`, error);
      runtime().setExited((previous) => ({ ...previous, [item.terminalId]: null }));
      throw error;
    }
  };

  /** Resume several sessions, two at a time; returns one result per item. */
  const resumeItems = async (items: readonly ResumeItem[]) => {
    const queue = createSpawnQueue<ResumeItem, void>({ concurrency: 2, run: (item) => resumeItem(item) });
    const pending = items.map((item) => queue.enqueue({ id: item.terminalId, input: item }));
    await queue.whenIdle();
    return Promise.all(pending);
  };

  type ResumeResults = Awaited<ReturnType<typeof resumeItems>>;

  const notifyResumeFailures = (results: ResumeResults, labels: ReadonlyMap<string, string>) => {
    for (const result of results) {
      if (result.status === "succeeded") continue;
      const label = labels.get(result.id) ?? result.id;
      runtime().pushSystemNotification(t("app.resumeFailed", { name: label, detail: errorMessage(result.error, result.status) }));
    }
  };

  /** Resume agents picked in the Fleet; only exited or suspended ones. */
  const resumeTerminals = async (ids: readonly string[]) => {
    const exited = runtime().exited;
    const items = ids.flatMap((id) => {
      for (const workspace of workspaces) {
        const terminal = workspace.terminals.find((candidate) => candidate.id === id);
        // The backend refuses to spawn over a live process.
        if (terminal && (terminal.id in exited || terminal.suspended)) return [resumeItemFor(workspace, terminal)];
      }
      return [];
    });
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
        t("app.resumeAgentFailed", { name: label ? agentLabelText(label) : result.id, detail: errorMessage(result.error, result.status) }),
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
