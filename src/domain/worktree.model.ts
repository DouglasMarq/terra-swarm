export interface WorktreeInfo {
  path: string;
  cwd: string;
  branch: string;
  base: string;
  repo: string;
}

export interface WorktreeChangedFile {
  path: string;
  change: "added" | "modified" | "deleted" | "renamed" | "untracked";
  additions: number | null;
  deletions: number | null;
}

export interface WorktreeDiff {
  status: WorktreeStatus;
  files: WorktreeChangedFile[];
  patch: string;
  truncated: boolean;
}

export interface WorktreeStatus {
  branch: string;
  base: string;
  path: string;
  dirty: string[];
  ahead: number;
  behind: number;
  exists: boolean;
}
