// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

vi.mock("../../lib/tauri/mcp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/tauri/mcp")>()),
  mcpApi: api,
}));

import { useMcpStore } from "../../stores/mcpStore";
import { TasksPanel } from "./TasksPanel";

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
  { id: "t-1", label: "Vega" },
  { id: "t-2", label: "Lyra" },
];

describe("TasksPanel", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    api.mcpServerInfo.mockResolvedValue(info());
    api.mcpAgentStatuses.mockResolvedValue([
      { terminal_id: "t-2", workspace_id: "ws-1", state: "working", summary: "on it", updated_at: 1 },
    ]);
  });
  afterEach(() => useMcpStore.getState().reset());

  it("groups the board by status with the assignee and its state", async () => {
    api.mcpListTasks.mockResolvedValue([
      task("T-1", { status: "in_progress", assignee: "t-2", priority: "high" }),
      task("T-2"),
      task("T-3", { status: "done" }),
    ]);
    render(<TasksPanel workspaceId="ws-1" workspaceName="terra" agents={agents} />);

    const inProgress = await screen.findByRole("region", { name: "Em andamento" });
    expect(within(inProgress).getByText("Task T-1")).toBeInTheDocument();
    expect(within(inProgress).getByText("Alta")).toBeInTheDocument();
    const assignee = inProgress.querySelector(".terra-task-assignee");
    expect(assignee).toHaveTextContent("Lyra");
    expect(assignee).toHaveTextContent("trabalhando");
    expect(within(screen.getByRole("region", { name: "A fazer" })).getByText("Task T-2")).toBeInTheDocument();
    // Finished work starts collapsed.
    const done = screen.getByRole("region", { name: "Concluída" });
    expect(within(done).queryByText("Task T-3")).not.toBeInTheDocument();
    expect(api.mcpListTasks).toHaveBeenCalledWith("ws-1");
  });

  it("creates, moves, assigns and deletes tasks", async () => {
    const user = userEvent.setup();
    api.mcpListTasks.mockResolvedValue([task("T-1")]);
    render(<TasksPanel workspaceId="ws-1" agents={agents} />);
    await screen.findByText("Task T-1");

    api.mcpCreateTask.mockResolvedValue(task("T-2", { title: "Write docs", created_by: "user" }));
    await user.type(screen.getByRole("textbox", { name: "Nova tarefa…" }), "Write docs{Enter}");
    expect(api.mcpCreateTask).toHaveBeenCalledWith("ws-1", { title: "Write docs" });
    expect(await screen.findByText("Write docs")).toBeInTheDocument();

    api.mcpUpdateTask.mockResolvedValue(task("T-1", { status: "blocked" }));
    const card = screen.getByText("Task T-1").closest("article")!;
    await user.selectOptions(within(card).getByRole("combobox", { name: "Status" }), "blocked");
    expect(api.mcpUpdateTask).toHaveBeenCalledWith("ws-1", "T-1", { status: "blocked" });
    expect(await screen.findByRole("region", { name: "Bloqueada" })).toHaveTextContent("Task T-1");

    api.mcpUpdateTask.mockResolvedValue(task("T-1", { status: "blocked", assignee: "t-1" }));
    const moved = screen.getByText("Task T-1").closest("article")!;
    await user.selectOptions(within(moved).getByRole("combobox", { name: "Responsável" }), "t-1");
    expect(api.mcpUpdateTask).toHaveBeenLastCalledWith("ws-1", "T-1", { assignee: "t-1" });

    api.mcpDeleteTask.mockResolvedValue(undefined);
    await user.click(screen.getByRole("button", { name: "Excluir a tarefa T-2" }));
    expect(api.mcpDeleteTask).toHaveBeenCalledWith("ws-1", "T-2");
    expect(screen.queryByText("Write docs")).not.toBeInTheDocument();
  });

  it("shows details and the progress log on demand", async () => {
    const user = userEvent.setup();
    api.mcpListTasks.mockResolvedValue([
      task("T-1", {
        description: "Parse the config",
        depends_on: ["T-0"],
        blocked_by: ["T-0"],
        events: [
          { actor: "user", kind: "created", body: "", created_at: 1 },
          { actor: "t-2", kind: "status", body: "todo → blocked", created_at: 2 },
          { actor: "user", kind: "assigned", body: "t-1", created_at: 3 },
          { actor: "t-2", kind: "note", body: "waiting on the lexer", created_at: 4 },
          { actor: "t-2", kind: "completed", body: "parser done", created_at: 5 },
        ],
      }),
    ]);
    render(<TasksPanel workspaceId="ws-1" agents={agents} />);
    await user.click(await screen.findByRole("button", { name: /Task T-1/ }));
    expect(screen.getByText("Parse the config")).toBeInTheDocument();
    expect(screen.getByText("T-0")).toBeInTheDocument();
    expect(screen.getByText("Aguardando T-0")).toBeInTheDocument();
    const history = within(screen.getByRole("list", { name: "Histórico" })).getAllByRole("listitem");
    expect(history.map((item) => item.textContent)).toEqual([
      "você criou a tarefa",
      "Lyra moveu de A fazer para Bloqueada",
      "você atribuiu a Vega",
      "Lyra waiting on the lexer",
      "Lyra entregou: parser done",
    ]);
  });

  it("warns when the server is off and handles no project", async () => {
    api.mcpServerInfo.mockResolvedValue(info({ enabled: false }));
    api.mcpListTasks.mockResolvedValue([]);
    const { rerender } = render(<TasksPanel workspaceId="ws-1" agents={[]} />);
    expect(await screen.findByText(/coordenação de agentes está desligada/)).toBeInTheDocument();
    expect(await screen.findByText(/Nenhuma tarefa ainda/)).toBeInTheDocument();
    rerender(<TasksPanel workspaceId={null} agents={[]} />);
    expect(screen.getByText("Abra um projeto para ver as tarefas dele.")).toBeInTheDocument();
  });

  it("explains when the database could not be opened", async () => {
    api.mcpServerInfo.mockResolvedValue(info({ available: false, enabled: false, error: "migration 1 failed" }));
    api.mcpListTasks.mockRejectedValue("the Terra MCP database is unavailable: migration 1 failed");
    render(<TasksPanel workspaceId="ws-1" agents={[]} />);
    expect(await screen.findByText(/banco da coordenação/)).toBeInTheDocument();
    expect(screen.queryByText(/está desligada/)).not.toBeInTheDocument();
  });
});
