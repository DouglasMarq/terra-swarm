/** Metadata-only directory entry returned by the lazy Navigator Files provider. */
export type WorkspaceFileKind = "directory" | "file" | "symlink" | "other";

export interface WorkspaceFileEntry {
  name: string;
  /** Workspace-relative path; the backend never returns file contents. */
  path: string;
  kind: WorkspaceFileKind;
  size: number | null;
}

/** One text file opened in the built-in editor. */
export interface WorkspaceFileContent {
  path: string;
  /** Empty for binary files. */
  content: string;
  binary: boolean;
  size: number;
  /** Modification time (ms), passed back on save to detect outside edits. */
  modified: number;
}

export interface WorkspaceFileSaved {
  size: number;
  modified: number;
}

export interface WorkspaceFileListing {
  path: string;
  entries: WorkspaceFileEntry[];
  truncated: boolean;
  limit: number;
}
