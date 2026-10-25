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
  /** `null` for binary files. */
  additions: number | null;
  deletions: number | null;
}

/** What an isolated agent changed since its branch left the base. */
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
  /** Files with uncommitted changes. */
  dirty: string[];
  /** Commits on the agent's branch that the base does not have. */
  ahead: number;
  behind: number;
  exists: boolean;
}
