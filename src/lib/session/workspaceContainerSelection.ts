import type { Workspace, WorkspaceSnapshotV2 } from "../../types";

export interface WorkspaceContainerSelectionOptions {
  /** Prefer a caller-provided location when it belongs to this workspace. */
  preferredContainerId?: string | null;
  /** Use the focused terminal's persisted pane placement as a location hint. */
  focusedTerminalId?: string | null;
  /** Exclude hidden containers when choosing a fallback. */
  visibleOnly?: boolean;
}

/**
 * Resolve a workspace to its exact visual container.
 *
 * A workspace may own more than one container. Callers that only need a
 * workspace id must therefore use the persisted active container (or the
 * focused terminal's pane) before falling back to a visible container. The
 * old `containers.find(...)` pattern silently selected the first container and
 * made hide/select act on the wrong surface after a split.
 */
export function selectWorkspaceContainerId(
  snapshot: WorkspaceSnapshotV2 | null,
  workspaces: readonly Workspace[],
  workspaceId: string,
  options: WorkspaceContainerSelectionOptions = {},
): string | null {
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

  const available = options.visibleOnly
    ? containers.filter((container) => container.visible)
    : containers;
  for (const container of available) add(container.id);

  if (options.visibleOnly) {
    return candidates.find((id) => byId.get(id)?.visible) ?? null;
  }
  return candidates.find((id) => byId.get(id)?.visible) ?? candidates[0] ?? null;
}
