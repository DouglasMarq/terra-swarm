import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpTask } from "../domain/mcp.model";

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

import { listen } from "@tauri-apps/api/event";
import { groupTasksByStatus } from "../domain/tasks";
import { startMcpEventBridge, useMcpStore } from "./mcpStore";
import { defined } from "../test/defined";

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
    position: 1,
    depends_on: [],
    blocked_by: [],
    created_at: 1,
    updated_at: 1,
    ...extra,
  };
}

describe("groupTasksByStatus", () => {
  it("Given tasks, when grouping them by status, then each bucket is sorted by priority, then position", () => {
    const groups = groupTasksByStatus([
      makeTask("T-10", { position: 1 }),
      makeTask("T-2", { position: 2 }),
      makeTask("T-3", { priority: "urgent" }),
      makeTask("T-4", { status: "done" }),
      makeTask("T-5", { status: "in_progress", priority: "low" }),
    ]);
    expect(groups.todo.map((task) => task.id)).toEqual(["T-3", "T-10", "T-2"]);
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

  it("Given a workspace, when loading, creating, updating and deleting tasks, then each change is kept per workspace", async () => {
    api.mcpListTasks.mockResolvedValue([makeTask("T-1")]);
    await useMcpStore.getState().loadTasks("ws-1");
    expect(useMcpStore.getState().tasks["ws-1"]).toHaveLength(1);

    api.mcpCreateTask.mockResolvedValue(makeTask("T-2", { created_by: "user" }));
    const created = await useMcpStore.getState().createTask("ws-1", { title: "Task T-2" });
    expect(created?.id).toBe("T-2");
    expect(api.mcpCreateTask).toHaveBeenCalledWith("ws-1", { title: "Task T-2" });

    api.mcpUpdateTask.mockResolvedValue(makeTask("T-1", { status: "blocked", assignee: "t-2" }));
    await useMcpStore.getState().updateTask("ws-1", "T-1", { status: "blocked", assignee: "t-2" });
    const tasks = defined(useMcpStore.getState().tasks["ws-1"]);
    expect(tasks.find((task) => task.id === "T-1")?.status).toBe("blocked");
    expect(tasks).toHaveLength(2);

    api.mcpDeleteTask.mockResolvedValue(undefined);
    await useMcpStore.getState().deleteTask("ws-1", "T-2");
    expect(defined(useMcpStore.getState().tasks["ws-1"]).map((task) => task.id)).toEqual(["T-1"]);
  });

  it("Given an update that succeeds, when updating a task, then it resolves to the updated task", async () => {
    const updated = makeTask("T-1", { status: "review" });
    api.mcpUpdateTask.mockResolvedValue(updated);
    expect(await useMcpStore.getState().updateTask("ws-1", "T-1", { status: "review" })).toEqual(updated);
    expect(useMcpStore.getState().error).toBeNull();
  });

  it("Given an update that fails, when updating a task, then it resolves to null and keeps the error", async () => {
    api.mcpUpdateTask.mockRejectedValue("task T-9 not found");
    expect(await useMcpStore.getState().updateTask("ws-1", "T-9", { status: "review" })).toBeNull();
    expect(useMcpStore.getState().error).toBe("task T-9 not found");
  });

  it("Given failing calls, when the store runs them, then errors are kept instead of thrown", async () => {
    api.mcpCreateTask.mockRejectedValue("title cannot be empty");
    expect(await useMcpStore.getState().createTask("ws-1", { title: " " })).toBeNull();
    expect(useMcpStore.getState().error).toBe("title cannot be empty");
    useMcpStore.getState().clearError();
    expect(useMcpStore.getState().error).toBeNull();
  });

  it("Given backend events, when they arrive, then open boards are refetched and agent statuses are tracked", async () => {
    api.mcpListTasks.mockResolvedValue([]);
    await useMcpStore.getState().loadTasks("ws-1");
    const stop = startMcpEventBridge(vi.fn());
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

  it("Given a nudge from the orchestrator, when it arrives, then it is handed to the terminal writer", async () => {
    const onNudge = vi.fn();
    const stop = startMcpEventBridge(onNudge);
    await Promise.resolve();
    listeners.get("mcp-nudge")?.({ payload: { workspace_id: "ws-1", terminal_id: "t-2", prompt: "Do T-1" } });
    listeners.get("mcp-nudge")?.({ payload: { workspace_id: "ws-1", terminal_id: "t-2", prompt: "" } });
    expect(onNudge).toHaveBeenCalledTimes(1);
    expect(onNudge).toHaveBeenCalledWith({ workspace_id: "ws-1", terminal_id: "t-2", prompt: "Do T-1" });
    stop();
  });

  it("Given the server is on, when turning it off, then the backend is told and the store follows", async () => {
    api.mcpSetEnabled.mockResolvedValue({
      enabled: false, available: true, running: true, url: "http://127.0.0.1:1/mcp", port: 1, db_path: "/tmp/mcp.db", error: null,
    });
    await useMcpStore.getState().setEnabled(false);
    expect(api.mcpSetEnabled).toHaveBeenCalledWith(false);
    expect(useMcpStore.getState().server?.enabled).toBe(false);
  });
});

describe("startMcpEventBridge", () => {
  it("Given a listener fails to register, when the bridge is stopped, then it warns instead of swallowing the failure", async () => {
    vi.mocked(listen).mockRejectedValueOnce(new Error("no event bus"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stop = startMcpEventBridge(vi.fn());
    stop();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("failed to stop listening for MCP events:", expect.any(Error)));
    warn.mockRestore();
  });
});
