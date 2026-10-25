// @vitest-environment jsdom

import { act, render, screen, within } from "@testing-library/react";
import type { DragEndEvent } from "@dnd-kit/core";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerInfo, McpTask } from "../../domain/mcp.model";

const api = vi.hoisted(() => ({
  mcpServerInfo: vi.fn(),
  mcpSetEnabled: vi.fn(),
  mcpListTasks: vi.fn(),
  mcpCreateTask: vi.fn(),
  mcpUpdateTask: vi.fn(),
  mcpDeleteTask: vi.fn(),
  mcpAgentStatuses: vi.fn(),
}));

const dnd = vi.hoisted(() => ({ onDragEnd: null as ((event: DragEndEvent) => void) | null }));

vi.mock("@dnd-kit/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dnd-kit/core")>()),
  DndContext: ({ onDragEnd, children }: { onDragEnd?: (event: DragEndEvent) => void; children?: ReactNode }) => {
    dnd.onDragEnd = onDragEnd ?? null;
    return <>{children}</>;
  },
}));

vi.mock("../../lib/tauri/mcp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/tauri/mcp")>()),
  mcpApi: api,
}));

import { useMcpStore } from "../../stores/mcpStore";
import { TaskBoard } from "./TaskBoard";

function task(id: string, extra: Partial<McpTask> = {}): McpTask {
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

function info(extra: Partial<McpServerInfo> = {}): McpServerInfo {
  return { enabled: true, available: true, running: true, url: "http://127.0.0.1:9/mcp", port: 9, db_path: "/tmp/mcp.db", error: null, ...extra };
}

const agents = [
  { id: "t-1", label: "Vega", isRunning: true },
  { id: "t-2", label: "Lyra", isRunning: false },
];

describe("TaskBoard", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    api.mcpServerInfo.mockResolvedValue(info());
    api.mcpAgentStatuses.mockResolvedValue([]);
    api.mcpListTasks.mockResolvedValue([
      task("T-1"),
      task("T-2", { status: "review", assignee: "t-1" }),
      task("T-3", { status: "done" }),
    ]);
  });

  afterEach(() => useMcpStore.getState().reset());

  it("lays the tasks out in workflow columns", async () => {
    render(<TaskBoard workspaceId="ws-1" workspaceName="Alpha" agents={agents} onSendPrompt={vi.fn()} />);
    const todo = await screen.findByRole("region", { name: "A fazer" });
    expect(within(todo).getByText("Task T-1")).toBeTruthy();
    const review = screen.getByRole("region", { name: "Revisão" });
    expect(within(review).getByText("Task T-2")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Concluída" })).getByText("Task T-3")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Em andamento" })).queryAllByRole("article")).toHaveLength(0);
  });

  it("offers only running agents as drop targets", async () => {
    render(<TaskBoard workspaceId="ws-1" agents={agents} onSendPrompt={vi.fn()} />);
    const rail = await screen.findByRole("complementary", { name: "Agentes" });
    expect(within(rail).getByText("Vega")).toBeTruthy();
    expect(within(rail).queryByText("Lyra")).toBeNull();
  });

  it("given the hand-off update fails, keeps the error and types nothing into the agent", async () => {
    api.mcpUpdateTask.mockRejectedValue("task T-1 not found");
    const onSendPrompt = vi.fn().mockResolvedValue(undefined);
    render(<TaskBoard workspaceId="ws-1" agents={agents} onSendPrompt={onSendPrompt} />);
    await screen.findByText("Task T-1");

    await act(async () => dnd.onDragEnd?.(dropOnAgent("T-1", "t-1")));

    expect(await screen.findByRole("alert")).toHaveTextContent("task T-1 not found");
    expect(onSendPrompt).not.toHaveBeenCalled();
  });

  it("given the hand-off update succeeds, types the task into the agent", async () => {
    api.mcpUpdateTask.mockResolvedValue(task("T-1", { status: "in_progress", assignee: "t-1" }));
    const onSendPrompt = vi.fn().mockResolvedValue(undefined);
    render(<TaskBoard workspaceId="ws-1" agents={agents} onSendPrompt={onSendPrompt} />);
    await screen.findByText("Task T-1");

    await act(async () => dnd.onDragEnd?.(dropOnAgent("T-1", "t-1")));

    await vi.waitFor(() => expect(onSendPrompt).toHaveBeenCalledWith("t-1", expect.stringContaining("T-1")));
    expect(api.mcpUpdateTask).toHaveBeenCalledWith("ws-1", "T-1", { assignee: "t-1", status: "in_progress" });
  });
});

const EMPTY_RECT = { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };

function dropOnAgent(taskId: string, terminalId: string): DragEndEvent {
  return {
    active: { id: `task:${taskId}`, data: { current: undefined }, rect: { current: { initial: null, translated: null } } },
    over: { id: `agent:${terminalId}`, rect: EMPTY_RECT, disabled: false, data: { current: undefined } },
    delta: { x: 0, y: 0 },
    collisions: null,
    activatorEvent: new Event("pointerdown"),
  };
}
