import type {
  ActivePaneSelection,
  TerminalPlacement,
  Workspace,
  WorkspaceContainerPatch,
  WorkspaceGroup,
  WorkspaceLayout,
  WorkspaceSnapshotTransfer,
  WorkspaceFileContent,
  WorkspaceFileListing,
  WorkspaceFileSaved,
} from "../../types";
import { invokeCommand } from "./commands";

export function listWorkspaces(): Promise<Workspace[]> {
  return invokeCommand("listWorkspaces");
}

/** Entries listed per directory unless asked otherwise; mirrors `DEFAULT_FILE_LIST_LIMIT` in `src-tauri/src/workspace/files.rs`. */
export const DEFAULT_FILE_LIST_LIMIT = 200;

/** Load one workspace-relative directory without reading file contents. */
export function listWorkspaceFiles(
  workspaceId: string,
  relativePath = "",
  limit = DEFAULT_FILE_LIST_LIMIT,
): Promise<WorkspaceFileListing> {
  return invokeCommand("listWorkspaceFiles", {
    workspaceId,
    relativePath,
    limit,
  });
}

/** One text file for the editor (at most 2 MB). */
export function readWorkspaceFile(workspaceId: string, relativePath: string): Promise<WorkspaceFileContent> {
  return invokeCommand("readWorkspaceFile", { workspaceId, relativePath });
}

/** Save the editor's text; fails with a `changedOnDisk` `IpcError` when the file changed since `expectedModified` (pass null to overwrite). */
export function writeWorkspaceFile(
  workspaceId: string,
  relativePath: string,
  content: string,
  expectedModified: number | null,
): Promise<WorkspaceFileSaved> {
  return invokeCommand("writeWorkspaceFile", { workspaceId, relativePath, content, expectedModified });
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
  return invokeCommand("createWorkspace", { name, cwd });
}

export function closeWorkspace(id: string): Promise<void> {
  return invokeCommand("closeWorkspace", { id });
}

export function renameWorkspace(id: string, name: string): Promise<void> {
  return invokeCommand("renameWorkspace", { id, name });
}

export function listGroups(): Promise<WorkspaceGroup[]> {
  return invokeCommand("listGroups");
}

export function createGroup(name: string): Promise<WorkspaceGroup> {
  return invokeCommand("createGroup", { name });
}

export function renameGroup(id: string, name: string): Promise<void> {
  return invokeCommand("renameGroup", { id, name });
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
  return invokeCommand("setWorkspaceGroup", { workspaceId, groupId });
}

export function setTerminalPlacement(placement: TerminalPlacement): Promise<void> {
  return invokeCommand("setTerminalPlacement", placement);
}

export function setActivePane(selection: ActivePaneSelection): Promise<void> {
  return invokeCommand("setActivePane", selection);
}

export function reorderWorkspaceContainers(
  workspaceId: string,
  order: string[],
): Promise<void> {
  return invokeCommand("reorderWorkspaceContainers", { workspaceId, order });
}

export function reorderWorkspacePanes(
  workspaceId: string,
  containerId: string,
  order: string[],
): Promise<void> {
  return invokeCommand("reorderWorkspacePanes", { workspaceId, containerId, order });
}

export function moveWorkspacePane(
  workspaceId: string,
  paneId: string,
  toContainerId: string,
  index?: number | null,
): Promise<void> {
  return invokeCommand("moveWorkspacePane", {
    workspaceId,
    paneId,
    toContainerId,
    ...(index === undefined ? {} : { index }),
  });
}

export function setWorkspaceContainerState(
  workspaceId: string,
  containerId: string,
  patch: WorkspaceContainerPatch,
): Promise<void> {
  return invokeCommand("setWorkspaceContainerState", { workspaceId, containerId, patch });
}

export function setWorkspaceLayout(
  workspaceId: string,
  layout: WorkspaceLayout,
): Promise<void> {
  return invokeCommand("setWorkspaceLayout", { workspaceId, layout });
}

export function setWorkspaceCollapsed(
  workspaceId: string,
  collapsed: boolean,
): Promise<void> {
  return invokeCommand("setWorkspaceCollapsed", { workspaceId, collapsed });
}

export function reorderWorkspaces(order: string[]): Promise<void> {
  return invokeCommand("reorderWorkspaces", { order });
}

export function setTerminalWidth(
  wsId: string,
  terminalId: string,
  width: number,
): Promise<void> {
  return invokeCommand("setTerminalWidth", { wsId, terminalId, width });
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
