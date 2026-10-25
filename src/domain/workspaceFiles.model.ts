export type WorkspaceFileKind = "directory" | "file" | "symlink" | "other";

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  kind: WorkspaceFileKind;
  size: number | null;
}

export interface WorkspaceFileContent {
  path: string;
  content: string;
  isBinary: boolean;
  size: number;
  modified: number;
}

export interface WorkspaceFileSaved {
  size: number;
  modified: number;
}

export interface WorkspaceFileListing {
  path: string;
  entries: WorkspaceFileEntry[];
  isTruncated: boolean;
  limit: number;
}
