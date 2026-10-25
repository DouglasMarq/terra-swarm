import { useMemo, useState, type FormEvent } from "react";
import { ChevronDown, ChevronRight, ListTodo, Plus, Trash2 } from "lucide-react";
import { useT } from "../../i18n";
import { useMcpStore } from "../../stores/mcpStore";
import type { McpAgentStatus, McpTask, McpTaskPatch } from "../../domain/mcp.model";
import { groupTasksByStatus, MAX_TASK_TITLE_CHARS, TASK_PRIORITIES, TASK_STATUS_ORDER } from "../../domain/tasks";
import { describeTaskEvent } from "./boardModel";
import { useWorkspaceTasks } from "./useWorkspaceTasks";
import "./tasks.css";

export interface TaskAgentOption {
  id: string;
  label: string;
}

export interface TasksPanelProps {
  workspaceId: string | null;
  workspaceName?: string | null;
  agents: readonly TaskAgentOption[];
}

export function TasksPanel({ workspaceId, workspaceName, agents }: TasksPanelProps) {
  const translate = useT();
  const { tasks, statuses, server, error } = useWorkspaceTasks(workspaceId);
  const { createTask, updateTask, deleteTask, clearError } = useMcpStore.getState();
  const [draft, setDraft] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ done: true });

  const groups = useMemo(() => groupTasksByStatus(tasks ?? []), [tasks]);
  const agentLabel = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.label])), [agents]);

  if (!workspaceId) {
    return (
      <div className="terra-tasks-empty">
        <ListTodo size={18} aria-hidden="true" />
        <span>{translate("tasks.noWorkspace")}</span>
      </div>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const title = draft.trim();
    if (!title) return;
    setDraft("");
    void createTask(workspaceId, { title });
  };

  const update = (id: string, patch: McpTaskPatch) => void updateTask(workspaceId, id, patch);
  const total = tasks?.length ?? 0;

  return (
    <div className="terra-tasks" aria-label={translate("tasks.label", { name: workspaceName ?? workspaceId })}>
      {server && !server.isAvailable ? (
        <p className="terra-tasks-notice">{translate("tasks.serverUnavailable")}</p>
      ) : server && !server.isEnabled ? (
        <p className="terra-tasks-notice">{translate("tasks.serverOff")}</p>
      ) : null}
      {error ? (
        <p className="terra-tasks-error" role="alert">
          {error}
          <button type="button" onClick={clearError}>{translate("tasks.dismiss")}</button>
        </p>
      ) : null}
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
      {tasks && total === 0 ? <p className="terra-tasks-hint">{translate("tasks.empty")}</p> : null}
      {TASK_STATUS_ORDER.map((status) => {
        const list = groups[status];
        if (list.length === 0) return null;
        const isCollapsed = collapsed[status] === true;
        return (
          <section className="terra-tasks-group" key={status} data-status={status} aria-label={translate(`tasks.status.${status}`)}>
            <button
              type="button"
              className="terra-tasks-group-head"
              aria-expanded={!isCollapsed}
              onClick={() => setCollapsed((state) => ({ ...state, [status]: !isCollapsed }))}
            >
              {isCollapsed ? <ChevronRight size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
              <span>{translate(`tasks.status.${status}`)}</span>
              <span className="terra-tasks-count">{list.length}</span>
            </button>
            {isCollapsed ? null : (
              <ul className="terra-tasks-list">
                {list.map((task) => (
                  <li key={task.id}>
                    <TaskCard
                      task={task}
                      agents={agents}
                      agentLabel={(id) => agentLabel.get(id) ?? id}
                      status={task.assignee ? statuses[task.assignee] : undefined}
                      onChange={(patch) => update(task.id, patch)}
                      onDelete={() => void deleteTask(workspaceId, task.id)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

export interface TaskCardProps {
  task: McpTask;
  agents: readonly TaskAgentOption[];
  agentLabel: (terminalId: string) => string;
  status?: McpAgentStatus;
  onChange: (patch: McpTaskPatch) => void;
  onDelete: () => void;
}

export function TaskCard({ task, agents, agentLabel, status, onChange, onDelete }: TaskCardProps) {
  const translate = useT();
  const [isOpen, setOpen] = useState(false);
  const author = (id: string) => (id === "user" ? translate("tasks.you") : agentLabel(id));
  const isAssigneeKnown = !task.assignee || agents.some((agent) => agent.id === task.assignee);

  return (
    <article className="terra-task" data-priority={task.priority}>
      <button type="button" className="terra-task-title" aria-expanded={isOpen} onClick={() => setOpen(!isOpen)}>
        <span className="terra-task-id">{task.id}</span>
        <span className="terra-task-text">{task.title}</span>
      </button>
      <div className="terra-task-meta">
        {task.priority !== "medium" ? (
          <span className="terra-task-chip" data-priority={task.priority}>{translate(`tasks.priority.${task.priority}`)}</span>
        ) : null}
        {task.assignee ? (
          <span className="terra-task-assignee" title={status?.summary || undefined}>
            <span className="terra-task-dot" data-state={status?.state ?? "unknown"} aria-hidden="true" />
            {agentLabel(task.assignee)}
            {status ? <span className="terra-task-state">· {translate(`tasks.agentState.${status.state}`)}</span> : null}
          </span>
        ) : null}
        {task.blocked_by.length > 0 ? (
          <span className="terra-task-chip" data-blocked="true">{translate("tasks.blockedBy", { ids: task.blocked_by.join(", ") })}</span>
        ) : null}
        {task.labels.map((label) => (
          <span className="terra-task-chip" key={label}>{label}</span>
        ))}
      </div>
      <div className="terra-task-controls">
        <select
          className="terra-task-select"
          aria-label={translate("tasks.moveTo")}
          value={task.status}
          onChange={(event) => onChange({ status: event.target.value as McpTask["status"] })}
        >
          {TASK_STATUS_ORDER.map((status) => (
            <option key={status} value={status}>{translate(`tasks.status.${status}`)}</option>
          ))}
        </select>
        <select
          className="terra-task-select"
          aria-label={translate("tasks.assignee")}
          value={task.assignee ?? ""}
          onChange={(event) => onChange({ assignee: event.target.value || null })}
        >
          <option value="">{translate("tasks.unassigned")}</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>{agent.label}</option>
          ))}
          {isAssigneeKnown ? null : <option value={task.assignee ?? ""}>{task.assignee}</option>}
        </select>
        <button type="button" className="terra-task-delete" onClick={onDelete} aria-label={translate("tasks.delete", { id: task.id })} title={translate("tasks.delete", { id: task.id })}>
          <Trash2 size={13} aria-hidden="true" />
        </button>
      </div>
      {isOpen ? (
        <div className="terra-task-details">
          {task.description ? <p className="terra-task-description">{task.description}</p> : null}
          <dl className="terra-task-facts">
            <dt>{translate("tasks.createdBy")}</dt>
            <dd>{author(task.created_by)}</dd>
            <dt>{translate("tasks.priorityLabel")}</dt>
            <dd>
              <select
                className="terra-task-select"
                aria-label={translate("tasks.priorityLabel")}
                value={task.priority}
                onChange={(event) => onChange({ priority: event.target.value as McpTask["priority"] })}
              >
                {TASK_PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>{translate(`tasks.priority.${priority}`)}</option>
                ))}
              </select>
            </dd>
            {task.depends_on.length > 0 ? (
              <>
                <dt>{translate("tasks.dependsOn")}</dt>
                <dd>{task.depends_on.join(", ")}</dd>
              </>
            ) : null}
          </dl>
          {task.events && task.events.length > 0 ? (
            <ol className="terra-task-log" aria-label={translate("tasks.log")}>
              {task.events.map((event, index) => (
                <li key={`${event.created_at}-${index}`}>
                  <span className="terra-task-log-author">{author(event.actor)}</span>{" "}
                  {describeTaskEvent(event, translate, agentLabel)}
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
