/** Longest task title the board accepts; mirrors `MAX_TITLE_CHARS` in `src-tauri/src/mcp/repo.rs`. */
export const MAX_TASK_TITLE_CHARS = 200;

/** The number of a task id ("T-12" → 12), or the largest safe integer when it has none, so such tasks sort last. */
export function taskNumber(id: string): number {
  const value = Number(id.replace(/^T-/i, ""));
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}
