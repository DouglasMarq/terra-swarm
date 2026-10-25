import type { Workspace, WorkspaceSnapshotV2 } from "../workspace.model";

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

export function neighborTerminalId(workspaces: readonly Workspace[], terminalId: string): string | null {
  const workspace = workspaces.find((candidate) => candidate.terminals.some((terminal) => terminal.id === terminalId));
  if (!workspace) return null;
  const index = workspace.terminals.findIndex((terminal) => terminal.id === terminalId);
  const neighbor = workspace.terminals[index - 1] ?? workspace.terminals[index + 1];
  return neighbor?.id ?? null;
}
