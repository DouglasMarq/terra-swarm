import type { Workspace, WorkspaceSnapshotV2 } from "../workspace.model";

export interface WorkspaceContainerSelectionOptions {
  preferredContainerId?: string | null;
  focusedTerminalId?: string | null;
  isVisibleOnly?: boolean;
}

export interface WorkspaceContainerQuery extends WorkspaceContainerSelectionOptions {
  workspaceId: string;
}

export function selectWorkspaceContainerId(
  snapshot: WorkspaceSnapshotV2 | null,
  workspaces: readonly Workspace[],
  query: WorkspaceContainerQuery,
): string | null {
  const { workspaceId, ...options } = query;
  const containers = (snapshot?.containers ?? []).filter(
    (container) => container.projectId === workspaceId,
  );
  if (containers.length === 0) return null;

  const byId = new Map(containers.map((container) => [container.id, container]));
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  const project = snapshot?.projects.find((candidate) => candidate.id === workspaceId);

  const candidates: string[] = [];
  const add = (id: string | null | undefined) => {
    if (id && byId.has(id) && !candidates.includes(id)) candidates.push(id);
  };

  add(options.preferredContainerId);

  const focusedTerminal = options.focusedTerminalId
    ? workspace?.terminals.find((terminal) => terminal.id === options.focusedTerminalId)
    : undefined;
  const focusedPaneId =
    focusedTerminal?.paneId ??
    (options.focusedTerminalId
      ? snapshot?.tabs.find((tab) => tab.ptyId === options.focusedTerminalId)?.paneId
      : null) ??
    null;
  if (focusedPaneId) {
    add(snapshot?.panes.find((pane) => pane.id === focusedPaneId)?.containerId);
  }

  add(workspace?.activeContainerId);
  add(project?.activeContainerId);

  const available = options.isVisibleOnly
    ? containers.filter((container) => container.visible)
    : containers;
  for (const container of available) add(container.id);

  if (options.isVisibleOnly) {
    return candidates.find((id) => byId.get(id)?.visible) ?? null;
  }
  return candidates.find((id) => byId.get(id)?.visible) ?? candidates[0] ?? null;
}
