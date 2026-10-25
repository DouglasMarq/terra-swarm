import { useEffect, useRef } from "react";
import { api } from "../api";
import type { Workspace, WorkspaceSnapshotV2 } from "../domain/workspace.model";
import { getTerminal } from "../terminalRegistry";
import { useUiStore } from "../stores/uiStore";
import { useOrchestrationStore } from "../stores/orchestrationStore";

const PERSIST_FOCUS_DELAY_MS = 100;

interface FocusTrackingInput {
  workspaces: readonly Workspace[];
  activeId: string | null;
  focusedId: string | null;
  snapshot: WorkspaceSnapshotV2 | null;
  isModalOpen: boolean;
}

export function useFocusTracking({ workspaces, activeId, focusedId, snapshot, isModalOpen }: FocusTrackingInput) {
  const lastFocusByWorkspace = useRef<Record<string, string>>({});
  const previousActiveId = useRef<string | null>(null);
  const persistedSelection = useRef<string | null>(null);

  useEffect(() => {
    if (!activeId || !focusedId) return;
    const workspace = workspaces.find((candidate) => candidate.id === activeId);
    if (workspace?.terminals.some((terminal) => terminal.id === focusedId)) {
      lastFocusByWorkspace.current[activeId] = focusedId;
    }
  }, [activeId, focusedId, workspaces]);

  useEffect(() => {
    if (previousActiveId.current === activeId) return;
    previousActiveId.current = activeId;
    if (!activeId) return;
    const workspace = workspaces.find((candidate) => candidate.id === activeId);
    if (!workspace) return;
    const saved = lastFocusByWorkspace.current[activeId];
    useUiStore.getState().setFocusedId((current) => {
      if (current && workspace.terminals.some((terminal) => terminal.id === current)) return current;
      return saved && workspace.terminals.some((terminal) => terminal.id === saved) ? saved : null;
    });
  }, [activeId, workspaces]);

  useEffect(() => {
    if (!activeId || !snapshot) return;
    const workspace = workspaces.find((candidate) => candidate.id === activeId);
    if (!workspace) return;
    const focused = focusedId ? workspace.terminals.find((terminal) => terminal.id === focusedId) : undefined;
    const snapshotTab = focusedId
      ? snapshot.tabs.find((tab) => tab.ptyId === focusedId || tab.id === focused?.tabId)
      : undefined;
    const project = snapshot.projects.find((candidate) => candidate.id === activeId);
    if (!focused) return;
    const paneId = focused.paneId ?? snapshotTab?.paneId ?? project?.activePaneId ?? null;
    if (!paneId) return;
    const tabId = focused.tabId ?? snapshotTab?.id ?? `tab-${focused.id}`;
    const selectionKey = `${activeId}:${paneId}:${focusedId ?? ""}`;
    if (persistedSelection.current === selectionKey) return;
    persistedSelection.current = selectionKey;
    const timer = window.setTimeout(() => {
      api.setTerminalPlacement({ workspaceId: activeId, terminalId: focused.id, paneId, tabId })
        .then(() => api.setActivePane({ workspaceId: activeId, paneId }))
        .then(() => useOrchestrationStore.getState().setActivePane(paneId))
        .catch((error) => {
          console.warn("failed to persist active pane/tab:", error);
        });
    }, PERSIST_FOCUS_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [activeId, focusedId, workspaces, snapshot]);

  useEffect(() => {
    if (!focusedId || !activeId || isModalOpen) return;
    const element = document.activeElement as HTMLElement | null;
    if (element && (element.tagName === "INPUT" || element.tagName === "SELECT")) return;
    const frame = requestAnimationFrame(() => getTerminal(focusedId)?.focus());
    return () => cancelAnimationFrame(frame);
  }, [activeId, focusedId, isModalOpen]);

  return {
    forgetWorkspace: (workspaceId: string) => {
      delete lastFocusByWorkspace.current[workspaceId];
    },
  };
}
