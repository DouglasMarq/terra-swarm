import type { McpTask, McpTaskEvent, McpTaskPatch, McpTaskStatus } from "../../domain/mcp.model";
import { taskNumber } from "../../domain/tasks";
import type { Translate } from "../../i18n";

/** Columns of the Kanban board, in workflow order. */
export const BOARD_COLUMNS: readonly McpTaskStatus[] = ["todo", "in_progress", "blocked", "review", "done"];

/** Tasks per column in manual (drag) order. */
export function boardColumns(tasks: readonly McpTask[]): Record<McpTaskStatus, McpTask[]> {
  const columns = Object.fromEntries(BOARD_COLUMNS.map((status) => [status, [] as McpTask[]])) as Record<McpTaskStatus, McpTask[]>;
  for (const task of tasks) (columns[task.status] ?? columns.todo).push(task);
  for (const status of BOARD_COLUMNS) {
    columns[status].sort((left, right) => left.position - right.position || taskNumber(left.id) - taskNumber(right.id));
  }
  return columns;
}

/**
 * Position for a card dropped into `column`: just before `beforeId` when it
 * was dropped on a card, else at the end. `column` must not contain the
 * dragged card.
 */
export function dropPosition(column: readonly McpTask[], beforeId: string | null): number {
  if (column.length === 0) return 1;
  const index = beforeId ? column.findIndex((task) => task.id === beforeId) : -1;
  if (index < 0) return Math.floor(column[column.length - 1].position) + 1;
  const after = column[index].position;
  const before = index > 0 ? column[index - 1].position : after - 1;
  return (before + after) / 2;
}

export type BoardDrop =
  | { kind: "column"; status: McpTaskStatus; beforeId: string | null }
  | { kind: "agent"; terminalId: string };

/** Decode a dnd-kit droppable id. */
export function parseDropTarget(id: string, tasks: readonly McpTask[]): BoardDrop | null {
  const [kind, value] = [id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1)];
  if (kind === "column" && (BOARD_COLUMNS as readonly string[]).includes(value)) {
    return { kind: "column", status: value as McpTaskStatus, beforeId: null };
  }
  if (kind === "card") {
    const task = tasks.find((candidate) => candidate.id === value);
    return task ? { kind: "column", status: task.status, beforeId: task.id } : null;
  }
  if (kind === "agent" && value) return { kind: "agent", terminalId: value };
  return null;
}

export type DropPlan =
  | { kind: "update"; patch: McpTaskPatch }
  | { kind: "handoff"; terminalId: string }
  | null;

/**
 * What dropping `task` on the droppable `overId` should do. `runningAgents`
 * are the terminals that can take a task right now.
 */
export interface DropBoard {
  tasks: readonly McpTask[];
  runningAgents: ReadonlySet<string>;
}

export function planDrop(task: McpTask, overId: string | null, board: DropBoard): DropPlan {
  const { tasks, runningAgents } = board;
  const target = overId ? parseDropTarget(overId, tasks) : null;
  if (!target) return null;
  if (target.kind === "agent") {
    return runningAgents.has(target.terminalId) ? { kind: "handoff", terminalId: target.terminalId } : null;
  }
  if (target.beforeId === task.id) return null;
  const column = boardColumns(tasks)[target.status].filter((candidate) => candidate.id !== task.id);
  const position = dropPosition(column, target.beforeId);
  if (target.status === task.status) {
    return position === task.position ? null : { kind: "update", patch: { position } };
  }
  return { kind: "update", patch: { status: target.status, position } };
}

/** A task status in the reader's language; text that is not a status is kept as is. */
export function taskStatusLabel(value: string, translate: Translate): string {
  return (BOARD_COLUMNS as readonly string[]).includes(value)
    ? translate(`tasks.status.${value as McpTaskStatus}`)
    : value;
}

/**
 * One history line, in the reader's language. A `status` event's body is the
 * backend's `"from → to"`.
 */
export function describeTaskEvent(
  event: McpTaskEvent,
  translate: Translate,
  agentLabel: (terminalId: string) => string,
): string {
  switch (event.kind) {
    case "created":
      return translate("tasks.event.created");
    case "claimed":
      return translate("tasks.event.claimed");
    case "status": {
      const [from = "", to = ""] = event.body.split("→").map((part) => part.trim());
      return translate("tasks.event.status", { from: taskStatusLabel(from, translate), to: taskStatusLabel(to, translate) });
    }
    case "assigned":
      return event.body
        ? translate("tasks.event.assigned", { who: event.body === "user" ? translate("tasks.you") : agentLabel(event.body) })
        : translate("tasks.event.unassigned");
    case "completed":
      return translate("tasks.event.completed", { summary: event.body });
    default:
      return event.body;
  }
}
