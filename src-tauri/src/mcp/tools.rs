//! The MCP tool catalogue. Handlers take the caller's identity (from its
//! token) and plain JSON arguments, so they are tested without HTTP.

use serde::Deserialize;
use serde_json::{json, Value};

use super::repo::{AgentState, NewTask, StoreError, Task, TaskPatch, TaskPriority, TaskStatus};
use super::{AgentIdentity, McpHub};

pub struct ToolDef {
    pub name: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub read_only: bool,
    pub schema: Value,
}

#[derive(Debug, PartialEq)]
pub enum ToolError {
    UnknownTool(String),
    InvalidArguments(String),
    Store(StoreError),
}

impl std::fmt::Display for ToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ToolError::UnknownTool(name) => write!(f, "unknown tool `{}`", name),
            ToolError::InvalidArguments(message) => write!(f, "invalid arguments: {}", message),
            ToolError::Store(error) => write!(f, "{}", error),
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

const STATUS_VALUES: [&str; 5] = ["todo", "in_progress", "review", "done", "blocked"];
const PRIORITY_VALUES: [&str; 4] = ["low", "medium", "high", "urgent"];
const STATE_VALUES: [&str; 4] = ["working", "idle", "needs_input", "blocked"];

pub fn definitions() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "whoami",
            title: "Who am I",
            description: "Returns your own terminal id, agent name and project (workspace), plus \
                the teammates currently connected to this project with their reported state. Call \
                this first: other tools refer to agents by terminal id (for example `t-3`).",
            read_only: true,
            schema: json!({ "type": "object", "properties": {} }),
        },
        ToolDef {
            name: "list_tasks",
            title: "List tasks",
            description:
                "Lists the tasks on this project's shared board: active work first, then by \
                priority and board position. Filter by `status` and/or `assignee` (a terminal id, \
                or \"me\" for your own tasks). `blocked_by` lists unfinished dependencies: such a \
                task can't be claimed yet. Each entry is a summary; use `get_task` for the \
                description and history.",
            read_only: true,
            schema: json!({
                "type": "object",
                "properties": {
                    "status": { "type": "string", "enum": STATUS_VALUES },
                    "assignee": { "type": "string", "description": "Terminal id, or \"me\"." }
                }
            }),
        },
        ToolDef {
            name: "get_task",
            title: "Get task",
            description: "Returns one task with its full description, dependencies and its latest \
                history `events` (created, claimed, status, assigned, note, completed).",
            read_only: true,
            schema: json!({
                "type": "object",
                "properties": { "id": { "type": "string", "description": "Task id, e.g. \"T-4\"." } },
                "required": ["id"]
            }),
        },
        ToolDef {
            name: "create_task",
            title: "Create task",
            description: "Adds a task to the shared board in `todo`, unassigned, so any agent can \
                claim it. Split large work into tasks a single agent can finish. `depends_on` \
                lists task ids that must be `done` before this one can be claimed.",
            read_only: false,
            schema: json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Short imperative summary (max 200 characters)." },
                    "description": { "type": "string", "description": "What done looks like, relevant files, constraints." },
                    "priority": { "type": "string", "enum": PRIORITY_VALUES, "default": "medium" },
                    "depends_on": { "type": "array", "items": { "type": "string" } },
                    "labels": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["title"]
            }),
        },
        ToolDef {
            name: "claim_task",
            title: "Claim task",
            description:
                "Assigns a `todo` task to you and moves it to `in_progress`. Claim before \
                you start working on a task. Atomic: if another agent already claimed it, it is \
                not in `todo`, or a dependency is not done yet, this fails and you should pick \
                something else.",
            read_only: false,
            schema: json!({
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            }),
        },
        ToolDef {
            name: "update_task",
            title: "Update task",
            description: "Changes a task's status and/or adds a note to its history. Use \
                `status: \"blocked\"` with a `note` explaining what you are waiting for. To hand \
                work in, prefer `complete_task`.",
            read_only: false,
            schema: json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "status": { "type": "string", "enum": STATUS_VALUES },
                    "note": { "type": "string", "description": "Progress log entry." }
                },
                "required": ["id"]
            }),
        },
        ToolDef {
            name: "complete_task",
            title: "Complete task",
            description: "Marks your task as finished and moves it to `review` for a human to \
                check, recording `summary` (what changed, how it was verified) in the log. Only \
                the assignee can complete an assigned task.",
            read_only: false,
            schema: json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "summary": { "type": "string" }
                },
                "required": ["id", "summary"]
            }),
        },
        ToolDef {
            name: "send_message",
            title: "Send message",
            description: "Sends a message to a teammate by terminal id (see `whoami`), or to \
                \"all\" to broadcast to every agent in this project. Messages are delivered \
                through the recipient's `read_inbox`.",
            read_only: false,
            schema: json!({
                "type": "object",
                "properties": {
                    "to": { "type": "string", "description": "Terminal id or \"all\"." },
                    "body": { "type": "string" }
                },
                "required": ["to", "body"]
            }),
        },
        ToolDef {
            name: "read_inbox",
            title: "Read inbox",
            description: "Returns messages sent to you or to \"all\", oldest first (at most \
                `limit`, default 50), and marks them as read. By default only unread messages \
                are returned; pass `unread_only: false` to see the history too.",
            read_only: false,
            schema: json!({
                "type": "object",
                "properties": {
                    "unread_only": { "type": "boolean", "default": true },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 200, "default": 50 }
                }
            }),
        },
        ToolDef {
            name: "add_note",
            title: "Add note",
            description: "Saves a note to this project's shared memory, visible to every agent \
                now and in later sessions. Use it for facts worth keeping: commands, conventions, \
                decisions, gotchas. Giving a `key` (e.g. \"test-command\") replaces the earlier \
                note with the same key.",
            read_only: false,
            schema: json!({
                "type": "object",
                "properties": {
                    "body": { "type": "string" },
                    "key": { "type": "string", "description": "Optional stable name for the note." }
                },
                "required": ["body"]
            }),
        },
        ToolDef {
            name: "search_notes",
            title: "Search notes",
            description: "Full-text search over the project's shared notes (key and text). Every \
                word must match, as a prefix, ignoring case and accents; best matches first, at \
                most `limit` (default 20). An empty query lists the most recently updated notes.",
            read_only: true,
            schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 200, "default": 20 }
                },
                "required": ["query"]
            }),
        },
        ToolDef {
            name: "assign_task",
            title: "Assign task",
            description: "Orchestrator only. Hands a task to a teammate: makes them the assignee,                 moves a `todo` task to `in_progress`, puts the task (and your optional `note`) in                 their inbox, and, when they are idle, types a prompt into their terminal so they                 start right away. A task with unfinished dependencies cannot be assigned yet.",
            read_only: false,
            schema: json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Task id, e.g. \"T-4\"." },
                    "to": { "type": "string", "description": "Teammate's terminal id (see `whoami`)." },
                    "note": { "type": "string", "description": "Extra guidance for the teammate." }
                },
                "required": ["id", "to"]
            }),
        },
        ToolDef {
            name: "report_status",
            title: "Report status",
            description: "Tells your teammates and the humans watching what you are doing: \
                `working`, `idle`, `needs_input` (waiting for a human) or `blocked`, with a \
                one-line `summary`. Update it when your state changes.",
            read_only: false,
            schema: json!({
                "type": "object",
                "properties": {
                    "state": { "type": "string", "enum": STATE_VALUES },
                    "summary": { "type": "string", "description": "One line, max 500 characters." }
                },
                "required": ["state", "summary"]
            }),
        },
    ]
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
                    STATUS_VALUES.join(", ")
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

/// Run one tool for `who`. Every store call uses `who.workspace_id`, so a
/// caller can never reach another project's data.
pub fn call(
    hub: &McpHub,
    who: &AgentIdentity,
    name: &str,
    args: Value,
) -> Result<Value, ToolError> {
    let ws = who.workspace_id.as_str();
    let me = who.terminal_id.as_str();
    match name {
        "whoami" => {
            let workspace = hub.workspace(ws);
            let repo = hub.repo()?;
            let peers: Vec<Value> = hub
                .peers(ws)
                .into_iter()
                .filter(|peer| peer.terminal_id != me)
                .map(|peer| {
                    let status = repo.status_of(&peer.terminal_id);
                    json!({
                        "terminal_id": peer.terminal_id,
                        "agent": peer.agent,
                        "role": peer.role,
                        "state": status.map(|status| status.state),
                        "summary": status.map(|status| status.summary.clone()),
                        "updated_at": status.map(|status| status.updated_at),
                    })
                })
                .collect();
            let mine = repo.list_tasks(ws, None, Some(me), None)?;
            Ok(json!({
                "terminal_id": me,
                "agent": who.agent,
                "role": who.role,
                "role_instructions": who.role.map(|role| role.instructions()),
                "workspace_id": ws,
                "workspace_name": workspace.as_ref().map(|info| info.name.clone()),
                "workspace_cwd": workspace.as_ref().map(|info| info.cwd.clone()),
                "unread_messages": repo.unread_count(ws, me)?,
                "my_open_tasks": mine
                    .iter()
                    .filter(|task| task.status != TaskStatus::Done)
                    .map(task_summary)
                    .collect::<Vec<_>>(),
                "peers": peers,
            }))
        }
        "list_tasks" => {
            let args: ListTasksArgs = parse(args)?;
            let status = status_arg(args.status)?;
            let assignee = args
                .assignee
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .map(|value| if value == "me" { me.to_string() } else { value });
            let tasks = hub
                .repo()?
                .list_tasks(ws, status, assignee.as_deref(), None)?;
            Ok(json!({
                "tasks": tasks.iter().map(task_summary).collect::<Vec<_>>(),
            }))
        }
        "get_task" => {
            let args: IdArgs = parse(args)?;
            Ok(json!(hub.repo()?.get_task(ws, &args.id)?))
        }
        "create_task" => {
            let args: CreateTaskArgs = parse(args)?;
            let priority = args
                .priority
                .map(|raw| {
                    TaskPriority::parse(raw.trim()).ok_or_else(|| {
                        ToolError::InvalidArguments(format!(
                            "priority must be one of {}",
                            PRIORITY_VALUES.join(", ")
                        ))
                    })
                })
                .transpose()?;
            let task = hub.repo()?.create_task(
                ws,
                me,
                NewTask {
                    title: args.title,
                    description: args.description,
                    priority,
                    labels: args.labels,
                    depends_on: args.depends_on,
                    assignee: None,
                },
            )?;
            hub.emit_tasks_changed(ws);
            Ok(json!(task))
        }
        "claim_task" => {
            let args: IdArgs = parse(args)?;
            let task = hub.repo()?.claim_task(ws, &args.id, me)?;
            hub.emit_tasks_changed(ws);
            Ok(json!(task))
        }
        "update_task" => {
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
            let task = hub.repo()?.update_task(
                ws,
                &args.id,
                me,
                TaskPatch {
                    status,
                    note: args.note,
                    ..TaskPatch::default()
                },
            )?;
            hub.emit_tasks_changed(ws);
            Ok(json!(task))
        }
        "complete_task" => {
            let args: CompleteTaskArgs = parse(args)?;
            let task = hub.repo()?.complete_task(ws, &args.id, me, &args.summary)?;
            hub.emit_tasks_changed(ws);
            Ok(json!(task))
        }
        "send_message" => {
            let args: SendMessageArgs = parse(args)?;
            let to = args.to.trim();
            if to == me {
                return Err(ToolError::InvalidArguments(
                    "you cannot send a message to yourself".into(),
                ));
            }
            let known = to == "all"
                || hub.peers(ws).iter().any(|peer| peer.terminal_id == to)
                || hub.workspace_terminals(ws).iter().any(|id| id == to);
            if !known {
                return Err(ToolError::InvalidArguments(format!(
                    "`{}` is not a terminal of this project; use a terminal id from `whoami` \
                     or \"all\"",
                    to
                )));
            }
            let message = hub.repo()?.send_message(ws, me, to, &args.body)?;
            hub.emit_message(&message);
            Ok(json!(message))
        }
        "assign_task" => {
            let args: AssignTaskArgs = parse(args)?;
            if !who.role.is_some_and(|role| role.can_assign()) {
                return Err(ToolError::InvalidArguments(
                    "only the team's orchestrator can assign tasks; claim one with `claim_task` \
                     or message the orchestrator"
                        .into(),
                ));
            }
            let to = args.to.trim();
            if to == me {
                return Err(ToolError::InvalidArguments(
                    "assign tasks to teammates, not to yourself".into(),
                ));
            }
            if !hub.peers(ws).iter().any(|peer| peer.terminal_id == to) {
                return Err(ToolError::InvalidArguments(format!(
                    "`{}` is not a running teammate in this project; see `whoami`",
                    to
                )));
            }
            let mut repo = hub.repo()?;
            let current = repo.get_task(ws, &args.id)?;
            if !current.blocked_by.is_empty() {
                return Err(ToolError::Store(StoreError::Conflict(format!(
                    "task {} depends on unfinished tasks: {}",
                    current.id,
                    current.blocked_by.join(", ")
                ))));
            }
            if current.status == TaskStatus::Done {
                return Err(ToolError::Store(StoreError::Conflict(format!(
                    "task {} is already done",
                    current.id
                ))));
            }
            let task = repo.update_task(
                ws,
                &current.id,
                me,
                TaskPatch {
                    assignee: Some(Some(to.to_string())),
                    status: (current.status == TaskStatus::Todo).then_some(TaskStatus::InProgress),
                    ..TaskPatch::default()
                },
            )?;
            let note = args
                .note
                .as_deref()
                .map(str::trim)
                .filter(|note| !note.is_empty());
            let body = match note {
                Some(note) => format!("I assigned you {}: {}. {}", task.id, task.title, note),
                None => format!("I assigned you {}: {}.", task.id, task.title),
            };
            let message = repo.send_message(ws, me, to, &body)?;
            // Typing into a terminal that is busy or waiting on a human could
            // answer a prompt by accident, so only idle agents are woken.
            let idle = repo
                .status_of(to)
                .is_some_and(|status| status.state == AgentState::Idle);
            drop(repo);
            hub.emit_tasks_changed(ws);
            hub.emit_message(&message);
            if idle {
                let prompt = format!(
                    "Task {} on the Terra board was assigned to you by {}: \"{}\". Read it with the get_task tool and your inbox with read_inbox, do the work, then hand it in with complete_task.",
                    task.id, me, task.title
                );
                hub.emit_nudge(ws, to, &prompt);
            }
            Ok(json!({ "task": task, "woken": idle }))
        }
        "read_inbox" => {
            let args: ReadInboxArgs = parse(args)?;
            let messages =
                hub.repo()?
                    .read_inbox(ws, me, args.unread_only.unwrap_or(true), args.limit)?;
            Ok(json!({ "messages": messages }))
        }
        "add_note" => {
            let args: AddNoteArgs = parse(args)?;
            let note = hub
                .repo()?
                .add_note(ws, me, &args.body, args.key.as_deref())?;
            Ok(json!(note))
        }
        "search_notes" => {
            let args: SearchNotesArgs = parse(args)?;
            Ok(json!({ "notes": hub.repo()?.search_notes(ws, &args.query, args.limit)? }))
        }
        "report_status" => {
            let args: ReportStatusArgs = parse(args)?;
            let state = AgentState::parse(args.state.trim()).ok_or_else(|| {
                ToolError::InvalidArguments(format!(
                    "state must be one of {}",
                    STATE_VALUES.join(", ")
                ))
            })?;
            let status = hub.repo()?.report_status(ws, me, state, &args.summary)?;
            hub.emit_agent_status(&status);
            Ok(json!(status))
        }
        other => Err(ToolError::UnknownTool(other.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::super::roles::Role;
    use super::super::test_support::{hub, identity};
    use super::super::{EVENT_AGENT_STATUS, EVENT_MESSAGE, EVENT_NUDGE, EVENT_TASKS_CHANGED};
    use super::*;

    #[test]
    fn every_tool_has_an_object_schema_and_a_handler() {
        let (hub, _) = hub();
        let who = identity("t-1", "ws-1", "claude");
        let defs = definitions();
        assert_eq!(defs.len(), 13);
        for def in &defs {
            assert_eq!(def.schema["type"], "object", "{}", def.name);
            assert!(def.description.len() > 40, "{}", def.name);
            let result = call(&hub, &who, def.name, json!({}));
            assert!(
                !matches!(result, Err(ToolError::UnknownTool(_))),
                "{} has no handler",
                def.name
            );
        }
        assert_eq!(
            call(&hub, &who, "nope", json!({})),
            Err(ToolError::UnknownTool("nope".into()))
        );
    }

    #[test]
    fn two_agents_coordinate_through_the_board() {
        let (hub, events) = hub();
        hub.issue(identity("t-1", "ws-1", "claude"));
        hub.issue(identity("t-2", "ws-1", "claude"));
        let lead = identity("t-1", "ws-1", "claude");
        let helper = identity("t-2", "ws-1", "claude");

        let task = call(
            &hub,
            &lead,
            "create_task",
            json!({ "title": "Add login form", "priority": "high" }),
        )
        .unwrap();
        assert_eq!(task["id"], "T-1");
        assert_eq!(task["created_by"], "t-1");
        call(
            &hub,
            &lead,
            "send_message",
            json!({ "to": "t-2", "body": "T-1 is yours" }),
        )
        .unwrap();

        let me = call(&hub, &helper, "whoami", Value::Null).unwrap();
        assert_eq!(me["terminal_id"], "t-2");
        assert_eq!(me["workspace_name"], "ws-1 project");
        assert_eq!(me["unread_messages"], 1);
        assert_eq!(me["peers"][0]["terminal_id"], "t-1");

        let inbox = call(&hub, &helper, "read_inbox", json!({})).unwrap();
        assert_eq!(inbox["messages"][0]["body"], "T-1 is yours");
        assert_eq!(
            call(&hub, &helper, "read_inbox", json!({})).unwrap()["messages"],
            json!([])
        );

        let claimed = call(&hub, &helper, "claim_task", json!({ "id": "T-1" })).unwrap();
        assert_eq!(claimed["assignee"], "t-2");
        assert!(call(&hub, &lead, "claim_task", json!({ "id": "T-1" })).is_err());

        let mine = call(&hub, &helper, "list_tasks", json!({ "assignee": "me" })).unwrap();
        assert_eq!(mine["tasks"].as_array().unwrap().len(), 1);

        let done = call(
            &hub,
            &helper,
            "complete_task",
            json!({ "id": "T-1", "summary": "form + tests" }),
        )
        .unwrap();
        assert_eq!(done["status"], "review");

        let full = call(&hub, &lead, "get_task", json!({ "id": "1" })).unwrap();
        let kinds: Vec<&str> = full["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["kind"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, vec!["created", "claimed", "completed"]);

        // A dependent task shows what it waits on and can't be claimed yet.
        call(
            &hub,
            &lead,
            "create_task",
            json!({ "title": "Ship", "depends_on": ["T-1"] }),
        )
        .unwrap();
        let listed = call(&hub, &lead, "list_tasks", json!({ "status": "todo" })).unwrap();
        assert_eq!(listed["tasks"][0]["blocked_by"], json!(["T-1"]));
        assert!(listed["tasks"][0].get("events").is_none());
        assert!(call(&hub, &helper, "claim_task", json!({ "id": "T-2" })).is_err());

        let events = events.lock().unwrap();
        assert!(
            events
                .iter()
                .filter(|(e, _)| e == EVENT_TASKS_CHANGED)
                .count()
                >= 3
        );
        assert!(events
            .iter()
            .any(|(e, p)| e == EVENT_MESSAGE && p["to"] == "t-2"));
    }

    #[test]
    fn tools_are_scoped_to_the_callers_workspace() {
        let (hub, _) = hub();
        hub.issue(identity("t-1", "ws-1", "claude"));
        hub.issue(identity("t-5", "ws-2", "codex"));
        let one = identity("t-1", "ws-1", "claude");
        let other = identity("t-5", "ws-2", "codex");

        call(&hub, &one, "create_task", json!({ "title": "private" })).unwrap();
        call(&hub, &one, "add_note", json!({ "body": "secret sauce" })).unwrap();
        assert_eq!(
            call(&hub, &other, "list_tasks", json!({})).unwrap()["tasks"],
            json!([])
        );
        assert!(call(&hub, &other, "get_task", json!({ "id": "T-1" })).is_err());
        assert_eq!(
            call(&hub, &other, "search_notes", json!({ "query": "secret" })).unwrap()["notes"],
            json!([])
        );
        // Agents of other projects are not addressable either.
        assert!(call(
            &hub,
            &other,
            "send_message",
            json!({ "to": "t-1", "body": "hi" })
        )
        .is_err());
        assert_eq!(
            call(&hub, &other, "whoami", json!({})).unwrap()["peers"],
            json!([])
        );
    }

    #[test]
    fn invalid_arguments_are_reported() {
        let (hub, _) = hub();
        let who = identity("t-1", "ws-1", "claude");
        assert!(matches!(
            call(&hub, &who, "list_tasks", json!({ "status": "finished" })),
            Err(ToolError::InvalidArguments(_))
        ));
        assert!(matches!(
            call(
                &hub,
                &who,
                "create_task",
                json!({ "title": "x", "priority": "asap" })
            ),
            Err(ToolError::InvalidArguments(_))
        ));
        assert!(matches!(
            call(
                &hub,
                &who,
                "send_message",
                json!({ "to": "t-1", "body": "me" })
            ),
            Err(ToolError::InvalidArguments(_))
        ));
        assert!(matches!(
            call(&hub, &who, "report_status", json!({ "state": "sleeping" })),
            Err(ToolError::InvalidArguments(_))
        ));
        call(&hub, &who, "create_task", json!({ "title": "x" })).unwrap();
        assert!(matches!(
            call(&hub, &who, "update_task", json!({ "id": "T-1" })),
            Err(ToolError::InvalidArguments(_))
        ));
    }

    #[test]
    fn status_and_notes_round_trip() {
        let (hub, events) = hub();
        hub.issue(identity("t-1", "ws-1", "claude"));
        hub.issue(identity("t-2", "ws-1", "codex"));
        let one = identity("t-1", "ws-1", "claude");
        let two = identity("t-2", "ws-1", "codex");
        call(
            &hub,
            &one,
            "report_status",
            json!({ "state": "needs_input", "summary": "which DB?" }),
        )
        .unwrap();
        let me = call(&hub, &two, "whoami", json!({})).unwrap();
        assert_eq!(me["peers"][0]["state"], "needs_input");
        assert_eq!(me["peers"][0]["summary"], "which DB?");
        assert!(events
            .lock()
            .unwrap()
            .iter()
            .any(|(e, _)| e == EVENT_AGENT_STATUS));

        call(
            &hub,
            &one,
            "add_note",
            json!({ "body": "use sqlite", "key": "db" }),
        )
        .unwrap();
        let found = call(&hub, &two, "search_notes", json!({ "query": "db" })).unwrap();
        assert_eq!(found["notes"][0]["body"], "use sqlite");
        call(&hub, &one, "add_note", json!({ "body": "second" })).unwrap();
        let limited = call(
            &hub,
            &two,
            "search_notes",
            json!({ "query": "", "limit": 1 }),
        )
        .unwrap();
        assert_eq!(limited["notes"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn the_orchestrator_assigns_and_wakes_idle_teammates() {
        let (hub, events) = hub();
        let lead = AgentIdentity {
            role: Some(Role::Orchestrator),
            ..identity("t-1", "ws-1", "claude")
        };
        let dev = AgentIdentity {
            role: Some(Role::Executor),
            ..identity("t-2", "ws-1", "claude")
        };
        hub.issue(lead.clone());
        hub.issue(dev.clone());
        hub.issue(identity("t-3", "ws-1", "codex"));

        let me = call(&hub, &dev, "whoami", json!({})).unwrap();
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
            "create_task",
            json!({ "title": "Build the API" }),
        )
        .unwrap();
        let second = call(
            &hub,
            &lead,
            "create_task",
            json!({ "title": "Test the API", "depends_on": [first["id"]] }),
        )
        .unwrap();

        // Only the orchestrator assigns.
        let refused = call(
            &hub,
            &dev,
            "assign_task",
            json!({ "id": first["id"], "to": "t-3" }),
        );
        assert!(
            matches!(refused, Err(ToolError::InvalidArguments(message)) if message.contains("orchestrator"))
        );
        // Dependencies come first, and the target must be a running teammate.
        assert!(matches!(
            call(
                &hub,
                &lead,
                "assign_task",
                json!({ "id": second["id"], "to": "t-2" })
            ),
            Err(ToolError::Store(StoreError::Conflict(_)))
        ));
        assert!(call(
            &hub,
            &lead,
            "assign_task",
            json!({ "id": first["id"], "to": "t-9" })
        )
        .is_err());

        // A busy agent gets the task and a message, but nothing typed.
        call(
            &hub,
            &dev,
            "report_status",
            json!({ "state": "working", "summary": "other work" }),
        )
        .unwrap();
        let busy = call(
            &hub,
            &lead,
            "assign_task",
            json!({ "id": first["id"], "to": "t-2", "note": "Use axum." }),
        )
        .unwrap();
        assert_eq!(busy["woken"], false);
        assert_eq!(busy["task"]["assignee"], "t-2");
        assert_eq!(busy["task"]["status"], "in_progress");
        let inbox = call(&hub, &dev, "read_inbox", json!({})).unwrap();
        assert!(inbox["messages"][0]["body"]
            .as_str()
            .unwrap()
            .ends_with("Use axum."));
        assert!(!events
            .lock()
            .unwrap()
            .iter()
            .any(|(event, _)| event == EVENT_NUDGE));

        // An idle one is woken with a prompt.
        call(
            &hub,
            &dev,
            "report_status",
            json!({ "state": "idle", "summary": "" }),
        )
        .unwrap();
        let idle = call(
            &hub,
            &lead,
            "assign_task",
            json!({ "id": first["id"], "to": "t-2" }),
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
}
