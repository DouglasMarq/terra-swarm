import type { McpTask, McpTaskPriority, McpTaskStatus } from "./mcp.model";

export const MAX_TASK_TITLE_CHARS = 200;

export function taskNumber(id: string): number {
  const value = Number(id.replace(/^T-/i, ""));
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

export const TASK_STATUS_ORDER: readonly McpTaskStatus[] = ["in_progress", "todo", "blocked", "review", "done"];
export const TASK_PRIORITIES: readonly McpTaskPriority[] = ["urgent", "high", "medium", "low"];

const PRIORITY_RANK: Record<McpTaskPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

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
