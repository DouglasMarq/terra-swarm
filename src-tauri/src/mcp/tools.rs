use serde::Deserialize;
use serde_json::{json, Value};
use tauri::Runtime;

use super::messages::{self, InboxRequest, Outgoing};
use super::model::{AgentState, NewTask, StoreError, Task, TaskPatch, TaskPriority, TaskStatus};
use super::model::{DEFAULT_INBOX_LIMIT, DEFAULT_SEARCH_LIMIT, MAX_LIMIT, MAX_TITLE_CHARS};
use super::notes::{self, NoteDraft, NoteSearch};
use super::repo::{StatusFilter, TaskQuery};
use super::statuses::{StatusReport, MAX_STATUS_SUMMARY_CHARS};
use super::tasks::{self, Assignment, Completion, TaskUpdate};
use super::{AgentIdentity, McpHub};

pub struct ToolDef {
    pub name: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub is_read_only: bool,
    pub schema: Value,
}

#[derive(Debug, PartialEq)]
pub enum ToolError {
    UnknownTool(String),
    InvalidArguments(String),
    Store(StoreError),
}

impl std::fmt::Display for ToolError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ToolError::UnknownTool(name) => write!(formatter, "unknown tool `{}`", name),
            ToolError::InvalidArguments(message) => {
                write!(formatter, "invalid arguments: {}", message)
            }
            ToolError::Store(error) => write!(formatter, "{}", error),
        }
    }
}

impl From<StoreError> for ToolError {
    fn from(error: StoreError) -> Self {
        ToolError::Store(error)
    }
}

pub const SERVER_INSTRUCTIONS: &str = "Terra Swarm coordination server. You are one of several \
coding agents working in the same project, each in its own Terra Swarm terminal. Call `whoami` \
first to learn your terminal id and who your teammates are. Use the shared task board to split \
work: `list_tasks` to see what exists, `claim_task` before starting on something (it fails if a \
teammate already took it), `update_task` to log progress or mark a task blocked, and \
`complete_task` when you are done so a human can review it. Check `read_inbox` between steps \
and use `send_message` to coordinate. Save durable project knowledge (commands, conventions, \
decisions) with `add_note` and look it up with `search_notes`. Keep `report_status` current so \
the humans watching the board know what you are doing.";

fn status_values() -> Vec<&'static str> {
    TaskStatus::ALL.map(TaskStatus::as_str).to_vec()
}

fn priority_values_lowest_first() -> Vec<&'static str> {
    TaskPriority::ALL
        .map(TaskPriority::as_str)
        .into_iter()
        .rev()
        .collect()
}

fn state_values() -> Vec<&'static str> {
    AgentState::ALL.map(AgentState::as_str).to_vec()
}

pub fn definitions() -> Vec<ToolDef> {
    vec![
        whoami_tool(),
        list_tasks_tool(),
        get_task_tool(),
        create_task_tool(),
        claim_task_tool(),
        update_task_tool(),
        complete_task_tool(),
        send_message_tool(),
        read_inbox_tool(),
        add_note_tool(),
        search_notes_tool(),
        assign_task_tool(),
        report_status_tool(),
    ]
}

fn whoami_tool() -> ToolDef {
    ToolDef {
        name: "whoami",
        title: "Who am I",
        description: "Returns your own terminal id, agent name and project (workspace), plus \
            the teammates currently connected to this project with their reported state. Call \
            this first: other tools refer to agents by terminal id (for example `t-3`).",
        is_read_only: true,
        schema: json!({ "type": "object", "properties": {} }),
    }
}

fn list_tasks_tool() -> ToolDef {
    ToolDef {
        name: "list_tasks",
        title: "List tasks",
        description: "Lists the tasks on this project's shared board: active work first, then by \
            priority and board position. Filter by `status` and/or `assignee` (a terminal id, \
            or \"me\" for your own tasks). `blocked_by` lists unfinished dependencies: such a \
            task can't be claimed yet. Each entry is a summary; use `get_task` for the \
            description and history.",
        is_read_only: true,
        schema: json!({
            "type": "object",
            "properties": {
                "status": { "type": "string", "enum": status_values() },
                "assignee": { "type": "string", "description": "Terminal id, or \"me\"." }
            }
        }),
    }
}

fn get_task_tool() -> ToolDef {
    ToolDef {
        name: "get_task",
        title: "Get task",
        description: "Returns one task with its full description, dependencies and its latest \
            history `events` (created, claimed, status, assigned, note, completed).",
        is_read_only: true,
        schema: json!({
            "type": "object",
            "properties": { "id": { "type": "string", "description": "Task id, e.g. \"T-4\"." } },
            "required": ["id"]
        }),
    }
}

fn create_task_tool() -> ToolDef {
    ToolDef {
        name: "create_task",
        title: "Create task",
        description: "Adds a task to the shared board in `todo`, unassigned, so any agent can \
            claim it. Split large work into tasks a single agent can finish. `depends_on` \
            lists task ids that must be `done` before this one can be claimed.",
        is_read_only: false,
        schema: json!({
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": format!("Short imperative summary (max {} characters).", MAX_TITLE_CHARS)
                },
                "description": { "type": "string", "description": "What done looks like, relevant files, constraints." },
                "priority": { "type": "string", "enum": priority_values_lowest_first(), "default": "medium" },
                "depends_on": { "type": "array", "items": { "type": "string" } },
                "labels": { "type": "array", "items": { "type": "string" } }
            },
            "required": ["title"]
        }),
    }
}

fn claim_task_tool() -> ToolDef {
    ToolDef {
        name: "claim_task",
        title: "Claim task",
        description: "Assigns a `todo` task to you and moves it to `in_progress`. Claim before \
            you start working on a task. Atomic: if another agent already claimed it, it is \
            not in `todo`, or a dependency is not done yet, this fails and you should pick \
            something else.",
        is_read_only: false,
        schema: json!({
            "type": "object",
            "properties": { "id": { "type": "string" } },
            "required": ["id"]
        }),
    }
}

fn update_task_tool() -> ToolDef {
    ToolDef {
        name: "update_task",
        title: "Update task",
        description: "Changes a task's status and/or adds a note to its history. Use \
            `status: \"blocked\"` with a `note` explaining what you are waiting for. To hand \
            work in, prefer `complete_task`.",
        is_read_only: false,
        schema: json!({
            "type": "object",
            "properties": {
                "id": { "type": "string" },
                "status": { "type": "string", "enum": status_values() },
                "note": { "type": "string", "description": "Progress log entry." }
            },
            "required": ["id"]
        }),
    }
}

fn complete_task_tool() -> ToolDef {
    ToolDef {
        name: "complete_task",
        title: "Complete task",
        description: "Marks your task as finished and moves it to `review` for a human to \
            check, recording `summary` (what changed, how it was verified) in the log. Only \
            the assignee can complete an assigned task.",
        is_read_only: false,
        schema: json!({
            "type": "object",
            "properties": {
                "id": { "type": "string" },
                "summary": { "type": "string" }
            },
            "required": ["id", "summary"]
        }),
    }
}

fn send_message_tool() -> ToolDef {
    ToolDef {
        name: "send_message",
        title: "Send message",
        description: "Sends a message to a teammate by terminal id (see `whoami`), or to \
            \"all\" to broadcast to every agent in this project. Messages are delivered \
            through the recipient's `read_inbox`.",
        is_read_only: false,
        schema: json!({
            "type": "object",
            "properties": {
                "to": { "type": "string", "description": "Terminal id or \"all\"." },
                "body": { "type": "string" }
            },
            "required": ["to", "body"]
        }),
    }
}

fn read_inbox_tool() -> ToolDef {
    ToolDef {
        name: "read_inbox",
        title: "Read inbox",
        description: "Returns messages sent to you or to \"all\", oldest first (at most \
            `limit`, default 50), and marks them as read. By default only unread messages \
            are returned; pass `unread_only: false` to see the history too.",
        is_read_only: false,
        schema: json!({
            "type": "object",
            "properties": {
                "unread_only": { "type": "boolean", "default": true },
                "limit": { "type": "integer", "minimum": 1, "maximum": MAX_LIMIT, "default": DEFAULT_INBOX_LIMIT }
            }
        }),
    }
}

fn add_note_tool() -> ToolDef {
    ToolDef {
        name: "add_note",
        title: "Add note",
        description: "Saves a note to this project's shared memory, visible to every agent \
            now and in later sessions. Use it for facts worth keeping: commands, conventions, \
            decisions, gotchas. Giving a `key` (e.g. \"test-command\") replaces the earlier \
            note with the same key.",
        is_read_only: false,
        schema: json!({
            "type": "object",
            "properties": {
                "body": { "type": "string" },
                "key": { "type": "string", "description": "Optional stable name for the note." }
            },
            "required": ["body"]
        }),
    }
}

fn search_notes_tool() -> ToolDef {
    ToolDef {
        name: "search_notes",
        title: "Search notes",
        description: "Full-text search over the project's shared notes (key and text). Every \
            word must match, as a prefix, ignoring case and accents; best matches first, at \
            most `limit` (default 20). An empty query lists the most recently updated notes.",
        is_read_only: true,
        schema: json!({
            "type": "object",
            "properties": {
                "query": { "type": "string" },
                "limit": { "type": "integer", "minimum": 1, "maximum": MAX_LIMIT, "default": DEFAULT_SEARCH_LIMIT }
            },
            "required": ["query"]
        }),
    }
}

fn assign_task_tool() -> ToolDef {
    ToolDef {
        name: "assign_task",
        title: "Assign task",
        description: "Orchestrator only. Hands a task to a teammate: makes them the assignee, \
            moves a `todo` task to `in_progress`, puts the task (and your optional `note`) in \
            their inbox, and, when they are idle, types a prompt into their terminal so they \
            start right away. A task with unfinished dependencies cannot be assigned yet.",
        is_read_only: false,
        schema: json!({
            "type": "object",
            "properties": {
                "id": { "type": "string", "description": "Task id, e.g. \"T-4\"." },
                "to": { "type": "string", "description": "Teammate's terminal id (see `whoami`)." },
                "note": { "type": "string", "description": "Extra guidance for the teammate." }
            },
            "required": ["id", "to"]
        }),
    }
}

fn report_status_tool() -> ToolDef {
    ToolDef {
        name: "report_status",
        title: "Report status",
        description: "Tells your teammates and the humans watching what you are doing: \
            `working`, `idle`, `needs_input` (waiting for a human) or `blocked`, with a \
            one-line `summary`. Update it when your state changes.",
        is_read_only: false,
        schema: json!({
            "type": "object",
            "properties": {
                "state": { "type": "string", "enum": state_values() },
                "summary": {
                    "type": "string",
                    "description": format!("One line, max {} characters.", MAX_STATUS_SUMMARY_CHARS)
                }
            },
            "required": ["state", "summary"]
        }),
    }
}

fn parse<T: for<'de> Deserialize<'de>>(args: Value) -> Result<T, ToolError> {
    let args = if args.is_null() { json!({}) } else { args };
    serde_json::from_value(args).map_err(|error| ToolError::InvalidArguments(error.to_string()))
}

fn status_arg(value: Option<String>) -> Result<Option<TaskStatus>, ToolError> {
    value
        .map(|raw| {
            TaskStatus::parse(raw.trim()).ok_or_else(|| {
                ToolError::InvalidArguments(format!(
                    "status must be one of {}",
                    status_values().join(", ")
                ))
            })
        })
        .transpose()
}

fn task_summary(task: &Task) -> Value {
    json!({
        "id": task.id,
        "title": task.title,
        "status": task.status,
        "assignee": task.assignee,
        "priority": task.priority,
        "labels": task.labels,
        "position": task.position,
        "depends_on": task.depends_on,
        "blocked_by": task.blocked_by,
        "updated_at": task.updated_at,
    })
}

#[derive(Deserialize)]
struct ListTasksArgs {
    status: Option<String>,
    assignee: Option<String>,
}

#[derive(Deserialize)]
struct IdArgs {
    id: String,
}

#[derive(Deserialize)]
struct CreateTaskArgs {
    title: String,
    description: Option<String>,
    priority: Option<String>,
    #[serde(default)]
    depends_on: Vec<String>,
    #[serde(default)]
    labels: Vec<String>,
}

#[derive(Deserialize)]
struct UpdateTaskArgs {
    id: String,
    status: Option<String>,
    note: Option<String>,
}

#[derive(Deserialize)]
struct CompleteTaskArgs {
    id: String,
    summary: String,
}

#[derive(Deserialize)]
struct AssignTaskArgs {
    id: String,
    to: String,
    #[serde(default)]
    note: Option<String>,
}

#[derive(Deserialize)]
struct SendMessageArgs {
    to: String,
    body: String,
}

#[derive(Deserialize)]
struct ReadInboxArgs {
    unread_only: Option<bool>,
    limit: Option<usize>,
}

#[derive(Deserialize)]
struct AddNoteArgs {
    body: String,
    key: Option<String>,
}

#[derive(Deserialize)]
struct SearchNotesArgs {
    #[serde(default)]
    query: String,
    limit: Option<usize>,
}

#[derive(Deserialize)]
struct ReportStatusArgs {
    state: String,
    #[serde(default)]
    summary: String,
}

pub struct ToolCall<'a> {
    pub name: &'a str,
    pub args: Value,
}

type Handler<R> = fn(&McpHub<R>, &AgentIdentity, Value) -> Result<Value, ToolError>;

fn handlers<R: Runtime>() -> [(&'static str, Handler<R>); 13] {
    [
        ("whoami", whoami),
        ("list_tasks", list_tasks),
        ("get_task", get_task),
        ("create_task", create_task),
        ("claim_task", claim_task),
        ("update_task", update_task),
        ("complete_task", complete_task),
        ("send_message", send_message),
        ("assign_task", assign_task),
        ("read_inbox", read_inbox),
        ("add_note", add_note),
        ("search_notes", search_notes),
        ("report_status", report_status),
    ]
}

pub fn call<R: Runtime>(
    hub: &McpHub<R>,
    who: &AgentIdentity,
    request: ToolCall<'_>,
) -> Result<Value, ToolError> {
    let (_, handler) = handlers::<R>()
        .into_iter()
        .find(|(tool, _)| *tool == request.name)
        .ok_or_else(|| ToolError::UnknownTool(request.name.to_string()))?;
    handler(hub, who, request.args)
}

fn peer_summaries<R: Runtime>(
    hub: &McpHub<R>,
    who: &AgentIdentity,
) -> Result<Vec<Value>, ToolError> {
    let statuses = hub.statuses()?;
    Ok(hub
        .peers(&who.workspace_id)
        .into_iter()
        .filter(|peer| peer.terminal_id != who.terminal_id)
        .map(|peer| {
            let status = statuses.status_of(&peer.terminal_id);
            json!({
                "terminal_id": peer.terminal_id,
                "agent": peer.agent,
                "role": peer.role,
                "state": status.map(|status| status.state),
                "summary": status.map(|status| status.summary.clone()),
                "updated_at": status.map(|status| status.updated_at),
            })
        })
        .collect())
}

fn whoami<R: Runtime>(
    hub: &McpHub<R>,
    who: &AgentIdentity,
    _args: Value,
) -> Result<Value, ToolError> {
    let workspace_id = who.workspace_id.as_str();
    let me = who.terminal_id.as_str();
    let workspace = hub.workspace(workspace_id);
    let peers = peer_summaries(hub, who)?;
    let repo = hub.repo()?;
    let mine = repo.queries().list_tasks(&TaskQuery {
        status: StatusFilter::Unfinished,
        assignee: Some(me),
        ..TaskQuery::all(workspace_id)
    })?;
    Ok(json!({
        "terminal_id": me,
        "agent": who.agent,
        "role": who.role,
        "role_instructions": who.role.map(|role| role.instructions()),
        "workspace_id": workspace_id,
        "workspace_name": workspace.as_ref().map(|info| info.name.clone()),
        "workspace_cwd": workspace.as_ref().map(|info| info.cwd.clone()),
        "unread_messages": repo.queries().unread_count(workspace_id, me)?,
        "my_open_tasks": mine.iter().map(task_summary).collect::<Vec<_>>(),
        "peers": peers,
    }))
}

fn list_tasks<R: Runtime>(
    hub: &McpHub<R>,
    who: &AgentIdentity,
    args: Value,
) -> Result<Value, ToolError> {
    let args: ListTasksArgs = parse(args)?;
    let status = status_arg(args.status)?;
    let assignee = args
        .assignee
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(|value| {
            if value == "me" {
                who.terminal_id.clone()
            } else {
                value
            }
        });
    let tasks = hub.repo()?.queries().list_tasks(&TaskQuery {
        status: status.map_or(StatusFilter::Any, StatusFilter::Is),
        assignee: assignee.as_deref(),
        ..TaskQuery::all(&who.workspace_id)
    })?;
    Ok(json!({
        "tasks": tasks.iter().map(task_summary).collect::<Vec<_>>(),
    }))
}

fn get_task<R: Runtime>(
    hub: &McpHub<R>,
    who: &AgentIdentity,
    args: Value,
) -> Result<Value, ToolError> {
    let args: IdArgs = parse(args)?;
    let task = tasks::get(&*hub.repo()?, &who.workspace_id, &args.id)?;
    Ok(json!(task))
}

fn priority_arg(value: Option<String>) -> Result<Option<TaskPriority>, ToolError> {
    value
        .map(|raw| {
            TaskPriority::parse(raw.trim()).ok_or_else(|| {
                ToolError::InvalidArguments(format!(
                    "priority must be one of {}",
                    priority_values_lowest_first().join(", ")
                ))
            })
        })
        .transpose()
}

fn create_task<R: Runtime>(
    hub: &McpHub<R>,
    who: &AgentIdentity,
    args: Value,
) -> Result<Value, ToolError> {
    let args: CreateTaskArgs = parse(args)?;
    let priority = priority_arg(args.priority)?;
    let task = tasks::create(
        &mut *hub.repo()?,
        &who.actor(),
        NewTask {
            title: args.title,
            description: args.description,
            priority,
            labels: args.labels,
            depends_on: args.depends_on,
            assignee: None,
        },
    )?;
    hub.emit_tasks_changed(&who.workspace_id);
    Ok(json!(task))
}

fn claim_task<R: Runtime>(
    hub: &McpHub<R>,
    who: &AgentIdentity,
    args: Value,
) -> Result<Value, ToolError> {
    let args: IdArgs = parse(args)?;
    let task = tasks::claim(&mut *hub.repo()?, &who.actor(), &args.id)?;
    hub.emit_tasks_changed(&who.workspace_id);
    Ok(json!(task))
}

fn update_task<R: Runtime>(
    hub: &McpHub<R>,
    who: &AgentIdentity,
    args: Value,
) -> Result<Value, ToolError> {
    let args: UpdateTaskArgs = parse(args)?;
    let status = status_arg(args.status)?;
    if status.is_none()
        && args
            .note
            .as_deref()
            .is_none_or(|note| note.trim().is_empty())
    {
        return Err(ToolError::InvalidArguments(
            "pass a status, a note, or both".into(),
        ));
    }
    let task = tasks::update(
        &mut *hub.repo()?,
        &who.actor(),
        TaskUpdate {
            id: &args.id,
            patch: TaskPatch {
                status,
                note: args.note,
                ..TaskPatch::default()
            },
        },
    )?;
    hub.emit_tasks_changed(&who.workspace_id);
    Ok(json!(task))
}

fn complete_task<R: Runtime>(
    hub: &McpHub<R>,
    who: &AgentIdentity,
    args: Value,
) -> Result<Value, ToolError> {
    let args: CompleteTaskArgs = parse(args)?;
    let completion = Completion {
        id: &args.id,
        summary: &args.summary,
    };
    let task = tasks::complete(&mut *hub.repo()?, &who.actor(), &completion)?;
    hub.emit_tasks_changed(&who.workspace_id);
    Ok(json!(task))
}

fn ensure_known_recipient<R: Runtime>(
    hub: &McpHub<R>,
    who: &AgentIdentity,
    to: &str,
) -> Result<(), ToolError> {
    let workspace_id = who.workspace_id.as_str();
    if to == who.terminal_id {
        return Err(ToolError::InvalidArguments(
            "you cannot send a message to yourself".into(),
        ));
    }
    let is_known = to == "all"
        || hub
            .peers(workspace_id)
            .iter()
            .any(|peer| peer.terminal_id == to)
        || hub
            .workspace_terminals(workspace_id)
            .iter()
            .any(|id| id == to);
    if !is_known {
        return Err(ToolError::InvalidArguments(format!(
            "`{}` is not a terminal of this project; use a terminal id from `whoami` \
             or \"all\"",
            to
        )));
    }
    Ok(())
}

fn send_message<R: Runtime>(
    hub: &McpHub<R>,
    who: &AgentIdentity,
    args: Value,
) -> Result<Value, ToolError> {
    let args: SendMessageArgs = parse(args)?;
    let to = args.to.trim();
    ensure_known_recipient(hub, who, to)?;
    let outgoing = Outgoing {
        to,
        body: &args.body,
    };
    let message = messages::send(hub.repo()?.queries(), &who.actor(), &outgoing)?;
    hub.emit_message(&message);
    Ok(json!(message))
}

fn ensure_can_assign_to<R: Runtime>(
    hub: &McpHub<R>,
    who: &AgentIdentity,
    to: &str,
) -> Result<(), ToolError> {
    if !who.role.is_some_and(|role| role.can_assign()) {
        return Err(ToolError::InvalidArguments(
            "only the team's orchestrator can assign tasks; claim one with `claim_task` \
             or message the orchestrator"
                .into(),
        ));
    }
    if to == who.terminal_id {
        return Err(ToolError::InvalidArguments(
            "assign tasks to teammates, not to yourself".into(),
        ));
    }
    let is_teammate = hub
        .peers(&who.workspace_id)
        .iter()
        .any(|peer| peer.terminal_id == to);
    if !is_teammate {
        return Err(ToolError::InvalidArguments(format!(
            "`{}` is not a running teammate in this project; see `whoami`",
            to
        )));
    }
    Ok(())
}

fn is_idle<R: Runtime>(hub: &McpHub<R>, terminal_id: &str) -> Result<bool, ToolError> {
    Ok(hub
        .statuses()?
        .status_of(terminal_id)
        .is_some_and(|status| status.state == AgentState::Idle))
}

fn assignment_prompt(task: &Task, by: &str) -> String {
    format!(
        "Task {} on the Terra board was assigned to you by {}: \"{}\". Read it with the get_task tool and your inbox with read_inbox, do the work, then hand it in with complete_task.",
        task.id, by, task.title
    )
}

fn assign_task<R: Runtime>(
    hub: &McpHub<R>,
    who: &AgentIdentity,
    args: Value,
) -> Result<Value, ToolError> {
    let args: AssignTaskArgs = parse(args)?;
    let to = args.to.trim();
    ensure_can_assign_to(hub, who, to)?;
    let assignment = Assignment {
        id: &args.id,
        to,
        note: args.note.as_deref(),
    };
    let (task, message) = tasks::assign(&mut *hub.repo()?, &who.actor(), &assignment)?;
    let is_target_idle = is_idle(hub, to)?;
    hub.emit_tasks_changed(&who.workspace_id);
    hub.emit_message(&message);
    if is_target_idle {
        let prompt = assignment_prompt(&task, &who.terminal_id);
        hub.emit_nudge(&who.workspace_id, to, &prompt);
    }
    Ok(json!({ "task": task, "woken": is_target_idle }))
}

fn read_inbox<R: Runtime>(
    hub: &McpHub<R>,
    who: &AgentIdentity,
    args: Value,
) -> Result<Value, ToolError> {
    let args: ReadInboxArgs = parse(args)?;
    let request = InboxRequest {
        is_unread_only: args.unread_only.unwrap_or(true),
        limit: args.limit,
    };
    let messages = messages::read_inbox(&mut *hub.repo()?, &who.actor(), &request)?;
    Ok(json!({ "messages": messages }))
}

fn add_note<R: Runtime>(
    hub: &McpHub<R>,
    who: &AgentIdentity,
    args: Value,
) -> Result<Value, ToolError> {
    let args: AddNoteArgs = parse(args)?;
    let draft = NoteDraft {
        key: args.key.as_deref(),
        body: &args.body,
    };
    let note = notes::add(hub.repo()?.queries(), &who.actor(), &draft)?;
    Ok(json!(note))
}

fn search_notes<R: Runtime>(
    hub: &McpHub<R>,
    who: &AgentIdentity,
    args: Value,
) -> Result<Value, ToolError> {
    let args: SearchNotesArgs = parse(args)?;
    let search = NoteSearch {
        query: &args.query,
        limit: args.limit,
    };
    let notes = notes::search(hub.repo()?.queries(), &who.workspace_id, &search)?;
    Ok(json!({ "notes": notes }))
}

fn report_status<R: Runtime>(
    hub: &McpHub<R>,
    who: &AgentIdentity,
    args: Value,
) -> Result<Value, ToolError> {
    let args: ReportStatusArgs = parse(args)?;
    let state = AgentState::parse(args.state.trim()).ok_or_else(|| {
        ToolError::InvalidArguments(format!(
            "state must be one of {}",
            state_values().join(", ")
        ))
    })?;
    let status = hub.statuses()?.report_status(
        &who.actor(),
        &StatusReport {
            state,
            summary: &args.summary,
        },
    )?;
    hub.emit_agent_status(&status);
    Ok(json!(status))
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{hub, identity};
    use super::super::{EVENT_AGENT_STATUS, EVENT_MESSAGE, EVENT_NUDGE, EVENT_TASKS_CHANGED};
    use super::*;
    use crate::roles::Role;

    #[test]
    fn given_the_model_enums_when_listing_their_values_then_the_documented_order_is_kept() {
        assert_eq!(
            status_values(),
            ["todo", "in_progress", "review", "done", "blocked"]
        );
        assert_eq!(
            priority_values_lowest_first(),
            ["low", "medium", "high", "urgent"]
        );
        assert_eq!(
            state_values(),
            ["working", "idle", "needs_input", "blocked"]
        );
    }

    #[test]
    fn given_the_tool_list_when_inspecting_it_then_every_tool_has_an_object_schema_and_a_handler() {
        let (hub, _) = hub();
        let who = identity("t-1", "ws-1", "claude");
        let defs = definitions();
        assert_eq!(defs.len(), 13);
        for def in &defs {
            assert_eq!(def.schema["type"], "object", "{}", def.name);
            assert!(def.description.len() > 40, "{}", def.name);
            let result = call(
                &hub,
                &who,
                ToolCall {
                    name: def.name,
                    args: json!({}),
                },
            );
            assert!(
                !matches!(result, Err(ToolError::UnknownTool(_))),
                "{} has no handler",
                def.name
            );
        }
        assert_eq!(
            call(
                &hub,
                &who,
                ToolCall {
                    name: "nope",
                    args: json!({})
                }
            ),
            Err(ToolError::UnknownTool("nope".into()))
        );
    }

    #[test]
    fn given_two_agents_when_using_the_board_then_they_coordinate_through_it() {
        let (hub, events) = hub();
        hub.issue(identity("t-1", "ws-1", "claude")).unwrap();
        hub.issue(identity("t-2", "ws-1", "claude")).unwrap();
        let lead = identity("t-1", "ws-1", "claude");
        let helper = identity("t-2", "ws-1", "claude");

        let task = call(
            &hub,
            &lead,
            ToolCall {
                name: "create_task",
                args: json!({ "title": "Add login form", "priority": "high" }),
            },
        )
        .unwrap();
        assert_eq!(task["id"], "T-1");
        assert_eq!(task["created_by"], "t-1");
        call(
            &hub,
            &lead,
            ToolCall {
                name: "send_message",
                args: json!({ "to": "t-2", "body": "T-1 is yours" }),
            },
        )
        .unwrap();

        let me = call(
            &hub,
            &helper,
            ToolCall {
                name: "whoami",
                args: Value::Null,
            },
        )
        .unwrap();
        assert_eq!(me["terminal_id"], "t-2");
        assert_eq!(me["workspace_name"], "ws-1 project");
        assert_eq!(me["unread_messages"], 1);
        assert_eq!(me["peers"][0]["terminal_id"], "t-1");

        let inbox = call(
            &hub,
            &helper,
            ToolCall {
                name: "read_inbox",
                args: json!({}),
            },
        )
        .unwrap();
        assert_eq!(inbox["messages"][0]["body"], "T-1 is yours");
        assert_eq!(
            call(
                &hub,
                &helper,
                ToolCall {
                    name: "read_inbox",
                    args: json!({})
                }
            )
            .unwrap()["messages"],
            json!([])
        );

        let claimed = call(
            &hub,
            &helper,
            ToolCall {
                name: "claim_task",
                args: json!({ "id": "T-1" }),
            },
        )
        .unwrap();
        assert_eq!(claimed["assignee"], "t-2");
        assert!(call(
            &hub,
            &lead,
            ToolCall {
                name: "claim_task",
                args: json!({ "id": "T-1" })
            }
        )
        .is_err());

        let mine = call(
            &hub,
            &helper,
            ToolCall {
                name: "list_tasks",
                args: json!({ "assignee": "me" }),
            },
        )
        .unwrap();
        assert_eq!(mine["tasks"].as_array().unwrap().len(), 1);

        let done = call(
            &hub,
            &helper,
            ToolCall {
                name: "complete_task",
                args: json!({ "id": "T-1", "summary": "form + tests" }),
            },
        )
        .unwrap();
        assert_eq!(done["status"], "review");

        let full = call(
            &hub,
            &lead,
            ToolCall {
                name: "get_task",
                args: json!({ "id": "1" }),
            },
        )
        .unwrap();
        let kinds: Vec<&str> = full["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|event| event["kind"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, vec!["created", "claimed", "completed"]);

        call(
            &hub,
            &lead,
            ToolCall {
                name: "create_task",
                args: json!({ "title": "Ship", "depends_on": ["T-1"] }),
            },
        )
        .unwrap();
        let listed = call(
            &hub,
            &lead,
            ToolCall {
                name: "list_tasks",
                args: json!({ "status": "todo" }),
            },
        )
        .unwrap();
        assert_eq!(listed["tasks"][0]["blocked_by"], json!(["T-1"]));
        assert!(listed["tasks"][0].get("events").is_none());
        assert!(call(
            &hub,
            &helper,
            ToolCall {
                name: "claim_task",
                args: json!({ "id": "T-2" })
            }
        )
        .is_err());

        let events = events.lock().unwrap();
        assert!(
            events
                .iter()
                .filter(|(event, _)| event == EVENT_TASKS_CHANGED)
                .count()
                >= 3
        );
        assert!(events
            .iter()
            .any(|(event, payload)| event == EVENT_MESSAGE && payload["to"] == "t-2"));
    }

    #[test]
    fn given_agents_in_several_workspaces_when_calling_tools_then_they_are_scoped_to_the_callers_workspace(
    ) {
        let (hub, _) = hub();
        hub.issue(identity("t-1", "ws-1", "claude")).unwrap();
        hub.issue(identity("t-5", "ws-2", "codex")).unwrap();
        let one = identity("t-1", "ws-1", "claude");
        let other = identity("t-5", "ws-2", "codex");

        call(
            &hub,
            &one,
            ToolCall {
                name: "create_task",
                args: json!({ "title": "private" }),
            },
        )
        .unwrap();
        call(
            &hub,
            &one,
            ToolCall {
                name: "add_note",
                args: json!({ "body": "secret sauce" }),
            },
        )
        .unwrap();
        assert_eq!(
            call(
                &hub,
                &other,
                ToolCall {
                    name: "list_tasks",
                    args: json!({})
                }
            )
            .unwrap()["tasks"],
            json!([])
        );
        assert!(call(
            &hub,
            &other,
            ToolCall {
                name: "get_task",
                args: json!({ "id": "T-1" })
            }
        )
        .is_err());
        assert_eq!(
            call(
                &hub,
                &other,
                ToolCall {
                    name: "search_notes",
                    args: json!({ "query": "secret" })
                }
            )
            .unwrap()["notes"],
            json!([])
        );
        assert!(call(
            &hub,
            &other,
            ToolCall {
                name: "send_message",
                args: json!({ "to": "t-1", "body": "hi" })
            }
        )
        .is_err());
        assert_eq!(
            call(
                &hub,
                &other,
                ToolCall {
                    name: "whoami",
                    args: json!({})
                }
            )
            .unwrap()["peers"],
            json!([])
        );
    }

    #[test]
    fn given_a_task_of_another_workspace_when_calling_any_task_tool_then_it_reports_not_found_and_changes_nothing(
    ) {
        let (hub, _) = hub();
        let owner = identity("t-1", "ws-1", "claude");
        let lead = AgentIdentity {
            role: Some(Role::Orchestrator),
            ..identity("t-5", "ws-2", "codex")
        };
        hub.issue(owner.clone()).unwrap();
        hub.issue(lead.clone()).unwrap();
        hub.issue(identity("t-6", "ws-2", "codex")).unwrap();
        call(
            &hub,
            &owner,
            ToolCall {
                name: "create_task",
                args: json!({ "title": "private" }),
            },
        )
        .unwrap();

        let attempts = [
            ("get_task", json!({ "id": "T-1" })),
            ("claim_task", json!({ "id": "T-1" })),
            (
                "update_task",
                json!({ "id": "T-1", "status": "done", "note": "mine" }),
            ),
            ("complete_task", json!({ "id": "T-1", "summary": "done" })),
            ("assign_task", json!({ "id": "T-1", "to": "t-6" })),
        ];
        for (tool, args) in attempts {
            assert!(
                matches!(
                    call(&hub, &lead, ToolCall { name: tool, args }),
                    Err(ToolError::Store(StoreError::NotFound(_)))
                ),
                "{}",
                tool
            );
        }

        let task = call(
            &hub,
            &owner,
            ToolCall {
                name: "get_task",
                args: json!({ "id": "T-1" }),
            },
        )
        .unwrap();
        assert_eq!(task["status"], "todo");
        assert_eq!(task["assignee"], Value::Null);
        assert_eq!(task["events"].as_array().unwrap().len(), 1);
        let helper = identity("t-6", "ws-2", "codex");
        assert_eq!(
            call(
                &hub,
                &helper,
                ToolCall {
                    name: "read_inbox",
                    args: json!({})
                }
            )
            .unwrap()["messages"],
            json!([])
        );
    }

    #[test]
    fn given_invalid_arguments_when_calling_tools_then_they_are_reported() {
        let (hub, _) = hub();
        let who = identity("t-1", "ws-1", "claude");
        assert!(matches!(
            call(
                &hub,
                &who,
                ToolCall {
                    name: "list_tasks",
                    args: json!({ "status": "finished" })
                }
            ),
            Err(ToolError::InvalidArguments(_))
        ));
        assert!(matches!(
            call(
                &hub,
                &who,
                ToolCall {
                    name: "create_task",
                    args: json!({ "title": "x", "priority": "asap" })
                }
            ),
            Err(ToolError::InvalidArguments(_))
        ));
        assert!(matches!(
            call(
                &hub,
                &who,
                ToolCall {
                    name: "send_message",
                    args: json!({ "to": "t-1", "body": "me" })
                }
            ),
            Err(ToolError::InvalidArguments(_))
        ));
        assert!(matches!(
            call(
                &hub,
                &who,
                ToolCall {
                    name: "report_status",
                    args: json!({ "state": "sleeping" })
                }
            ),
            Err(ToolError::InvalidArguments(_))
        ));
        call(
            &hub,
            &who,
            ToolCall {
                name: "create_task",
                args: json!({ "title": "x" }),
            },
        )
        .unwrap();
        assert!(matches!(
            call(
                &hub,
                &who,
                ToolCall {
                    name: "update_task",
                    args: json!({ "id": "T-1" })
                }
            ),
            Err(ToolError::InvalidArguments(_))
        ));
    }

    #[test]
    fn given_a_status_and_notes_when_writing_and_reading_them_then_they_round_trip() {
        let (hub, events) = hub();
        hub.issue(identity("t-1", "ws-1", "claude")).unwrap();
        hub.issue(identity("t-2", "ws-1", "codex")).unwrap();
        let one = identity("t-1", "ws-1", "claude");
        let two = identity("t-2", "ws-1", "codex");
        call(
            &hub,
            &one,
            ToolCall {
                name: "report_status",
                args: json!({ "state": "needs_input", "summary": "which DB?" }),
            },
        )
        .unwrap();
        let me = call(
            &hub,
            &two,
            ToolCall {
                name: "whoami",
                args: json!({}),
            },
        )
        .unwrap();
        assert_eq!(me["peers"][0]["state"], "needs_input");
        assert_eq!(me["peers"][0]["summary"], "which DB?");
        assert!(events
            .lock()
            .unwrap()
            .iter()
            .any(|(event, _)| event == EVENT_AGENT_STATUS));

        call(
            &hub,
            &one,
            ToolCall {
                name: "add_note",
                args: json!({ "body": "use sqlite", "key": "db" }),
            },
        )
        .unwrap();
        let found = call(
            &hub,
            &two,
            ToolCall {
                name: "search_notes",
                args: json!({ "query": "db" }),
            },
        )
        .unwrap();
        assert_eq!(found["notes"][0]["body"], "use sqlite");
        call(
            &hub,
            &one,
            ToolCall {
                name: "add_note",
                args: json!({ "body": "second" }),
            },
        )
        .unwrap();
        let limited = call(
            &hub,
            &two,
            ToolCall {
                name: "search_notes",
                args: json!({ "query": "", "limit": 1 }),
            },
        )
        .unwrap();
        assert_eq!(limited["notes"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn given_an_orchestrator_when_assigning_tasks_then_idle_teammates_are_woken() {
        let (hub, events) = hub();
        let lead = AgentIdentity {
            role: Some(Role::Orchestrator),
            ..identity("t-1", "ws-1", "claude")
        };
        let dev = AgentIdentity {
            role: Some(Role::Executor),
            ..identity("t-2", "ws-1", "claude")
        };
        hub.issue(lead.clone()).unwrap();
        hub.issue(dev.clone()).unwrap();
        hub.issue(identity("t-3", "ws-1", "codex")).unwrap();

        let me = call(
            &hub,
            &dev,
            ToolCall {
                name: "whoami",
                args: json!({}),
            },
        )
        .unwrap();
        assert_eq!(me["role"], "executor");
        assert!(me["role_instructions"]
            .as_str()
            .unwrap()
            .contains("implement"));
        let peers = me["peers"].as_array().unwrap();
        assert!(peers
            .iter()
            .any(|peer| peer["terminal_id"] == "t-1" && peer["role"] == "orchestrator"));

        let first = call(
            &hub,
            &lead,
            ToolCall {
                name: "create_task",
                args: json!({ "title": "Build the API" }),
            },
        )
        .unwrap();
        let second = call(
            &hub,
            &lead,
            ToolCall {
                name: "create_task",
                args: json!({ "title": "Test the API", "depends_on": [first["id"]] }),
            },
        )
        .unwrap();

        let refused = call(
            &hub,
            &dev,
            ToolCall {
                name: "assign_task",
                args: json!({ "id": first["id"], "to": "t-3" }),
            },
        );
        assert!(
            matches!(refused, Err(ToolError::InvalidArguments(message)) if message.contains("orchestrator"))
        );
        assert!(matches!(
            call(
                &hub,
                &lead,
                ToolCall {
                    name: "assign_task",
                    args: json!({ "id": second["id"], "to": "t-2" })
                }
            ),
            Err(ToolError::Store(StoreError::Conflict(_)))
        ));
        assert!(call(
            &hub,
            &lead,
            ToolCall {
                name: "assign_task",
                args: json!({ "id": first["id"], "to": "t-9" })
            }
        )
        .is_err());

        call(
            &hub,
            &dev,
            ToolCall {
                name: "report_status",
                args: json!({ "state": "working", "summary": "other work" }),
            },
        )
        .unwrap();
        let busy = call(
            &hub,
            &lead,
            ToolCall {
                name: "assign_task",
                args: json!({ "id": first["id"], "to": "t-2", "note": "Use axum." }),
            },
        )
        .unwrap();
        assert_eq!(busy["woken"], false);
        assert_eq!(busy["task"]["assignee"], "t-2");
        assert_eq!(busy["task"]["status"], "in_progress");
        let inbox = call(
            &hub,
            &dev,
            ToolCall {
                name: "read_inbox",
                args: json!({}),
            },
        )
        .unwrap();
        assert!(inbox["messages"][0]["body"]
            .as_str()
            .unwrap()
            .ends_with("Use axum."));
        assert!(!events
            .lock()
            .unwrap()
            .iter()
            .any(|(event, _)| event == EVENT_NUDGE));

        call(
            &hub,
            &dev,
            ToolCall {
                name: "report_status",
                args: json!({ "state": "idle", "summary": "" }),
            },
        )
        .unwrap();
        let idle = call(
            &hub,
            &lead,
            ToolCall {
                name: "assign_task",
                args: json!({ "id": first["id"], "to": "t-2" }),
            },
        )
        .unwrap();
        assert_eq!(idle["woken"], true);
        let events = events.lock().unwrap();
        let nudge = events
            .iter()
            .find(|(event, _)| event == EVENT_NUDGE)
            .expect("nudge sent");
        assert_eq!(nudge.1["terminal_id"], "t-2");
        assert!(nudge.1["prompt"].as_str().unwrap().contains("get_task"));
    }

    fn create_tasks(hub: &McpHub<tauri::test::MockRuntime>, count: usize) {
        let mut repo = hub.repo().unwrap();
        for number in 0..count {
            tasks::create(
                &mut repo,
                &super::super::test_support::actor("ws-1", "t-1"),
                NewTask {
                    title: format!("task {}", number),
                    assignee: Some("t-1".into()),
                    ..NewTask::default()
                },
            )
            .unwrap();
        }
    }

    #[test]
    fn given_more_tasks_than_the_limit_when_listing_tasks_then_at_most_the_limit_is_returned() {
        let (hub, _) = hub();
        create_tasks(&hub, MAX_LIMIT + 1);

        let listed = call(
            &hub,
            &identity("t-1", "ws-1", "claude"),
            ToolCall {
                name: "list_tasks",
                args: json!({}),
            },
        )
        .unwrap();

        assert_eq!(listed["tasks"].as_array().unwrap().len(), MAX_LIMIT);
    }

    #[test]
    fn given_a_failing_query_when_calling_a_tool_then_the_error_hides_the_sqlite_detail() {
        let (hub, _) = hub();
        hub.repo().unwrap().execute("DROP TABLE notes", &[]);

        let error = call(
            &hub,
            &identity("t-1", "ws-1", "claude"),
            ToolCall {
                name: "add_note",
                args: json!({ "body": "the build uses npm" }),
            },
        )
        .unwrap_err();

        assert_eq!(error.to_string(), "database error");
    }

    #[test]
    fn given_an_unavailable_database_when_calling_a_tool_then_the_error_hides_the_cause() {
        let dir =
            std::env::temp_dir().join(format!("terra-mcp-tools-{}", crate::clock::now_millis()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(super::super::db::DB_FILE);
        std::fs::write(&path, b"not a sqlite database").unwrap();
        let hub = McpHub::open(path, None, super::super::test_support::app());

        let error = call(
            &hub,
            &identity("t-1", "ws-1", "claude"),
            ToolCall {
                name: "list_tasks",
                args: json!({}),
            },
        )
        .unwrap_err();

        assert_eq!(error.to_string(), "the Terra MCP database is unavailable");
        let _ = std::fs::remove_dir_all(dir);
    }
}
