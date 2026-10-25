import type { TerminalPlacement } from "../../domain/terminal.model";
import type { ActivePaneSelection, Workspace, WorkspaceContainerPatch, WorkspaceGroup, WorkspaceLayout, WorkspacePaneMove, WorkspaceSnapshotTransfer } from "../../domain/workspace.model";
import type { WorkspaceFileContent, WorkspaceFileListing, WorkspaceFileSaved, WorkspaceFileWrite } from "../../domain/workspaceFiles.model";
import { invokeCommand } from "./commands";
import { listenPayload, type UnlistenFn } from "./events";

export function listWorkspaces(): Promise<Workspace[]> {
  return invokeCommand("listWorkspaces");
}

export const DEFAULT_FILE_LIST_LIMIT = 200;

export function listWorkspaceFiles(
  workspaceId: string,
  relativePath = "",
  limit = DEFAULT_FILE_LIST_LIMIT,
): Promise<WorkspaceFileListing> {
  return invokeCommand("listWorkspaceFiles", {
    request: {
      workspaceId,
      relativePath,
      limit,
    },
  });
}

export function readWorkspaceFile(workspaceId: string, relativePath: string): Promise<WorkspaceFileContent> {
  return invokeCommand("readWorkspaceFile", { workspaceId, relativePath });
}

export function writeWorkspaceFile(write: WorkspaceFileWrite): Promise<WorkspaceFileSaved> {
  return invokeCommand("writeWorkspaceFile", { request: write });
}

export function exportWorkspaceSnapshot(
  path: string,
): Promise<WorkspaceSnapshotTransfer> {
  return invokeCommand("exportWorkspaceSnapshot", { path });
}

export function importWorkspaceSnapshot(
  path: string,
): Promise<WorkspaceSnapshotTransfer> {
  return invokeCommand("importWorkspaceSnapshot", { path });
}

export function createWorkspace(name: string, cwd: string): Promise<Workspace> {
  return invokeCommand("createWorkspace", { request: { name, cwd } });
}

export function closeWorkspace(id: string): Promise<void> {
  return invokeCommand("closeWorkspace", { id });
}

export function renameWorkspace(id: string, name: string): Promise<void> {
  return invokeCommand("renameWorkspace", { request: { id, name } });
}

export function listGroups(): Promise<WorkspaceGroup[]> {
  return invokeCommand("listGroups");
}

export function createGroup(name: string): Promise<WorkspaceGroup> {
  return invokeCommand("createGroup", { name });
}

export function renameGroup(id: string, name: string): Promise<void> {
  return invokeCommand("renameGroup", { request: { id, name } });
}

export function removeGroup(id: string): Promise<void> {
  return invokeCommand("removeGroup", { id });
}

export function suspendGroup(id: string): Promise<void> {
  return invokeCommand("suspendGroup", { id });
}

export function resumeGroup(id: string): Promise<void> {
  return invokeCommand("resumeGroup", { id });
}

export function setWorkspaceGroup(
  workspaceId: string,
  groupId: string | null,
): Promise<void> {
  return invokeCommand("setWorkspaceGroup", { request: { workspaceId, groupId } });
}

export function setTerminalPlacement(placement: TerminalPlacement): Promise<void> {
  return invokeCommand("setTerminalPlacement", { request: placement });
}

export function setActivePane(selection: ActivePaneSelection): Promise<void> {
  return invokeCommand("setActivePane", { request: selection });
}

export function reorderWorkspaceContainers(
  workspaceId: string,
  order: string[],
): Promise<void> {
  return invokeCommand("reorderWorkspaceContainers", { request: { workspaceId, order } });
}

export function reorderWorkspacePanes(
  workspaceId: string,
  containerId: string,
  order: string[],
): Promise<void> {
  return invokeCommand("reorderWorkspacePanes", { request: { workspaceId, containerId, order } });
}

export function moveWorkspacePane(move: WorkspacePaneMove): Promise<void> {
  const { index, ...pane } = move;
  return invokeCommand("moveWorkspacePane", {
    request: {
      ...pane,
      ...(index === undefined ? {} : { index }),
    },
  });
}

export function setWorkspaceContainerState(
  workspaceId: string,
  containerId: string,
  patch: WorkspaceContainerPatch,
): Promise<void> {
  return invokeCommand("setWorkspaceContainerState", { request: { workspaceId, containerId, patch } });
}

export function setWorkspaceLayout(
  workspaceId: string,
  layout: WorkspaceLayout,
): Promise<void> {
  return invokeCommand("setWorkspaceLayout", { request: { workspaceId, layout } });
}

export function setWorkspaceCollapsed(
  workspaceId: string,
  isCollapsed: boolean,
): Promise<void> {
  return invokeCommand("setWorkspaceCollapsed", { request: { workspaceId, isCollapsed } });
}

export function reorderWorkspaces(order: string[]): Promise<void> {
  return invokeCommand("reorderWorkspaces", { order });
}

export function setTerminalWidth(
  wsId: string,
  terminalId: string,
  width: number,
): Promise<void> {
  return invokeCommand("setTerminalWidth", { request: { wsId, terminalId, width } });
}

export function onWorkspacesChanged(handler: () => void): Promise<UnlistenFn> {
  return listenPayload("workspaces-changed", handler);
}

export const workspaceApi = {
  listWorkspaces,
  listWorkspaceFiles,
  readWorkspaceFile,
  writeWorkspaceFile,
  exportWorkspaceSnapshot,
  importWorkspaceSnapshot,
  createWorkspace,
  closeWorkspace,
  renameWorkspace,
  listGroups,
  createGroup,
  renameGroup,
  removeGroup,
  suspendGroup,
  resumeGroup,
  setWorkspaceGroup,
  setTerminalPlacement,
  setActivePane,
  reorderWorkspaceContainers,
  reorderWorkspacePanes,
  moveWorkspacePane,
  setWorkspaceContainerState,
  setWorkspaceLayout,
  setWorkspaceCollapsed,
  reorderWorkspaces,
  setTerminalWidth,
} as const;
