import type { Workspace, WorkspaceSnapshotV2 } from "../types";
import { selectWorkspaceContainerId } from "../domain/session/workspaceContainerSelection";
import { useOrchestrationStore } from "../stores/orchestrationStore";
import { useUiStore } from "../stores/uiStore";

interface WorkspaceNavigationInput {
  workspaces: readonly Workspace[];
  snapshot: WorkspaceSnapshotV2 | null;
  activeId: string | null;
  focusedId: string | null;
}

/** Showing, hiding and switching projects. Hiding never touches a PTY. */
export function useWorkspaceNavigation({ workspaces, snapshot, activeId, focusedId }: WorkspaceNavigationInput) {
  const ui = () => useUiStore.getState();

  const containerIdForWorkspace = (
    workspaceId: string,
    visibleOnly = false,
    focusedTerminalId = focusedId,
  ): string | null =>
    selectWorkspaceContainerId(snapshot, workspaces as Workspace[], workspaceId, {
      focusedTerminalId,
      visibleOnly,
    });

  /** Hide exactly one visual container. PTYs and sibling containers remain intact. */
  const hideContainer = (containerId: string) => {
    const before = useOrchestrationStore.getState().snapshot;
    const container = before?.containers.find((candidate) => candidate.id === containerId);
    if (!container) return;
    useOrchestrationStore.getState().setContainerVisible(containerId, false);
    if (!container.projectId || activeId !== container.projectId) return;

    const after = useOrchestrationStore.getState().snapshot;
    const visibleContainers = (after?.containers ?? []).filter(
      (candidate) => candidate.visible && candidate.id !== containerId && candidate.projectId,
    );
    const next =
      visibleContainers.find((candidate) => candidate.projectId !== container.projectId) ??
      visibleContainers[0];
    ui().setActiveId(next?.projectId ?? null);
    ui().setExpandedId(null);
    ui().setFocusedId(null);
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
    ui().setActiveId(next?.id ?? null);
    ui().setExpandedId(null);
    ui().setFocusedId(null);
  };

  const selectWorkspace = (id: string, focusedTerminalId?: string) => {
    const containerId = containerIdForWorkspace(id, false, focusedTerminalId);
    if (containerId) useOrchestrationStore.getState().setContainerVisible(containerId, true);
    // Clicking into a pane of the open project must not undo its maximize.
    if (id !== activeId) ui().setExpandedId(null);
    ui().setActiveId(id);
  };

  return { selectWorkspace, hideWorkspace, hideContainer };
}
