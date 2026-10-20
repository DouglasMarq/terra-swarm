// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerInfo, McpTask } from "../../types";

const api = vi.hoisted(() => ({
  mcpServerInfo: vi.fn(),
  mcpSetEnabled: vi.fn(),
  mcpListTasks: vi.fn(),
  mcpCreateTask: vi.fn(),
  mcpUpdateTask: vi.fn(),
  mcpDeleteTask: vi.fn(),
  mcpAgentStatuses: vi.fn(),
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
  { id: "t-1", label: "Vega", running: true },
  { id: "t-2", label: "Lyra", running: false },
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
});
