import { describe, expect, it } from "vitest";
import type { McpTask } from "../../types";
import { boardColumns, dropPosition, parseDropTarget, planDrop } from "./boardModel";

function task(id: string, status: McpTask["status"], position: number): McpTask {
  return {
    id, workspace_id: "ws", title: id, description: "", status, assignee: null, created_by: "user",
    priority: "medium", labels: [], position, depends_on: [], blocked_by: [], created_at: 1, updated_at: 1,
  };
}

describe("board model", () => {
  it("orders each column by its manual position", () => {
    const columns = boardColumns([task("T-3", "todo", 2), task("T-1", "todo", 5), task("T-2", "done", 1)]);
    expect(columns.todo.map((t) => t.id)).toEqual(["T-3", "T-1"]);
    expect(columns.done.map((t) => t.id)).toEqual(["T-2"]);
    expect(columns.review).toEqual([]);
  });

  it("drops between neighbours, at the top or at the end", () => {
    const column = [task("a", "todo", 1), task("b", "todo", 2), task("c", "todo", 4)];
    expect(dropPosition(column, "c")).toBe(3);
    expect(dropPosition(column, "a")).toBe(0.5);
    expect(dropPosition(column, null)).toBe(5);
    expect(dropPosition([], null)).toBe(1);
  });

  it("decodes drop targets", () => {
    const tasks = [task("T-1", "review", 1)];
    expect(parseDropTarget("column:done", tasks)).toEqual({ kind: "column", status: "done", beforeId: null });
    expect(parseDropTarget("card:T-1", tasks)).toEqual({ kind: "column", status: "review", beforeId: "T-1" });
    expect(parseDropTarget("agent:t-4", tasks)).toEqual({ kind: "agent", terminalId: "t-4" });
    expect(parseDropTarget("column:nope", tasks)).toBeNull();
    expect(parseDropTarget("card:T-9", tasks)).toBeNull();
  });

  it("plans a drop: move, reorder, hand off or nothing", () => {
    const tasks = [task("T-1", "todo", 1), task("T-2", "todo", 2), task("T-3", "review", 1)];
    const running = new Set(["t-1"]);
    expect(planDrop(tasks[0], "column:review", tasks, running)).toEqual({ kind: "update", patch: { status: "review", position: 2 } });
    expect(planDrop(tasks[1], "card:T-1", tasks, running)).toEqual({ kind: "update", patch: { position: 0.5 } });
    expect(planDrop(tasks[0], "card:T-1", tasks, running)).toBeNull();
    expect(planDrop(tasks[1], "column:todo", tasks, running)).toBeNull();
    expect(planDrop(tasks[0], "agent:t-1", tasks, running)).toEqual({ kind: "handoff", terminalId: "t-1" });
    expect(planDrop(tasks[0], "agent:t-9", tasks, running)).toBeNull();
    expect(planDrop(tasks[0], null, tasks, running)).toBeNull();
  });
});
