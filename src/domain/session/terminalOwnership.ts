import type { Workspace, WorkspaceSnapshotV2 } from "../workspace.model";

/**
 * Resolves a terminal's owning workspace from current metadata.
 *
 * The focused/active workspace is a view concern and is deliberately not
 * consulted here: commands such as restart must remain scoped to the PTY's
 * actual project when another project is selected in the shell.
 */
export function workspaceIdForTerminal(
  workspaces: readonly Workspace[],
  snapshot: WorkspaceSnapshotV2 | null | undefined,
  terminalId: string,
): string | null {
  const currentOwner = workspaces.find((workspace) =>
    workspace.terminals.some((terminal) => terminal.id === terminalId),
  );
  if (currentOwner) return currentOwner.id;

  const tab = snapshot?.tabs.find((candidate) =>
    candidate.ptyId === terminalId ||
    candidate.id === terminalId ||
    candidate.legacyTerminalId === terminalId,
  );
  if (!tab) return null;
  if (tab.legacyWorkspaceId) return tab.legacyWorkspaceId;

  const pane = snapshot?.panes.find((candidate) =>
    candidate.id === tab.paneId ||
    candidate.tabIds.includes(tab.id) ||
    candidate.activeTabId === tab.id,
  );
  if (pane?.projectId) return pane.projectId;

  const container = snapshot?.containers.find((candidate) =>
    candidate.id === pane?.containerId ||
    (pane ? candidate.paneIds.includes(pane.id) : false),
  );
  if (container?.projectId) return container.projectId;

  const project = snapshot?.projects.find((candidate) =>
    (pane ? candidate.paneIds.includes(pane.id) : false) ||
    (container ? candidate.containerIds.includes(container.id) : false),
  );
  return project?.id ?? null;
}
