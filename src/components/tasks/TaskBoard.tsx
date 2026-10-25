import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type CollisionDetection,
  type DragStartEvent,
} from "@dnd-kit/core";
import { Bot, SquareKanban, Plus, Users } from "lucide-react";
import { useT } from "../../i18n";
import { useMcpStore } from "../../stores/mcpStore";
import { useLibraryStore } from "../../stores/libraryStore";
import type { McpAgentStatus, McpTask, McpTaskPatch, McpTaskStatus } from "../../domain/mcp.model";
import { BOARD_COLUMNS, boardColumns, planDrop } from "./boardModel";
import { TaskCard, type TaskAgentOption } from "./TasksPanel";
import { useWorkspaceTasks } from "./useWorkspaceTasks";
import { MAX_TASK_TITLE_CHARS } from "../../domain/tasks";
import "./tasks.css";

const NOTICE_DURATION_MS = 4000;

const collision: CollisionDetection = (args) => {
  const under = pointerWithin(args);
  if (under.length === 0) return closestCorners(args);
  return [...under].sort((left, right) => Number(String(right.id).startsWith("card:")) - Number(String(left.id).startsWith("card:")));
};

export interface BoardAgent extends TaskAgentOption {
  isRunning: boolean;
}

export interface TaskBoardProps {
  workspaceId: string | null;
  workspaceName?: string | null;
  agents: readonly BoardAgent[];
  onSendPrompt: (terminalId: string, prompt: string) => Promise<void>;
}

export function TaskBoard({ workspaceId, workspaceName, agents, onSendPrompt }: TaskBoardProps) {
  const translate = useT();
  const { tasks, statuses, server, error } = useWorkspaceTasks(workspaceId);
  const { createTask, updateTask, deleteTask, clearError } = useMcpStore.getState();
  const [draft, setDraft] = useState("");
  const [dragging, setDragging] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const list = useMemo(() => tasks ?? [], [tasks]);
  const columns = useMemo(() => boardColumns(list), [list]);
  const agentLabel = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.label])), [agents]);
  const labelOf = (id: string) => agentLabel.get(id) ?? id;

  if (!workspaceId) {
    return (
      <div className="terra-tasks-empty">
        <SquareKanban size={18} aria-hidden="true" />
        <span>{translate("tasks.noWorkspace")}</span>
      </div>
    );
  }

  const update = (id: string, patch: McpTaskPatch) => updateTask(workspaceId, id, patch);

  const handOff = async (task: McpTask, agent: BoardAgent) => {
    clearError();
    if (!(await update(task.id, { assignee: agent.id, status: "in_progress" }))) return;
    try {
      await onSendPrompt(agent.id, translate("tasks.board.prompt", { id: task.id, title: task.title }));
      setNotice(translate("tasks.board.handedOff", { id: task.id, agent: agent.label }));
    } catch {
      setNotice(translate("tasks.board.handoffFailed", { id: task.id, agent: agent.label }));
    }
  };

  const onDragStart = (event: DragStartEvent) => setDragging(String(event.active.id).replace(/^task:/, ""));
  const onDragEnd = (event: DragEndEvent) => {
    setDragging(null);
    const task = list.find((candidate) => `task:${candidate.id}` === event.active.id);
    if (!task) return;
    const running = new Set(agents.filter((agent) => agent.isRunning).map((agent) => agent.id));
    const plan = planDrop(task, event.over ? String(event.over.id) : null, { tasks: list, runningAgents: running });
    if (plan?.kind === "update") void update(task.id, plan.patch);
    if (plan?.kind === "handoff") {
      const agent = agents.find((candidate) => candidate.id === plan.terminalId);
      if (agent) void handOff(task, agent);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const title = draft.trim();
    if (!title) return;
    setDraft("");
    void createTask(workspaceId, { title });
  };

  const active = dragging ? list.find((task) => task.id === dragging) ?? null : null;
  const cardProps = (task: McpTask) => ({
    task,
    agents,
    agentLabel: labelOf,
    status: task.assignee ? statuses[task.assignee] : undefined,
    onChange: (patch: McpTaskPatch) => void update(task.id, patch),
    onDelete: () => void deleteTask(workspaceId, task.id),
  });

  return (
    <div className="terra-board" aria-label={translate("tasks.board.label", { name: workspaceName ?? workspaceId })}>
      <header className="terra-board-head">
        <form className="terra-tasks-new" onSubmit={submit}>
          <input
            className="terra-tasks-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={translate("tasks.newPlaceholder")}
            aria-label={translate("tasks.newPlaceholder")}
            maxLength={MAX_TASK_TITLE_CHARS}
          />
          <button className="terra-tasks-add" type="submit" disabled={!draft.trim()} aria-label={translate("tasks.add")} title={translate("tasks.add")}>
            <Plus size={14} aria-hidden="true" />
          </button>
        </form>
        {server && !server.available ? (
          <p className="terra-tasks-notice">{translate("tasks.serverUnavailable")}</p>
        ) : server && !server.enabled ? (
          <p className="terra-tasks-notice">{translate("tasks.serverOff")}</p>
        ) : null}
        {error ? (
          <p className="terra-tasks-error" role="alert">
            {error}
            <button type="button" onClick={clearError}>{translate("tasks.dismiss")}</button>
          </p>
        ) : null}
        {notice ? <p className="terra-board-notice" role="status">{notice}</p> : null}
      </header>
      <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
        <div className="terra-board-body">
          <div className="terra-board-columns">
            {BOARD_COLUMNS.map((status) => (
              <BoardColumn key={status} status={status} count={columns[status].length}>
                {columns[status].map((task) => (
                  <DraggableCard key={task.id} id={task.id}>
                    <TaskCard {...cardProps(task)} />
                  </DraggableCard>
                ))}
              </BoardColumn>
            ))}
          </div>
          <aside className="terra-board-agents" aria-label={translate("tasks.board.agents")}>
            <h3>{translate("tasks.board.agents")}</h3>
            <p className="terra-tasks-hint">{translate("tasks.board.agentsHint")}</p>
            {agents.some((agent) => agent.isRunning) ? null : <p className="terra-tasks-hint">{translate("tasks.board.noAgents")}</p>}
            <button type="button" className="terra-board-team" onClick={() => useLibraryStore.getState().openDialog("team")}>
              <Users size={13} aria-hidden="true" /> {translate("palette.startTeam")}
            </button>
            <ul>
              {agents.filter((agent) => agent.isRunning).map((agent) => (
                <li key={agent.id}>
                  <AgentDrop agent={agent} status={statuses[agent.id]} />
                </li>
              ))}
            </ul>
          </aside>
        </div>
        <DragOverlay>{active ? <div className="terra-board-ghost"><TaskCard {...cardProps(active)} /></div> : null}</DragOverlay>
      </DndContext>
    </div>
  );
}

function BoardColumn({ status, count, children }: { status: McpTaskStatus; count: number; children: ReactNode }) {
  const translate = useT();
  const { setNodeRef, isOver } = useDroppable({ id: `column:${status}` });
  return (
    <section ref={setNodeRef} className="terra-board-column" data-status={status} data-over={isOver} aria-label={translate(`tasks.status.${status}`)}>
      <h3 className="terra-board-column-head">
        <span>{translate(`tasks.status.${status}`)}</span>
        <span className="terra-tasks-count">{count}</span>
      </h3>
      <ul className="terra-tasks-list">{children}</ul>
    </section>
  );
}

function DraggableCard({ id, children }: { id: string; children: ReactNode }) {
  const drag = useDraggable({ id: `task:${id}` });
  const drop = useDroppable({ id: `card:${id}` });
  return (
    <li
      ref={(node) => {
        drag.setNodeRef(node);
        drop.setNodeRef(node);
      }}
      className="terra-board-card"
      data-dragging={drag.isDragging}
      data-over={drop.isOver && !drag.isDragging}
      {...drag.attributes}
      {...drag.listeners}
    >
      {children}
    </li>
  );
}

function AgentDrop({ agent, status }: { agent: BoardAgent; status?: McpAgentStatus }) {
  const translate = useT();
  const { setNodeRef, isOver } = useDroppable({ id: `agent:${agent.id}` });
  return (
    <div ref={setNodeRef} className="terra-board-agent" data-over={isOver} title={status?.summary || undefined}>
      <Bot size={14} aria-hidden="true" />
      <span className="terra-board-agent-name">{agent.label}</span>
      {status ? (
        <span className="terra-task-state">
          <span className="terra-task-dot" data-state={status.state} aria-hidden="true" /> {translate(`tasks.agentState.${status.state}`)}
        </span>
      ) : null}
    </div>
  );
}
