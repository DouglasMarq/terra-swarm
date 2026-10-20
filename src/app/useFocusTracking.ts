import { useEffect, useRef } from "react";
import { api } from "../api";
import type { Workspace, WorkspaceSnapshotV2 } from "../types";
import { getTerminal } from "../terminalRegistry";
import { useUiStore } from "../stores/uiStore";
import { useOrchestrationStore } from "../stores/orchestrationStore";

interface FocusTrackingInput {
  workspaces: readonly Workspace[];
  activeId: string | null;
  focusedId: string | null;
  snapshot: WorkspaceSnapshotV2 | null;
  /** A dialog is open: keyboard focus stays with it. */
  modalOpen: boolean;
}

/**
 * Keeps focus sensible across project switches: remembers the last focused
 * agent per project, persists the selected pane/tab, and hands keyboard
 * focus back to the terminal when nothing else wants it.
 */
export function useFocusTracking({ workspaces, activeId, focusedId, snapshot, modalOpen }: FocusTrackingInput) {
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

  // Persist the selected pane whenever the workspace or focused tab changes.
  // Including the focused terminal in the dedupe key keeps the local
  // active-tab projection in step without a request per refresh or event.
  useEffect(() => {
    if (!activeId || !snapshot) return;
    const workspace = workspaces.find((candidate) => candidate.id === activeId);
    if (!workspace) return;
    const focused = focusedId ? workspace.terminals.find((terminal) => terminal.id === focusedId) : undefined;
    const snapshotTab = focusedId
      ? snapshot.tabs.find((tab) => tab.ptyId === focusedId || tab.id === focused?.tabId)
      : undefined;
    const project = snapshot.projects.find((candidate) => candidate.id === activeId);
    // A migrated legacy workspace may have a synthetic pane in the frontend
    // snapshot while the Rust store has no pane metadata. Only persist a
    // selection for a focused terminal, materializing its placement first.
    if (!focused) return;
    const paneId = focused.paneId ?? snapshotTab?.paneId ?? project?.activePaneId ?? null;
    if (!paneId) return;
    const tabId = focused.tabId ?? snapshotTab?.id ?? `tab-${focused.id}`;
    const selectionKey = `${activeId}:${paneId}:${focusedId ?? ""}`;
    if (persistedSelection.current === selectionKey) return;
    // Set the key before the async boundary: a failed IPC call is logged but
    // must not cause a retry storm during refreshes.
    persistedSelection.current = selectionKey;
    const timer = window.setTimeout(() => {
      // setTerminalPlacement is also how the backend marks the active tab
      // inside a pane, so call it even when placement metadata exists.
      api.setTerminalPlacement({ workspaceId: activeId, terminalId: focused.id, paneId, tabId })
        .then(() => api.setActivePane({ workspaceId: activeId, paneId }))
        .then(() => useOrchestrationStore.getState().setActivePane(paneId))
        .catch((error) => {
          console.warn("failed to persist active pane/tab:", error);
        });
    }, 100);
    return () => window.clearTimeout(timer);
  }, [activeId, focusedId, workspaces, snapshot]);

  useEffect(() => {
    if (!focusedId || !activeId || modalOpen) return;
    const element = document.activeElement as HTMLElement | null;
    if (element && (element.tagName === "INPUT" || element.tagName === "SELECT")) return;
    const frame = requestAnimationFrame(() => getTerminal(focusedId)?.focus());
    return () => cancelAnimationFrame(frame);
  }, [activeId, focusedId, modalOpen]);

  return {
    /** Forget a closed project's remembered focus. */
    forgetWorkspace: (workspaceId: string) => {
      delete lastFocusByWorkspace.current[workspaceId];
    },
  };
}
