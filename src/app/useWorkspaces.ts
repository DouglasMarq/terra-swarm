import { useCallback, useState } from "react";
import { api } from "../api";
import type { Workspace, WorkspaceGroup } from "../domain/workspace.model";
import { useOrchestrationStore } from "../stores/orchestrationStore";
import { useUiStore } from "../stores/uiStore";

function chooseActiveWorkspace(list: readonly Workspace[]) {
  const visible = new Set(
    (useOrchestrationStore.getState().snapshot?.containers ?? [])
      .filter((container) => container.isVisible)
      .map((container) => container.projectId)
      .filter((id): id is string => Boolean(id)),
  );
  useUiStore.getState().setActiveId((previous) =>
    previous && visible.has(previous)
      ? previous
      : (list.find((workspace) => visible.has(workspace.id))?.id ?? list[0]?.id ?? null),
  );
}

export function useWorkspaces() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);

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
