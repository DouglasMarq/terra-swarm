import { describe, expect, it } from "vitest";
import { t } from "../../i18n";
import type { McpTask, McpTaskEvent } from "../../types";
import { boardColumns, describeTaskEvent, dropPosition, parseDropTarget, planDrop, taskStatusLabel } from "./boardModel";

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

function event(kind: McpTaskEvent["kind"], body = ""): McpTaskEvent {
  return { actor: "t-1", kind, body, created_at: 1 };
}

const agentLabel = (terminalId: string) => (terminalId === "t-2" ? "Lyra" : terminalId);

describe("taskStatusLabel", () => {
  it("given a task status, names it in the reader's language", () => {
    expect(taskStatusLabel("in_progress", t)).toBe("Em andamento");
  });

  it("given text that is not a status, keeps it", () => {
    expect(taskStatusLabel("archived", t)).toBe("archived");
  });
});

describe("describeTaskEvent", () => {
  it("given a status change from the backend, names both statuses", () => {
    expect(describeTaskEvent(event("status", "todo → in_progress"), t, agentLabel)).toBe("moveu de A fazer para Em andamento");
  });

  it("given an assignment, names the agent or the user, or says it was cleared", () => {
    expect(describeTaskEvent(event("assigned", "t-2"), t, agentLabel)).toBe("atribuiu a Lyra");
    expect(describeTaskEvent(event("assigned", "user"), t, agentLabel)).toBe("atribuiu a você");
    expect(describeTaskEvent(event("assigned"), t, agentLabel)).toBe("removeu o responsável");
  });

  it("given the other kinds, describes them, and keeps a note's text", () => {
    expect(describeTaskEvent(event("created"), t, agentLabel)).toBe("criou a tarefa");
    expect(describeTaskEvent(event("claimed"), t, agentLabel)).toBe("pegou a tarefa");
    expect(describeTaskEvent(event("completed", "tests pass"), t, agentLabel)).toBe("entregou: tests pass");
    expect(describeTaskEvent(event("note", "waiting on review"), t, agentLabel)).toBe("waiting on review");
  });
});
