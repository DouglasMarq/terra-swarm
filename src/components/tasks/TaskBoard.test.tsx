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

import userEvent from "@testing-library/user-event";
import { useLibraryStore } from "../../stores/libraryStore";
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
  return { isEnabled: true, isAvailable: true, isRunning: true, url: "http://127.0.0.1:9/mcp", port: 9, dbPath: "/tmp/mcp.db", error: null, ...extra };
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

  it("Given tasks, when the board renders, then they are laid out in workflow columns", async () => {
    render(<TaskBoard workspaceId="ws-1" workspaceName="Alpha" agents={agents} onSendPrompt={vi.fn()} />);
    const todo = await screen.findByRole("region", { name: "A fazer" });
    expect(within(todo).getByText("Task T-1")).toBeTruthy();
    const review = screen.getByRole("region", { name: "Revisão" });
    expect(within(review).getByText("Task T-2")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Concluída" })).getByText("Task T-3")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Em andamento" })).queryAllByRole("article")).toHaveLength(0);
  });

  it("Given agents, when dragging a task, then only running agents are offered as drop targets", async () => {
    render(<TaskBoard workspaceId="ws-1" agents={agents} onSendPrompt={vi.fn()} />);
    const rail = await screen.findByRole("complementary", { name: "Agentes" });
    expect(within(rail).getByText("Vega")).toBeTruthy();
    expect(within(rail).queryByText("Lyra")).toBeNull();
  });

  it("Given the hand-off update fails, when a task is dropped on an agent, then the error is kept and nothing is typed into the agent", async () => {
    api.mcpUpdateTask.mockRejectedValue("task T-1 not found");
    const onSendPrompt = vi.fn().mockResolvedValue(undefined);
    render(<TaskBoard workspaceId="ws-1" agents={agents} onSendPrompt={onSendPrompt} />);
    await screen.findByText("Task T-1");

    await act(async () => dnd.onDragEnd?.(dropOnAgent("T-1", "t-1")));

    expect(await screen.findByRole("alert")).toHaveTextContent("task T-1 not found");
    expect(onSendPrompt).not.toHaveBeenCalled();
  });

  it("Given the hand-off update succeeds, when a task is dropped on an agent, then the task is typed into the agent", async () => {
    api.mcpUpdateTask.mockResolvedValue(task("T-1", { status: "in_progress", assignee: "t-1" }));
    const onSendPrompt = vi.fn().mockResolvedValue(undefined);
    render(<TaskBoard workspaceId="ws-1" agents={agents} onSendPrompt={onSendPrompt} />);
    await screen.findByText("Task T-1");

    await act(async () => dnd.onDragEnd?.(dropOnAgent("T-1", "t-1")));

    await vi.waitFor(() => expect(onSendPrompt).toHaveBeenCalledWith("t-1", expect.stringContaining("T-1")));
    expect(api.mcpUpdateTask).toHaveBeenCalledWith("ws-1", "T-1", { assignee: "t-1", status: "in_progress" });
  });
});

describe("TaskBoard actions", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    api.mcpServerInfo.mockResolvedValue(info());
    api.mcpAgentStatuses.mockResolvedValue([{ terminal_id: "t-1", workspace_id: "ws-1", state: "working", summary: "Writing tests", updated_at: 1 }]);
    api.mcpListTasks.mockResolvedValue([task("T-1"), task("T-2", { status: "review", assignee: "t-1" })]);
    api.mcpUpdateTask.mockImplementation(async (_workspaceId: string, id: string, patch: Partial<McpTask>) => task(id, patch));
    api.mcpCreateTask.mockImplementation(async (_workspaceId: string, input: { title: string }) => task("T-9", { title: input.title }));
    api.mcpDeleteTask.mockResolvedValue(undefined);
  });

  afterEach(() => {
    useMcpStore.getState().reset();
    useLibraryStore.setState({ dialog: null });
    vi.useRealTimers();
  });

  async function renderBoard(onSendPrompt = vi.fn().mockResolvedValue(undefined), boardAgents = agents) {
    render(<TaskBoard workspaceId="ws-1" agents={boardAgents} onSendPrompt={onSendPrompt} />);
    await screen.findByText("Task T-1");
    return { onSendPrompt, user: userEvent.setup() };
  }

  it("Given no project, when the board renders, then it asks for one", () => {
    render(<TaskBoard workspaceId={null} agents={agents} onSendPrompt={vi.fn()} />);

    expect(screen.getByText("Abra um projeto para ver as tarefas dele.")).toBeInTheDocument();
  });

  it("Given a title, when adding a task, then it is created trimmed and the field clears", async () => {
    const { user } = await renderBoard();
    const input = screen.getByRole("textbox", { name: "Nova tarefa…" });

    await user.type(input, "   {Enter}");
    expect(api.mcpCreateTask).not.toHaveBeenCalled();
    await user.type(input, "  Ship the board  ");
    await user.click(screen.getByRole("button", { name: "Adicionar tarefa" }));

    expect(api.mcpCreateTask).toHaveBeenCalledWith("ws-1", { title: "Ship the board" });
    expect(input).toHaveValue("");
    expect(await screen.findByText("Ship the board")).toBeInTheDocument();
  });

  it("Given a task, when it is dropped on a column, then its status moves there", async () => {
    await renderBoard();

    await act(async () => dnd.onDragEnd?.(dropOver("T-1", "column:done")));

    expect(api.mcpUpdateTask).toHaveBeenCalledWith("ws-1", "T-1", expect.objectContaining({ status: "done", position: expect.any(Number) }));
  });

  it("Given a drag that ends nowhere or for an unknown task, when it ends, then nothing changes", async () => {
    await renderBoard();

    await act(async () => dnd.onDragEnd?.(dropOver("T-1", null)));
    await act(async () => dnd.onDragEnd?.(dropOver("T-404", "column:done")));

    expect(api.mcpUpdateTask).not.toHaveBeenCalled();
  });

  it("Given a hand-off that cannot be typed, when a task is dropped on an agent, then the failure is announced and fades", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderBoard(vi.fn().mockRejectedValue(new Error("pty closed")));

    await act(async () => dnd.onDragEnd?.(dropOnAgent("T-1", "t-1")));

    expect(await screen.findByRole("status")).toHaveTextContent("Não foi possível enviar T-1 para Vega");
    await act(async () => vi.advanceTimersByTime(4000));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("Given a task card, when changing its status and deleting it, then the store follows", async () => {
    const { user } = await renderBoard();
    const card = screen.getByText("Task T-1").closest("li");
    if (!card) throw new Error("the task has no card");

    await user.selectOptions(within(card).getByRole("combobox", { name: "Status" }), "done");
    expect(api.mcpUpdateTask).toHaveBeenCalledWith("ws-1", "T-1", { status: "done" });

    await user.click(screen.getByRole("button", { name: "Excluir a tarefa T-2" }));
    expect(api.mcpDeleteTask).toHaveBeenCalledWith("ws-1", "T-2");
  });

  it("Given a running agent with a status, when the board renders, then the rail shows its state and offers a team", async () => {
    const { user } = await renderBoard();
    const rail = screen.getByRole("complementary", { name: "Agentes" });

    expect(await within(rail).findByText(/trabalhando/)).toBeInTheDocument();
    expect(within(rail).queryByText("Nenhum agente rodando neste projeto.")).not.toBeInTheDocument();
    await user.click(within(rail).getByRole("button", { name: /Iniciar um time…/ }));

    expect(useLibraryStore.getState().dialog).toBe("team");
  });

  it("Given no running agent, when the board renders, then the rail says so", async () => {
    await renderBoard(undefined, [{ id: "t-2", label: "Lyra", isRunning: false }]);

    expect(screen.getByText("Nenhum agente rodando neste projeto.")).toBeInTheDocument();
  });

  it("Given the coordination server is off or unavailable, when the board renders, then it explains why", async () => {
    api.mcpServerInfo.mockResolvedValue(info({ isEnabled: false }));
    const view = render(<TaskBoard workspaceId="ws-1" agents={agents} onSendPrompt={vi.fn()} />);
    expect(await screen.findByText(/A coordenação de agentes está desligada/)).toBeInTheDocument();
    view.unmount();
    useMcpStore.getState().reset();

    api.mcpServerInfo.mockResolvedValue(info({ isAvailable: false }));
    render(<TaskBoard workspaceId="ws-1" agents={agents} onSendPrompt={vi.fn()} />);
    expect(await screen.findByText(/Não foi possível abrir o banco da coordenação/)).toBeInTheDocument();
  });

  it("Given a store error, when dismissing it, then it clears", async () => {
    api.mcpDeleteTask.mockRejectedValue("database is locked");
    const { user } = await renderBoard();

    await user.click(screen.getByRole("button", { name: "Excluir a tarefa T-1" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("database is locked");
    await user.click(within(alert).getByRole("button", { name: "Fechar" }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

function dropOver(taskId: string, overId: string | null): DragEndEvent {
  return {
    active: { id: `task:${taskId}`, data: { current: undefined }, rect: { current: { initial: null, translated: null } } },
    over: overId === null ? null : { id: overId, rect: EMPTY_RECT, disabled: false, data: { current: undefined } },
    delta: { x: 0, y: 0 },
    collisions: null,
    activatorEvent: new Event("pointerdown"),
  };
}

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
