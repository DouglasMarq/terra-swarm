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
import type { McpAgentStatus, McpTask, McpTaskPatch, McpTaskStatus } from "../../types";
import { BOARD_COLUMNS, boardColumns, planDrop } from "./boardModel";
import { TaskCard, type TaskAgentOption } from "./TasksPanel";
import "./tasks.css";

/** What is under the pointer wins; corners only decide in the gaps. */
const collision: CollisionDetection = (args) => {
  const under = pointerWithin(args);
  if (under.length === 0) return closestCorners(args);
  // A card sits inside its column: prefer the innermost target.
  return [...under].sort((a, b) => Number(String(b.id).startsWith("card:")) - Number(String(a.id).startsWith("card:")));
};

export interface BoardAgent extends TaskAgentOption {
  /** Agents that are not running cannot take a task. */
  running: boolean;
}

export interface TaskBoardProps {
  workspaceId: string | null;
  workspaceName?: string | null;
  agents: readonly BoardAgent[];
  /** Hand a task to an agent: type the prompt into its terminal. */
  onSendPrompt: (terminalId: string, prompt: string) => Promise<void>;
}

/**
 * The Kanban of a project's shared tasks. Drag a card between columns to
 * change its status, or onto an agent to assign it and tell the agent to
 * start. Cards move on their own as agents claim and finish work, since the
 * store refetches on every `mcp-tasks-changed` event.
 */
export function TaskBoard({ workspaceId, workspaceName, agents, onSendPrompt }: TaskBoardProps) {
  const t = useT();
  const tasks = useMcpStore((state) => (workspaceId ? state.tasks[workspaceId] : undefined));
  const statuses = useMcpStore((state) => state.statuses);
  const server = useMcpStore((state) => state.server);
  const error = useMcpStore((state) => state.error);
  const { loadTasks, loadStatuses, loadServer, createTask, updateTask, deleteTask, clearError } = useMcpStore.getState();
  const [draft, setDraft] = useState("");
  const [dragging, setDragging] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sensors = useSensors(
    // A short distance keeps the card's own selects and buttons clickable.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );

  useEffect(() => {
    void loadServer();
  }, [loadServer]);

  useEffect(() => {
    if (!workspaceId) return;
    void loadTasks(workspaceId);
    void loadStatuses(workspaceId);
  }, [workspaceId, loadTasks, loadStatuses]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
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
        <span>{t("tasks.noWorkspace")}</span>
      </div>
    );
  }

  const update = (id: string, patch: McpTaskPatch) => updateTask(workspaceId, id, patch);

  const handOff = async (task: McpTask, agent: BoardAgent) => {
    clearError();
    await update(task.id, { assignee: agent.id, status: "in_progress" });
    if (useMcpStore.getState().error) return;
    try {
      await onSendPrompt(agent.id, t("tasks.board.prompt", { id: task.id, title: task.title }));
      setNotice(t("tasks.board.handedOff", { id: task.id, agent: agent.label }));
    } catch {
      setNotice(t("tasks.board.handoffFailed", { id: task.id, agent: agent.label }));
    }
  };

  const onDragStart = (event: DragStartEvent) => setDragging(String(event.active.id).replace(/^task:/, ""));
  const onDragEnd = (event: DragEndEvent) => {
    setDragging(null);
    const task = list.find((candidate) => `task:${candidate.id}` === event.active.id);
    if (!task) return;
    const running = new Set(agents.filter((agent) => agent.running).map((agent) => agent.id));
    const plan = planDrop(task, event.over ? String(event.over.id) : null, list, running);
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
    <div className="terra-board" aria-label={t("tasks.board.label", { name: workspaceName ?? workspaceId })}>
      <header className="terra-board-head">
        <form className="terra-tasks-new" onSubmit={submit}>
          <input
            className="terra-tasks-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t("tasks.newPlaceholder")}
            aria-label={t("tasks.newPlaceholder")}
            maxLength={200}
          />
          <button className="terra-tasks-add" type="submit" disabled={!draft.trim()} aria-label={t("tasks.add")} title={t("tasks.add")}>
            <Plus size={14} aria-hidden="true" />
          </button>
        </form>
        {server && !server.available ? (
          <p className="terra-tasks-notice">{t("tasks.serverUnavailable")}</p>
        ) : server && !server.enabled ? (
          <p className="terra-tasks-notice">{t("tasks.serverOff")}</p>
        ) : null}
        {error ? (
          <p className="terra-tasks-error" role="alert">
            {error}
            <button type="button" onClick={clearError}>{t("tasks.dismiss")}</button>
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
          <aside className="terra-board-agents" aria-label={t("tasks.board.agents")}>
            <h3>{t("tasks.board.agents")}</h3>
            <p className="terra-tasks-hint">{t("tasks.board.agentsHint")}</p>
            {agents.some((agent) => agent.running) ? null : <p className="terra-tasks-hint">{t("tasks.board.noAgents")}</p>}
            <button type="button" className="terra-board-team" onClick={() => useLibraryStore.getState().openDialog("team")}>
              <Users size={13} aria-hidden="true" /> {t("palette.startTeam")}
            </button>
            <ul>
              {agents.filter((agent) => agent.running).map((agent) => (
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
  const t = useT();
  const { setNodeRef, isOver } = useDroppable({ id: `column:${status}` });
  return (
    <section ref={setNodeRef} className="terra-board-column" data-status={status} data-over={isOver} aria-label={t(`tasks.status.${status}`)}>
      <h3 className="terra-board-column-head">
        <span>{t(`tasks.status.${status}`)}</span>
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
  const t = useT();
  const { setNodeRef, isOver } = useDroppable({ id: `agent:${agent.id}` });
  return (
    <div ref={setNodeRef} className="terra-board-agent" data-over={isOver} title={status?.summary || undefined}>
      <Bot size={14} aria-hidden="true" />
      <span className="terra-board-agent-name">{agent.label}</span>
      {status ? (
        <span className="terra-task-state">
          <span className="terra-task-dot" data-state={status.state} aria-hidden="true" /> {t(`tasks.agentState.${status.state}`)}
        </span>
      ) : null}
    </div>
  );
}
