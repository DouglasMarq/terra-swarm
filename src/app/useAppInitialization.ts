import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { ResumeItem } from "../types";
import { t } from "../i18n";
import { createInitializationGate, type InitializationGate } from "../lib/session/initializationGate";
import { isTerminalSuspended, suspendedGroupIds } from "../lib/session/resumeSelection";
import { useTerminalRuntimeStore } from "../stores/terminalRuntimeStore";
import type { useAgentCatalog } from "./useAgentCatalog";
import type { useResumeQueue } from "./useResumeQueue";
import type { useVoiceSettings } from "./useVoiceSettings";
import type { useWorkspaces } from "./useWorkspaces";
import { resumeItemFor, type TerminalSessions } from "./useTerminalSessions";

function describeInitializationError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return t("app.loadFailed");
}

interface InitializationInput {
  workspaces: ReturnType<typeof useWorkspaces>;
  sessions: TerminalSessions;
  resumeQueue: ReturnType<typeof useResumeQueue>;
  agentCatalog: ReturnType<typeof useAgentCatalog>;
  voiceSettings: ReturnType<typeof useVoiceSettings>;
}

/**
 * First load: projects, which persisted terminals are still alive (the rest
 * go to the resume queue), agent detection and voice settings. A gate
 * coalesces StrictMode and concurrent attempts; a failure can be retried.
 */
export function useAppInitialization({ workspaces, sessions, resumeQueue, agentCatalog, voiceSettings }: InitializationInput) {
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const started = useRef(false);
  const gate = useRef<InitializationGate | null>(null);
  if (!gate.current) gate.current = createInitializationGate();

  const initialize = async () => {
    let list = await api.listWorkspaces();
    if (list.length === 0) {
      await api.createWorkspace("default", "");
      list = await api.listWorkspaces();
    }
    const groups = await workspaces.loadGroups();
    workspaces.apply(list, groups);

    const live = await api.runningTerminals();
    const liveIds = new Set(live.map((terminal) => terminal.id));
    sessions.track(list.flatMap((workspace) => workspace.terminals.map((terminal) => terminal.id)), live);
    const suspendedGroups = suspendedGroupIds(groups);
    const suspendedProjects = new Set(groups.filter((group) => group.suspended === true).flatMap((group) => group.projectIds));
    // Persisted terminals that are no longer alive were running when the app
    // last closed: offer to resume them instead of silently respawning.
    const items: ResumeItem[] = [];
    for (const workspace of list) {
      for (const terminal of workspace.terminals) {
        if (liveIds.has(terminal.id)) continue;
        // Suspended sessions are deliberately dormant (imported snapshots too).
        if (isTerminalSuspended(workspace, terminal, suspendedGroups) || suspendedProjects.has(workspace.id)) continue;
        items.push(resumeItemFor(workspace, terminal));
      }
    }
    if (items.length > 0) {
      // Show the exited overlay right away instead of a blank pane.
      useTerminalRuntimeStore.getState().setExited((previous) => {
        const next = { ...previous };
        for (const item of items) next[item.terminalId] = null;
        return next;
      });
      resumeQueue.offer(items);
    }

    await agentCatalog.detect();
    voiceSettings.applyStoredSettings();
  };

  const start = () => {
    const current = gate.current;
    if (!current || current.isRunning()) return;
    started.current = true;
    setError(null);
    setRunning(true);
    void current.run(initialize).then(
      () => setRunning(false),
      (failure) => {
        console.error("initialization failed:", failure);
        started.current = false;
        setError(describeInitializationError(failure));
        setRunning(false);
      },
    );
  };

  useEffect(() => {
    if (started.current) return;
    start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { error, running, retry: start };
}
