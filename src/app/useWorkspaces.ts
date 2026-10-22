import { useCallback, useState } from "react";
import { api } from "../api";
import type { Workspace, WorkspaceGroup } from "../types";
import { useOrchestrationStore } from "../stores/orchestrationStore";
import { useUiStore } from "../stores/uiStore";

/** Keep the active project when it is still visible, else pick a visible one. */
function chooseActiveWorkspace(list: readonly Workspace[]) {
  const visible = new Set(
    (useOrchestrationStore.getState().snapshot?.containers ?? [])
      .filter((container) => container.visible)
      .map((container) => container.projectId)
      .filter((id): id is string => Boolean(id)),
  );
  useUiStore.getState().setActiveId((previous) =>
    previous && visible.has(previous)
      ? previous
      : (list.find((workspace) => visible.has(workspace.id))?.id ?? list[0]?.id ?? null),
  );
}

/** The projects (workspaces) as the backend stores them. */
export function useWorkspaces() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);

  /** Apply a freshly loaded list everywhere that mirrors it. */
  const apply = useCallback((list: Workspace[], groups: WorkspaceGroup[]) => {
    useOrchestrationStore.getState().sync(list, groups);
    setWorkspaces(list);
    chooseActiveWorkspace(list);
  }, []);

  const loadGroups = () =>
    api.listGroups().catch((error) => {
      console.warn("could not list groups:", error);
      return [] as WorkspaceGroup[];
    });

  const refresh = useCallback(async () => {
    try {
      const list = await api.listWorkspaces();
      apply(list, await loadGroups());
    } catch (error) {
      console.error("failed to list workspaces:", error);
    }
  }, [apply]);

  return { workspaces, setWorkspaces, refresh, apply, loadGroups };
}
