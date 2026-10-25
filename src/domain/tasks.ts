import type { McpTask, McpTaskPriority, McpTaskStatus } from "./mcp.model";

/** Longest task title the board accepts; mirrors `MAX_TITLE_CHARS` in `src-tauri/src/mcp/repo.rs`. */
export const MAX_TASK_TITLE_CHARS = 200;

/** The number of a task id ("T-12" → 12), or the largest safe integer when it has none, so such tasks sort last. */
export function taskNumber(id: string): number {
  const value = Number(id.replace(/^T-/i, ""));
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

/** Column order of the board: what is moving first, finished work last. */
export const TASK_STATUS_ORDER: readonly McpTaskStatus[] = ["in_progress", "todo", "blocked", "review", "done"];
export const TASK_PRIORITIES: readonly McpTaskPriority[] = ["urgent", "high", "medium", "low"];

const PRIORITY_RANK: Record<McpTaskPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

/** Tasks bucketed by status, each bucket sorted by priority, then board position. */
export function groupTasksByStatus(tasks: readonly McpTask[]): Record<McpTaskStatus, McpTask[]> {
  const groups = Object.fromEntries(TASK_STATUS_ORDER.map((status) => [status, [] as McpTask[]])) as Record<
    McpTaskStatus,
    McpTask[]
  >;
  for (const task of tasks) (groups[task.status] ?? groups.todo).push(task);
  for (const status of TASK_STATUS_ORDER) {
    groups[status].sort(
      (left, right) =>
        PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority] ||
        left.position - right.position ||
        taskNumber(left.id) - taskNumber(right.id),
    );
  }
  return groups;
}
