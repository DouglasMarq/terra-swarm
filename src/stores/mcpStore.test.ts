import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpTask } from "../types";

const api = vi.hoisted(() => ({
  mcpServerInfo: vi.fn(),
  mcpSetEnabled: vi.fn(),
  mcpListTasks: vi.fn(),
  mcpCreateTask: vi.fn(),
  mcpUpdateTask: vi.fn(),
  mcpDeleteTask: vi.fn(),
  mcpAgentStatuses: vi.fn(),
}));
const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());

vi.mock("../lib/tauri/mcp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri/mcp")>()),
  mcpApi: api,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  }),
}));

import { groupTasksByStatus, startMcpEventBridge, useMcpStore } from "./mcpStore";

export function makeTask(id: string, extra: Partial<McpTask> = {}): McpTask {
  return {
    id,
    workspace_id: "ws-1",
    title: `Task ${id}`,
    description: "",
    status: "todo",
    assignee: null,
    created_by: "t-1",
    priority: "medium",
    labels: [],
    depends_on: [],
    created_at: 1,
    updated_at: 1,
    notes: [],
    ...extra,
  };
}

describe("groupTasksByStatus", () => {
  it("buckets by status and sorts by priority, then id", () => {
    const groups = groupTasksByStatus([
      makeTask("T-10"),
      makeTask("T-2"),
      makeTask("T-3", { priority: "urgent" }),
      makeTask("T-4", { status: "done" }),
      makeTask("T-5", { status: "in_progress", priority: "low" }),
    ]);
    expect(groups.todo.map((task) => task.id)).toEqual(["T-3", "T-2", "T-10"]);
    expect(groups.done.map((task) => task.id)).toEqual(["T-4"]);
    expect(groups.in_progress.map((task) => task.id)).toEqual(["T-5"]);
    expect(groups.review).toEqual([]);
    expect(groups.blocked).toEqual([]);
  });
});

describe("mcp store", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    listeners.clear();
  });
  afterEach(() => useMcpStore.getState().reset());

  it("loads, creates, updates and deletes tasks per workspace", async () => {
    api.mcpListTasks.mockResolvedValue([makeTask("T-1")]);
    await useMcpStore.getState().loadTasks("ws-1");
    expect(useMcpStore.getState().tasks["ws-1"]).toHaveLength(1);

    api.mcpCreateTask.mockResolvedValue(makeTask("T-2", { created_by: "user" }));
    const created = await useMcpStore.getState().createTask("ws-1", { title: "Task T-2" });
    expect(created?.id).toBe("T-2");
    expect(api.mcpCreateTask).toHaveBeenCalledWith("ws-1", { title: "Task T-2" });

    api.mcpUpdateTask.mockResolvedValue(makeTask("T-1", { status: "blocked", assignee: "t-2" }));
    await useMcpStore.getState().updateTask("ws-1", "T-1", { status: "blocked", assignee: "t-2" });
    const tasks = useMcpStore.getState().tasks["ws-1"]!;
    expect(tasks.find((task) => task.id === "T-1")?.status).toBe("blocked");
    expect(tasks).toHaveLength(2);

    api.mcpDeleteTask.mockResolvedValue(undefined);
    await useMcpStore.getState().deleteTask("ws-1", "T-2");
    expect(useMcpStore.getState().tasks["ws-1"]!.map((task) => task.id)).toEqual(["T-1"]);
  });

  it("keeps errors instead of throwing", async () => {
    api.mcpCreateTask.mockRejectedValue("title cannot be empty");
    expect(await useMcpStore.getState().createTask("ws-1", { title: " " })).toBeNull();
    expect(useMcpStore.getState().error).toBe("title cannot be empty");
    useMcpStore.getState().clearError();
    expect(useMcpStore.getState().error).toBeNull();
  });

  it("refetches open boards and tracks agent statuses from events", async () => {
    api.mcpListTasks.mockResolvedValue([]);
    await useMcpStore.getState().loadTasks("ws-1");
    const stop = startMcpEventBridge();
    await Promise.resolve();

    api.mcpListTasks.mockResolvedValue([makeTask("T-1")]);
    listeners.get("mcp-tasks-changed")?.({ payload: { workspace_id: "ws-1" } });
    listeners.get("mcp-tasks-changed")?.({ payload: { workspace_id: "ws-unopened" } });
    await vi.waitFor(() => expect(useMcpStore.getState().tasks["ws-1"]).toHaveLength(1));
    expect(api.mcpListTasks).not.toHaveBeenCalledWith("ws-unopened");

    const status = { terminal_id: "t-2", workspace_id: "ws-1", state: "working" as const, summary: "x", updated_at: 1 };
    listeners.get("mcp-agent-status")?.({ payload: { workspace_id: "ws-1", terminal_id: "t-2", status } });
    expect(useMcpStore.getState().statuses["t-2"]).toEqual(status);
    listeners.get("mcp-agent-status")?.({ payload: { workspace_id: "ws-1", terminal_id: "t-2", status: null } });
    expect(useMcpStore.getState().statuses["t-2"]).toBeUndefined();
    stop();
  });

  it("toggles the server setting", async () => {
    api.mcpSetEnabled.mockResolvedValue({ enabled: false, running: true, url: "http://127.0.0.1:1/mcp", port: 1 });
    await useMcpStore.getState().setEnabled(false);
    expect(api.mcpSetEnabled).toHaveBeenCalledWith(false);
    expect(useMcpStore.getState().server?.enabled).toBe(false);
  });
});
