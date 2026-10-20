//! Queries behind the MCP tools and the Tasks panel: tasks, messages, notes
//! and agent statuses. Every call is scoped by `workspace_id`, which callers
//! take from the caller's token, never from the agent's arguments.
//!
//! Statuses are runtime facts and live only in memory; everything else is in
//! `mcp.db` and is kept in full (no size-based eviction).

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

pub const MAX_TITLE_CHARS: usize = 200;
/// Guards against runaway input; history itself is never trimmed.
pub const MAX_BODY_BYTES: usize = 64 * 1024;
pub const MAX_LABELS: usize = 16;
pub const DEFAULT_INBOX_LIMIT: usize = 50;
pub const DEFAULT_SEARCH_LIMIT: usize = 20;
pub const MAX_LIMIT: usize = 200;
pub const TASK_EVENTS_SHOWN: usize = 50;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Todo,
    InProgress,
    Review,
    Done,
    Blocked,
}

impl TaskStatus {
    pub const ALL: [TaskStatus; 5] = [
        TaskStatus::Todo,
        TaskStatus::InProgress,
        TaskStatus::Review,
        TaskStatus::Done,
        TaskStatus::Blocked,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            TaskStatus::Todo => "todo",
            TaskStatus::InProgress => "in_progress",
            TaskStatus::Review => "review",
            TaskStatus::Done => "done",
            TaskStatus::Blocked => "blocked",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|status| status.as_str() == value)
    }
}

/// Stored as an integer (0 urgent … 3 low), exposed by name.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskPriority {
    Urgent,
    High,
    Medium,
    Low,
}

impl TaskPriority {
    pub const ALL: [TaskPriority; 4] = [
        TaskPriority::Urgent,
        TaskPriority::High,
        TaskPriority::Medium,
        TaskPriority::Low,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            TaskPriority::Urgent => "urgent",
            TaskPriority::High => "high",
            TaskPriority::Medium => "medium",
            TaskPriority::Low => "low",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|priority| priority.as_str() == value)
    }

    pub fn rank(self) -> i64 {
        self as i64
    }

    pub fn from_rank(rank: i64) -> Self {
        Self::ALL
            .get(rank.clamp(0, 3) as usize)
            .copied()
            .unwrap_or(TaskPriority::Medium)
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct TaskEvent {
    pub actor: String,
    pub kind: String,
    pub body: String,
    pub created_at: i64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Task {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    pub description: String,
    pub status: TaskStatus,
    pub priority: TaskPriority,
    pub assignee: Option<String>,
    pub created_by: String,
    pub labels: Vec<String>,
    pub position: f64,
    pub depends_on: Vec<String>,
    /// Dependencies that are not `done` yet; non-empty means it can't be claimed.
    pub blocked_by: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    /// The latest events, oldest first. Omitted from summaries.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub events: Option<Vec<TaskEvent>>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Message {
    pub id: i64,
    pub workspace_id: String,
    pub from: String,
    pub to: String,
    pub body: String,
    pub created_at: i64,
    pub read_by: Vec<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Note {
    pub id: i64,
    pub workspace_id: String,
    pub key: Option<String>,
    pub body: String,
    pub author: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentState {
    Working,
    Idle,
    NeedsInput,
    Blocked,
}

impl AgentState {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "working" => Some(AgentState::Working),
            "idle" => Some(AgentState::Idle),
            "needs_input" => Some(AgentState::NeedsInput),
            "blocked" => Some(AgentState::Blocked),
            _ => None,
        }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct AgentStatus {
    pub terminal_id: String,
    pub workspace_id: String,
    pub state: AgentState,
    pub summary: String,
    pub updated_at: i64,
}

#[derive(Default, Clone, Debug)]
pub struct NewTask {
    pub title: String,
    pub description: Option<String>,
    pub priority: Option<TaskPriority>,
    pub labels: Vec<String>,
    pub depends_on: Vec<String>,
    pub assignee: Option<String>,
}

/// A partial update. `assignee: Some(None)` unassigns the task.
#[derive(Default, Clone, Debug)]
pub struct TaskPatch {
    pub title: Option<String>,
    pub description: Option<String>,
    pub status: Option<TaskStatus>,
    pub priority: Option<TaskPriority>,
    pub assignee: Option<Option<String>>,
    pub position: Option<f64>,
    pub note: Option<String>,
}

#[derive(Debug, PartialEq)]
pub enum StoreError {
    NotFound(String),
    Invalid(String),
    Conflict(String),
    Unavailable(String),
    Database(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::NotFound(message)
            | StoreError::Invalid(message)
            | StoreError::Conflict(message) => f.write_str(message),
            StoreError::Unavailable(message) => {
                write!(f, "the Terra MCP database is unavailable: {}", message)
            }
            StoreError::Database(message) => write!(f, "database error: {}", message),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        StoreError::Database(error.to_string())
    }
}

pub type StoreResult<T> = Result<T, StoreError>;

pub fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// Accept `T-12`, `t-12` and a bare `12`, so agents can be sloppy with ids.
pub fn normalize_task_id(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let digits = raw
        .strip_prefix('T')
        .or_else(|| raw.strip_prefix('t'))
        .and_then(|rest| rest.strip_prefix('-'))
        .unwrap_or(raw);
    digits
        .parse::<u64>()
        .ok()
        .filter(|n| *n > 0)
        .map(|n| format!("T-{}", n))
}

fn task_not_found(raw: &str) -> StoreError {
    StoreError::NotFound(format!("task {} not found in this workspace", raw.trim()))
}

fn clean_title(raw: &str) -> StoreResult<String> {
    let title = raw.trim();
    if title.is_empty() {
        return Err(StoreError::Invalid("title cannot be empty".into()));
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(StoreError::Invalid(format!(
            "title is longer than {} characters",
            MAX_TITLE_CHARS
        )));
    }
    Ok(title.to_string())
}

fn clean_body(raw: &str, what: &str, allow_empty: bool) -> StoreResult<String> {
    let body = raw.trim();
    if body.is_empty() && !allow_empty {
        return Err(StoreError::Invalid(format!("{} cannot be empty", what)));
    }
    if body.len() > MAX_BODY_BYTES {
        return Err(StoreError::Invalid(format!(
            "{} is larger than {} KiB",
            what,
            MAX_BODY_BYTES / 1024
        )));
    }
    Ok(body.to_string())
}

fn clean_labels(raw: &[String]) -> StoreResult<Vec<String>> {
    let mut labels: Vec<String> = Vec::new();
    for label in raw {
        let label = label.trim();
        if label.is_empty() || labels.iter().any(|existing| existing == label) {
            continue;
        }
        if label.chars().count() > 40 {
            return Err(StoreError::Invalid(format!(
                "label `{}` is too long",
                label
            )));
        }
        labels.push(label.to_string());
    }
    if labels.len() > MAX_LABELS {
        return Err(StoreError::Invalid(format!(
            "at most {} labels",
            MAX_LABELS
        )));
    }
    Ok(labels)
}

fn clamp_limit(limit: Option<usize>, default: usize) -> usize {
    limit.unwrap_or(default).clamp(1, MAX_LIMIT)
}

/// Turn free text into an FTS5 query: every word must match, each as a
/// prefix, and FTS operators typed by the agent are taken literally.
fn fts_query(query: &str) -> Option<String> {
    let terms: Vec<String> = query
        .split_whitespace()
        .map(|term| term.replace('"', ""))
        .filter(|term| !term.is_empty())
        .map(|term| format!("\"{}\"*", term))
        .collect();
    (!terms.is_empty()).then(|| terms.join(" "))
}

fn add_event(
    tx: &Transaction<'_>,
    task_id: &str,
    actor: &str,
    kind: &str,
    body: &str,
    at: i64,
) -> StoreResult<()> {
    tx.execute(
        "INSERT INTO task_events(task_id, actor, kind, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![task_id, actor, kind, body, at],
    )?;
    Ok(())
}

/// Next free slot at the end of a status column.
fn end_of_column(tx: &Transaction<'_>, workspace_id: &str, status: TaskStatus) -> StoreResult<f64> {
    let max: Option<f64> = tx.query_row(
        "SELECT MAX(position) FROM tasks WHERE workspace_id = ?1 AND status = ?2",
        params![workspace_id, status.as_str()],
        |row| row.get(0),
    )?;
    Ok(max.map_or(1.0, |max| max.floor() + 1.0))
}

pub struct Repo {
    conn: Connection,
    statuses: HashMap<String, AgentStatus>,
}

impl Repo {
    pub fn new(conn: Connection) -> Self {
        Self {
            conn,
            statuses: HashMap::new(),
        }
    }

    #[cfg(test)]
    pub fn in_memory() -> Self {
        Self::new(super::db::open_in_memory())
    }

    // ----- settings -------------------------------------------------------

    /// Whether terminals get the MCP server injected. On unless turned off.
    pub fn enabled(&self) -> bool {
        self.conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'enabled'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .ok()
            .flatten()
            .is_none_or(|value| value != "0")
    }

    pub fn set_enabled(&self, enabled: bool) -> StoreResult<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO settings(key, value) VALUES ('enabled', ?1)",
            params![if enabled { "1" } else { "0" }],
        )?;
        Ok(())
    }

    // ----- workspace lifecycle --------------------------------------------

    /// Delete everything a workspace owns. Workspaces live in
    /// `workspaces.json`, so there is no foreign key to cascade from.
    pub fn purge_workspace(&mut self, workspace_id: &str) -> StoreResult<()> {
        let tx = self.conn.transaction()?;
        // Child rows go with their parents through ON DELETE CASCADE.
        tx.execute(
            "DELETE FROM tasks WHERE workspace_id = ?1",
            params![workspace_id],
        )?;
        tx.execute(
            "DELETE FROM messages WHERE workspace_id = ?1",
            params![workspace_id],
        )?;
        tx.execute(
            "DELETE FROM notes WHERE workspace_id = ?1",
            params![workspace_id],
        )?;
        tx.commit()?;
        self.statuses
            .retain(|_, status| status.workspace_id != workspace_id);
        Ok(())
    }

    /// Purge workspaces that disappeared while the app was not running.
    pub fn retain_workspaces(&mut self, known: &HashSet<String>) -> StoreResult<()> {
        let mut gone: Vec<String> = Vec::new();
        for table in ["tasks", "messages", "notes"] {
            let mut stmt = self
                .conn
                .prepare(&format!("SELECT DISTINCT workspace_id FROM {}", table))?;
            let ids = stmt.query_map([], |row| row.get::<_, String>(0))?;
            for id in ids {
                let id = id?;
                if !known.contains(&id) && !gone.contains(&id) {
                    gone.push(id);
                }
            }
        }
        for id in gone {
            self.purge_workspace(&id)?;
        }
        Ok(())
    }

    // ----- tasks ----------------------------------------------------------

    fn task_id(&self, workspace_id: &str, raw: &str) -> StoreResult<String> {
        let id = normalize_task_id(raw).ok_or_else(|| task_not_found(raw))?;
        self.conn
            .query_row(
                "SELECT id FROM tasks WHERE id = ?1 AND workspace_id = ?2",
                params![id, workspace_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| task_not_found(raw))
    }

    fn load_task(&self, id: &str, events: Option<usize>) -> StoreResult<Task> {
        let mut task = self.conn.query_row(
            "SELECT id, workspace_id, title, description, status, priority, assignee, created_by,
                    labels, position, created_at, updated_at
             FROM tasks WHERE id = ?1",
            params![id],
            |row| {
                let status: String = row.get(4)?;
                Ok(Task {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    title: row.get(2)?,
                    description: row.get(3)?,
                    status: TaskStatus::parse(&status).unwrap_or(TaskStatus::Todo),
                    priority: TaskPriority::from_rank(row.get(5)?),
                    assignee: row.get(6)?,
                    created_by: row.get(7)?,
                    labels: serde_json::from_str(&row.get::<_, String>(8)?).unwrap_or_default(),
                    position: row.get(9)?,
                    depends_on: Vec::new(),
                    blocked_by: Vec::new(),
                    created_at: row.get(10)?,
                    updated_at: row.get(11)?,
                    events: None,
                })
            },
        )?;
        {
            let mut stmt = self.conn.prepare_cached(
                "SELECT d.depends_on, t.status FROM task_deps d
                 JOIN tasks t ON t.id = d.depends_on
                 WHERE d.task_id = ?1 ORDER BY t.created_at",
            )?;
            let rows = stmt.query_map(params![id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            for row in rows {
                let (dep, status) = row?;
                if status != TaskStatus::Done.as_str() {
                    task.blocked_by.push(dep.clone());
                }
                task.depends_on.push(dep);
            }
        }
        if let Some(limit) = events {
            let mut stmt = self.conn.prepare_cached(
                "SELECT actor, kind, body, created_at FROM (
                    SELECT id, actor, kind, body, created_at FROM task_events
                    WHERE task_id = ?1 ORDER BY id DESC LIMIT ?2
                 ) ORDER BY id",
            )?;
            let rows = stmt.query_map(params![id, limit as i64], |row| {
                Ok(TaskEvent {
                    actor: row.get(0)?,
                    kind: row.get(1)?,
                    body: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })?;
            task.events = Some(rows.collect::<Result<_, _>>()?);
        }
        Ok(task)
    }

    /// Ordered by status (active work first), priority, then position.
    pub fn list_tasks(
        &self,
        workspace_id: &str,
        status: Option<TaskStatus>,
        assignee: Option<&str>,
        events: Option<usize>,
    ) -> StoreResult<Vec<Task>> {
        let ids: Vec<String> = {
            let mut stmt = self.conn.prepare_cached(
                "SELECT id FROM tasks
                 WHERE workspace_id = ?1
                   AND (?2 IS NULL OR status = ?2)
                   AND (?3 IS NULL OR assignee = ?3)
                 ORDER BY CASE status
                            WHEN 'in_progress' THEN 0 WHEN 'todo' THEN 1 WHEN 'blocked' THEN 2
                            WHEN 'review' THEN 3 ELSE 4 END,
                          priority, position, created_at",
            )?;
            let rows = stmt.query_map(
                params![workspace_id, status.map(TaskStatus::as_str), assignee],
                |row| row.get(0),
            )?;
            rows.collect::<Result<_, _>>()?
        };
        ids.iter().map(|id| self.load_task(id, events)).collect()
    }

    pub fn get_task(&self, workspace_id: &str, id: &str) -> StoreResult<Task> {
        let id = self.task_id(workspace_id, id)?;
        self.load_task(&id, Some(TASK_EVENTS_SHOWN))
    }

    pub fn create_task(
        &mut self,
        workspace_id: &str,
        created_by: &str,
        new: NewTask,
    ) -> StoreResult<Task> {
        let title = clean_title(&new.title)?;
        let description = clean_body(
            new.description.as_deref().unwrap_or(""),
            "description",
            true,
        )?;
        let labels = clean_labels(&new.labels)?;
        let mut depends_on: Vec<String> = Vec::new();
        for dep in &new.depends_on {
            let id = self.task_id(workspace_id, dep).map_err(|_| {
                StoreError::Invalid(format!(
                    "dependency {} is not a task in this workspace",
                    dep
                ))
            })?;
            if !depends_on.contains(&id) {
                depends_on.push(id);
            }
        }
        let priority = new.priority.unwrap_or(TaskPriority::Medium);
        let assignee = new.assignee.filter(|id| !id.trim().is_empty());
        let status = if assignee.is_some() {
            TaskStatus::InProgress
        } else {
            TaskStatus::Todo
        };
        let at = now_millis();
        let tx = self.conn.transaction()?;
        let seq: i64 = tx.query_row(
            "UPDATE counters SET value = value + 1 WHERE name = 'task' RETURNING value",
            [],
            |row| row.get(0),
        )?;
        let id = format!("T-{}", seq);
        let position = end_of_column(&tx, workspace_id, status)?;
        tx.execute(
            "INSERT INTO tasks(id, workspace_id, title, description, status, priority, assignee,
                               created_by, labels, position, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
            params![
                id,
                workspace_id,
                title,
                description,
                status.as_str(),
                priority.rank(),
                assignee,
                created_by,
                serde_json::to_string(&labels).unwrap_or_else(|_| "[]".into()),
                position,
                at
            ],
        )?;
        for dep in &depends_on {
            tx.execute(
                "INSERT INTO task_deps(task_id, depends_on) VALUES (?1, ?2)",
                params![id, dep],
            )?;
        }
        add_event(&tx, &id, created_by, "created", "", at)?;
        if let Some(assignee) = &assignee {
            add_event(&tx, &id, created_by, "assigned", assignee, at)?;
        }
        tx.commit()?;
        self.load_task(&id, Some(TASK_EVENTS_SHOWN))
    }

    /// Take a `todo` task. The conditional UPDATE is the lock: of two agents
    /// racing for a task, exactly one sees its row change.
    pub fn claim_task(&mut self, workspace_id: &str, id: &str, who: &str) -> StoreResult<Task> {
        let id = self.task_id(workspace_id, id)?;
        let task = self.load_task(&id, None)?;
        if !task.blocked_by.is_empty() {
            return Err(StoreError::Conflict(format!(
                "task {} depends on unfinished tasks: {}",
                id,
                task.blocked_by.join(", ")
            )));
        }
        let at = now_millis();
        let tx = self.conn.transaction()?;
        let position = end_of_column(&tx, workspace_id, TaskStatus::InProgress)?;
        let changed = tx.execute(
            "UPDATE tasks SET assignee = ?1, status = 'in_progress', position = ?2, updated_at = ?3
             WHERE id = ?4 AND workspace_id = ?5 AND assignee IS NULL AND status = 'todo'",
            params![who, position, at, id, workspace_id],
        )?;
        if changed == 0 {
            let (owner, status): (Option<String>, String) = tx.query_row(
                "SELECT assignee, status FROM tasks WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            return Err(StoreError::Conflict(match owner {
                Some(owner) if owner == who => format!("you already hold task {}", id),
                Some(owner) => format!("task {} is already claimed by {}", id, owner),
                None => format!(
                    "task {} is `{}`; only `todo` tasks can be claimed",
                    id, status
                ),
            }));
        }
        add_event(&tx, &id, who, "claimed", "", at)?;
        tx.commit()?;
        self.load_task(&id, Some(TASK_EVENTS_SHOWN))
    }

    pub fn update_task(
        &mut self,
        workspace_id: &str,
        id: &str,
        actor: &str,
        patch: TaskPatch,
    ) -> StoreResult<Task> {
        let id = self.task_id(workspace_id, id)?;
        let before = self.load_task(&id, None)?;
        let title = patch.title.as_deref().map(clean_title).transpose()?;
        let description = patch
            .description
            .as_deref()
            .map(|value| clean_body(value, "description", true))
            .transpose()?;
        let note = patch
            .note
            .as_deref()
            .map(|value| clean_body(value, "note", false))
            .transpose()?;
        let assignee = patch
            .assignee
            .map(|value| value.filter(|id| !id.trim().is_empty()));
        if let Some(position) = patch.position {
            if !position.is_finite() {
                return Err(StoreError::Invalid(
                    "position must be a finite number".into(),
                ));
            }
        }
        let at = now_millis();
        let tx = self.conn.transaction()?;
        if let Some(title) = &title {
            tx.execute(
                "UPDATE tasks SET title = ?1 WHERE id = ?2",
                params![title, id],
            )?;
        }
        if let Some(description) = &description {
            tx.execute(
                "UPDATE tasks SET description = ?1 WHERE id = ?2",
                params![description, id],
            )?;
        }
        if let Some(priority) = patch.priority {
            tx.execute(
                "UPDATE tasks SET priority = ?1 WHERE id = ?2",
                params![priority.rank(), id],
            )?;
        }
        if let Some(status) = patch.status.filter(|status| *status != before.status) {
            // A task that changes column goes to the end of the new one
            // unless the caller placed it explicitly.
            let position = match patch.position {
                Some(position) => position,
                None => end_of_column(&tx, workspace_id, status)?,
            };
            tx.execute(
                "UPDATE tasks SET status = ?1, position = ?2 WHERE id = ?3",
                params![status.as_str(), position, id],
            )?;
            add_event(
                &tx,
                &id,
                actor,
                "status",
                &format!("{} → {}", before.status.as_str(), status.as_str()),
                at,
            )?;
        } else if let Some(position) = patch.position {
            tx.execute(
                "UPDATE tasks SET position = ?1 WHERE id = ?2",
                params![position, id],
            )?;
        }
        if let Some(assignee) = &assignee {
            if assignee.as_deref() != before.assignee.as_deref() {
                tx.execute(
                    "UPDATE tasks SET assignee = ?1 WHERE id = ?2",
                    params![assignee, id],
                )?;
                add_event(
                    &tx,
                    &id,
                    actor,
                    "assigned",
                    assignee.as_deref().unwrap_or(""),
                    at,
                )?;
            }
        }
        if let Some(note) = &note {
            add_event(&tx, &id, actor, "note", note, at)?;
        }
        tx.execute(
            "UPDATE tasks SET updated_at = ?1 WHERE id = ?2",
            params![at, id],
        )?;
        tx.commit()?;
        self.load_task(&id, Some(TASK_EVENTS_SHOWN))
    }

    /// Hand work in for review. Only the assignee (or anyone, while the task
    /// is unassigned) can complete it.
    pub fn complete_task(
        &mut self,
        workspace_id: &str,
        id: &str,
        who: &str,
        summary: &str,
    ) -> StoreResult<Task> {
        let summary = clean_body(summary, "summary", false)?;
        let id = self.task_id(workspace_id, id)?;
        let task = self.load_task(&id, None)?;
        if let Some(owner) = task.assignee.as_deref() {
            if owner != who {
                return Err(StoreError::Conflict(format!(
                    "task {} is assigned to {}; only they can complete it",
                    id, owner
                )));
            }
        }
        if task.status == TaskStatus::Done {
            return Err(StoreError::Conflict(format!("task {} is already done", id)));
        }
        let at = now_millis();
        let tx = self.conn.transaction()?;
        let position = if task.status == TaskStatus::Review {
            task.position
        } else {
            end_of_column(&tx, workspace_id, TaskStatus::Review)?
        };
        tx.execute(
            "UPDATE tasks SET status = 'review', assignee = ?1, position = ?2, updated_at = ?3 WHERE id = ?4",
            params![who, position, at, id],
        )?;
        add_event(&tx, &id, who, "completed", &summary, at)?;
        tx.commit()?;
        self.load_task(&id, Some(TASK_EVENTS_SHOWN))
    }

    pub fn delete_task(&mut self, workspace_id: &str, id: &str) -> StoreResult<()> {
        let id = self.task_id(workspace_id, id)?;
        self.conn
            .execute("DELETE FROM tasks WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ----- messages -------------------------------------------------------

    fn load_message(&self, id: i64) -> StoreResult<Message> {
        let mut message = self.conn.query_row(
            "SELECT id, workspace_id, sender, recipient, body, created_at FROM messages WHERE id = ?1",
            params![id],
            |row| {
                Ok(Message {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    from: row.get(2)?,
                    to: row.get(3)?,
                    body: row.get(4)?,
                    created_at: row.get(5)?,
                    read_by: Vec::new(),
                })
            },
        )?;
        let mut stmt = self.conn.prepare_cached(
            "SELECT reader FROM message_reads WHERE message_id = ?1 ORDER BY rowid",
        )?;
        let readers = stmt.query_map(params![id], |row| row.get::<_, String>(0))?;
        message.read_by = readers.collect::<Result<_, _>>()?;
        Ok(message)
    }

    pub fn send_message(
        &mut self,
        workspace_id: &str,
        from: &str,
        to: &str,
        body: &str,
    ) -> StoreResult<Message> {
        let body = clean_body(body, "message", false)?;
        let to = to.trim();
        if to.is_empty() {
            return Err(StoreError::Invalid("recipient cannot be empty".into()));
        }
        self.conn.execute(
            "INSERT INTO messages(workspace_id, sender, recipient, body, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![workspace_id, from, to, body, now_millis()],
        )?;
        let id = self.conn.last_insert_rowid();
        self.load_message(id)
    }

    /// Messages sent to `reader` or to `all`, oldest first, at most `limit`.
    /// Every returned message is recorded as read by `reader`.
    pub fn read_inbox(
        &mut self,
        workspace_id: &str,
        reader: &str,
        unread_only: bool,
        limit: Option<usize>,
    ) -> StoreResult<Vec<Message>> {
        let limit = clamp_limit(limit, DEFAULT_INBOX_LIMIT);
        let ids: Vec<i64> = {
            let mut stmt = self.conn.prepare_cached(
                "SELECT id FROM messages m
                 WHERE workspace_id = ?1 AND (recipient = ?2 OR recipient = 'all') AND sender != ?2
                   AND (?3 = 0 OR NOT EXISTS (
                        SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.reader = ?2))
                 ORDER BY id LIMIT ?4",
            )?;
            let rows = stmt.query_map(
                params![workspace_id, reader, unread_only as i64, limit as i64],
                |row| row.get(0),
            )?;
            rows.collect::<Result<_, _>>()?
        };
        let tx = self.conn.transaction()?;
        for id in &ids {
            tx.execute(
                "INSERT OR IGNORE INTO message_reads(message_id, reader) VALUES (?1, ?2)",
                params![id, reader],
            )?;
        }
        tx.commit()?;
        ids.into_iter().map(|id| self.load_message(id)).collect()
    }

    pub fn unread_count(&self, workspace_id: &str, reader: &str) -> StoreResult<usize> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM messages m
             WHERE workspace_id = ?1 AND (recipient = ?2 OR recipient = 'all') AND sender != ?2
               AND NOT EXISTS (
                    SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.reader = ?2)",
            params![workspace_id, reader],
            |row| row.get(0),
        )?;
        Ok(count as usize)
    }

    // ----- notes ----------------------------------------------------------

    fn load_note(&self, id: i64) -> StoreResult<Note> {
        Ok(self.conn.query_row(
            "SELECT id, workspace_id, key, body, author, created_at, updated_at FROM notes WHERE id = ?1",
            params![id],
            |row| {
                Ok(Note {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    key: row.get(2)?,
                    body: row.get(3)?,
                    author: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            },
        )?)
    }

    /// Save a note. A note with the same `key` is updated in place, so keys
    /// work as named facts ("test-command", "api-conventions").
    pub fn add_note(
        &mut self,
        workspace_id: &str,
        author: &str,
        body: &str,
        key: Option<&str>,
    ) -> StoreResult<Note> {
        let body = clean_body(body, "note", false)?;
        let key = key.map(str::trim).filter(|key| !key.is_empty());
        if key.is_some_and(|key| key.chars().count() > 80) {
            return Err(StoreError::Invalid(
                "note key is longer than 80 characters".into(),
            ));
        }
        let at = now_millis();
        let id: i64 = self.conn.query_row(
            "INSERT INTO notes(workspace_id, key, body, author, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT(workspace_id, key) WHERE key IS NOT NULL
             DO UPDATE SET body = excluded.body, author = excluded.author, updated_at = excluded.updated_at
             RETURNING id",
            params![workspace_id, key, body, author, at],
            |row| row.get(0),
        )?;
        self.load_note(id)
    }

    /// Full-text search over key and body, best matches first. An empty
    /// query lists the most recently updated notes.
    pub fn search_notes(
        &self,
        workspace_id: &str,
        query: &str,
        limit: Option<usize>,
    ) -> StoreResult<Vec<Note>> {
        let limit = clamp_limit(limit, DEFAULT_SEARCH_LIMIT) as i64;
        let ids: Vec<i64> = match fts_query(query) {
            Some(fts) => {
                let mut stmt = self.conn.prepare_cached(
                    "SELECT n.id FROM notes_fts f JOIN notes n ON n.id = f.rowid
                     WHERE notes_fts MATCH ?1 AND n.workspace_id = ?2
                     ORDER BY bm25(notes_fts, 2.0, 1.0), n.updated_at DESC LIMIT ?3",
                )?;
                let rows = stmt.query_map(params![fts, workspace_id, limit], |row| row.get(0))?;
                rows.collect::<Result<_, _>>()?
            }
            None => {
                let mut stmt = self.conn.prepare_cached(
                    "SELECT id FROM notes WHERE workspace_id = ?1
                     ORDER BY updated_at DESC, id DESC LIMIT ?2",
                )?;
                let rows = stmt.query_map(params![workspace_id, limit], |row| row.get(0))?;
                rows.collect::<Result<_, _>>()?
            }
        };
        ids.into_iter().map(|id| self.load_note(id)).collect()
    }

    // ----- agent status (memory only) -------------------------------------

    pub fn report_status(
        &mut self,
        workspace_id: &str,
        terminal_id: &str,
        state: AgentState,
        summary: &str,
    ) -> StoreResult<AgentStatus> {
        let summary = summary.trim();
        if summary.chars().count() > 500 {
            return Err(StoreError::Invalid(
                "summary is longer than 500 characters".into(),
            ));
        }
        let status = AgentStatus {
            terminal_id: terminal_id.to_string(),
            workspace_id: workspace_id.to_string(),
            state,
            summary: summary.to_string(),
            updated_at: now_millis(),
        };
        self.statuses
            .insert(terminal_id.to_string(), status.clone());
        Ok(status)
    }

    pub fn status_of(&self, terminal_id: &str) -> Option<&AgentStatus> {
        self.statuses.get(terminal_id)
    }

    pub fn statuses(&self, workspace_id: &str) -> Vec<AgentStatus> {
        let mut list: Vec<AgentStatus> = self
            .statuses
            .values()
            .filter(|status| status.workspace_id == workspace_id)
            .cloned()
            .collect();
        list.sort_by(|a, b| a.terminal_id.cmp(&b.terminal_id));
        list
    }

    pub fn forget_status(&mut self, terminal_id: &str) {
        self.statuses.remove(terminal_id);
    }

    #[cfg(test)]
    fn count(&self, table: &str) -> i64 {
        self.conn
            .query_row(&format!("SELECT COUNT(*) FROM {}", table), [], |row| {
                row.get(0)
            })
            .unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier, Mutex};

    fn task(title: &str) -> NewTask {
        NewTask {
            title: title.into(),
            ..NewTask::default()
        }
    }

    fn set_status(repo: &mut Repo, id: &str, status: TaskStatus) {
        repo.update_task(
            "ws-1",
            id,
            "user",
            TaskPatch {
                status: Some(status),
                ..TaskPatch::default()
            },
        )
        .unwrap();
    }

    #[test]
    fn task_crud_with_dependencies_and_events() {
        let mut repo = Repo::in_memory();
        let base = repo.create_task("ws-1", "t-1", task("Lexer")).unwrap();
        let created = repo
            .create_task(
                "ws-1",
                "t-1",
                NewTask {
                    title: "  Write the parser ".into(),
                    description: Some("tokens first".into()),
                    priority: Some(TaskPriority::High),
                    labels: vec!["backend".into(), "backend".into(), " ".into()],
                    depends_on: vec!["t-1".into(), "1".into()],
                    ..NewTask::default()
                },
            )
            .unwrap();
        assert_eq!(base.id, "T-1");
        assert_eq!(created.id, "T-2");
        assert_eq!(created.title, "Write the parser");
        assert_eq!(created.status, TaskStatus::Todo);
        assert_eq!(created.priority, TaskPriority::High);
        assert_eq!(created.labels, vec!["backend".to_string()]);
        assert_eq!(created.depends_on, vec!["T-1".to_string()]);
        assert_eq!(created.blocked_by, vec!["T-1".to_string()]);
        assert_eq!(created.position, 2.0);
        assert_eq!(created.events.as_ref().unwrap()[0].kind, "created");

        let updated = repo
            .update_task(
                "ws-1",
                "T-2",
                "user",
                TaskPatch {
                    status: Some(TaskStatus::Blocked),
                    note: Some("waiting on the lexer".into()),
                    ..TaskPatch::default()
                },
            )
            .unwrap();
        assert_eq!(updated.status, TaskStatus::Blocked);
        let kinds: Vec<&str> = updated
            .events
            .as_ref()
            .unwrap()
            .iter()
            .map(|e| e.kind.as_str())
            .collect();
        assert_eq!(kinds, vec!["created", "status", "note"]);
        assert_eq!(updated.events.as_ref().unwrap()[1].body, "todo → blocked");

        set_status(&mut repo, "T-1", TaskStatus::Done);
        assert!(repo.get_task("ws-1", "T-2").unwrap().blocked_by.is_empty());

        repo.delete_task("ws-1", "T-1").unwrap();
        assert!(matches!(
            repo.get_task("ws-1", "T-1"),
            Err(StoreError::NotFound(_))
        ));
        // Deleting a task cascades to its dependency links and events.
        assert!(repo.get_task("ws-1", "T-2").unwrap().depends_on.is_empty());
        assert_eq!(repo.count("task_deps"), 0);
    }

    #[test]
    fn list_orders_by_status_priority_and_position() {
        let mut repo = Repo::in_memory();
        repo.create_task("ws-1", "u", task("medium first")).unwrap(); // T-1
        repo.create_task(
            "ws-1",
            "u",
            NewTask {
                title: "urgent".into(),
                priority: Some(TaskPriority::Urgent),
                ..NewTask::default()
            },
        )
        .unwrap(); // T-2
        repo.create_task("ws-1", "u", task("medium second"))
            .unwrap(); // T-3
        repo.create_task("ws-1", "u", task("in progress")).unwrap(); // T-4
        repo.create_task("ws-1", "u", task("finished")).unwrap(); // T-5
        set_status(&mut repo, "T-4", TaskStatus::InProgress);
        set_status(&mut repo, "T-5", TaskStatus::Done);
        // Same priority: T-3 is moved ahead of T-1 inside the column.
        repo.update_task(
            "ws-1",
            "T-3",
            "u",
            TaskPatch {
                position: Some(0.5),
                ..TaskPatch::default()
            },
        )
        .unwrap();

        let ids: Vec<String> = repo
            .list_tasks("ws-1", None, None, None)
            .unwrap()
            .into_iter()
            .map(|t| t.id)
            .collect();
        assert_eq!(ids, vec!["T-4", "T-2", "T-3", "T-1", "T-5"]);
        assert!(repo.list_tasks("ws-1", None, None, None).unwrap()[0]
            .events
            .is_none());
        assert_eq!(
            repo.list_tasks("ws-1", Some(TaskStatus::Todo), None, None)
                .unwrap()
                .len(),
            3
        );
        // Moving to a new column without a position lands at its end.
        let moved = repo
            .update_task(
                "ws-1",
                "T-2",
                "u",
                TaskPatch {
                    status: Some(TaskStatus::Done),
                    ..TaskPatch::default()
                },
            )
            .unwrap();
        assert_eq!(moved.position, 2.0);
    }

    #[test]
    fn tasks_are_invisible_from_other_workspaces() {
        let mut repo = Repo::in_memory();
        repo.create_task("ws-1", "t-1", task("secret")).unwrap();
        assert!(repo
            .list_tasks("ws-2", None, None, None)
            .unwrap()
            .is_empty());
        assert!(matches!(
            repo.get_task("ws-2", "T-1"),
            Err(StoreError::NotFound(_))
        ));
        assert!(repo.claim_task("ws-2", "T-1", "t-9").is_err());
        assert!(repo.delete_task("ws-2", "T-1").is_err());
        assert!(repo
            .create_task(
                "ws-2",
                "t-9",
                NewTask {
                    title: "x".into(),
                    depends_on: vec!["T-1".into()],
                    ..NewTask::default()
                }
            )
            .is_err());
    }

    #[test]
    fn rejects_bad_input() {
        let mut repo = Repo::in_memory();
        assert!(matches!(
            repo.create_task("ws-1", "t-1", task("   ")),
            Err(StoreError::Invalid(_))
        ));
        assert!(repo
            .create_task("ws-1", "t-1", task(&"x".repeat(MAX_TITLE_CHARS + 1)))
            .is_err());
        assert!(repo
            .send_message("ws-1", "t-1", "all", &"x".repeat(MAX_BODY_BYTES + 1))
            .is_err());
        assert!(repo.add_note("ws-1", "t-1", "", None).is_err());
        repo.create_task("ws-1", "t-1", task("x")).unwrap();
        assert!(repo
            .update_task(
                "ws-1",
                "T-1",
                "u",
                TaskPatch {
                    position: Some(f64::NAN),
                    ..TaskPatch::default()
                }
            )
            .is_err());
    }

    #[test]
    fn claim_needs_a_free_todo_task_with_finished_dependencies() {
        let mut repo = Repo::in_memory();
        let first = repo.create_task("ws-1", "t-1", task("first")).unwrap();
        let second = repo
            .create_task(
                "ws-1",
                "t-1",
                NewTask {
                    title: "second".into(),
                    depends_on: vec![first.id.clone()],
                    ..NewTask::default()
                },
            )
            .unwrap();

        let err = repo.claim_task("ws-1", &second.id, "t-2").unwrap_err();
        assert!(err.to_string().contains("T-1"), "{}", err);

        let claimed = repo.claim_task("ws-1", &first.id, "t-2").unwrap();
        assert_eq!(claimed.assignee.as_deref(), Some("t-2"));
        assert_eq!(claimed.status, TaskStatus::InProgress);
        assert_eq!(
            claimed.events.as_ref().unwrap().last().unwrap().kind,
            "claimed"
        );
        assert_eq!(
            repo.claim_task("ws-1", &first.id, "t-3").unwrap_err(),
            StoreError::Conflict("task T-1 is already claimed by t-2".into())
        );
        assert_eq!(
            repo.claim_task("ws-1", &first.id, "t-2").unwrap_err(),
            StoreError::Conflict("you already hold task T-1".into())
        );

        let third = repo.create_task("ws-1", "t-1", task("third")).unwrap();
        set_status(&mut repo, &third.id, TaskStatus::Blocked);
        assert!(repo
            .claim_task("ws-1", &third.id, "t-2")
            .unwrap_err()
            .to_string()
            .contains("only `todo`"));

        assert!(matches!(
            repo.complete_task("ws-1", &first.id, "t-3", "done"),
            Err(StoreError::Conflict(_))
        ));
        let reviewed = repo
            .complete_task("ws-1", &first.id, "t-2", "parser works")
            .unwrap();
        assert_eq!(reviewed.status, TaskStatus::Review);
        let last = reviewed.events.as_ref().unwrap().last().unwrap().clone();
        assert_eq!(
            (last.kind.as_str(), last.body.as_str()),
            ("completed", "parser works")
        );
    }

    #[test]
    fn concurrent_claims_have_exactly_one_winner() {
        let repo = Arc::new(Mutex::new(Repo::in_memory()));
        let id = repo
            .lock()
            .unwrap()
            .create_task("ws-1", "t-1", task("race"))
            .unwrap()
            .id;
        let agents = 8;
        let barrier = Arc::new(Barrier::new(agents));
        let handles: Vec<_> = (0..agents)
            .map(|n| {
                let repo = Arc::clone(&repo);
                let barrier = Arc::clone(&barrier);
                let id = id.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    repo.lock()
                        .unwrap()
                        .claim_task("ws-1", &id, &format!("t-{}", n + 10))
                        .is_ok()
                })
            })
            .collect();
        let winners = handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .filter(|won| *won)
            .count();
        assert_eq!(winners, 1);
    }

    #[test]
    fn claim_is_atomic_across_connections() {
        // Two connections to one file: the guarded UPDATE alone must stop the
        // second claim, even without the in-process mutex.
        let dir = std::env::temp_dir().join(format!("terra-mcp-claim-{}", now_millis()));
        let path = dir.join("mcp.db");
        let mut one = Repo::new(super::super::db::open(&path).unwrap());
        let mut two = Repo::new(super::super::db::open(&path).unwrap());
        let id = one.create_task("ws-1", "t-1", task("shared")).unwrap().id;
        assert!(one.claim_task("ws-1", &id, "t-1").is_ok());
        assert_eq!(
            two.claim_task("ws-1", &id, "t-2").unwrap_err(),
            StoreError::Conflict("task T-1 is already claimed by t-1".into())
        );
        drop((one, two));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn inbox_separates_direct_and_broadcast_and_marks_read() {
        let mut repo = Repo::in_memory();
        repo.send_message("ws-1", "t-1", "t-2", "hi two").unwrap();
        repo.send_message("ws-1", "t-1", "all", "hi all").unwrap();
        repo.send_message("ws-1", "t-2", "all", "mine").unwrap();
        repo.send_message("ws-1", "t-1", "t-3", "not for two")
            .unwrap();
        repo.send_message("ws-2", "t-8", "all", "other project")
            .unwrap();

        assert_eq!(repo.unread_count("ws-1", "t-2").unwrap(), 2);
        let inbox = repo.read_inbox("ws-1", "t-2", true, None).unwrap();
        let bodies: Vec<&str> = inbox.iter().map(|m| m.body.as_str()).collect();
        assert_eq!(bodies, vec!["hi two", "hi all"]);
        assert!(inbox.iter().all(|m| m.read_by.contains(&"t-2".to_string())));
        assert!(repo
            .read_inbox("ws-1", "t-2", true, None)
            .unwrap()
            .is_empty());
        assert_eq!(
            repo.read_inbox("ws-1", "t-2", false, None).unwrap().len(),
            2
        );
        // t-3 gets both broadcasts and its own direct message; `limit` reads one.
        assert_eq!(repo.unread_count("ws-1", "t-3").unwrap(), 3);
        assert_eq!(
            repo.read_inbox("ws-1", "t-3", true, Some(1)).unwrap()[0].body,
            "hi all"
        );
        assert_eq!(repo.unread_count("ws-1", "t-3").unwrap(), 2);
    }

    #[test]
    fn history_is_kept_in_full() {
        let mut repo = Repo::in_memory();
        for n in 0..700 {
            repo.send_message("ws-1", "t-1", "all", &format!("m{}", n))
                .unwrap();
        }
        assert_eq!(repo.count("messages"), 700);
        assert_eq!(
            repo.read_inbox("ws-1", "t-2", true, Some(MAX_LIMIT + 50))
                .unwrap()
                .len(),
            MAX_LIMIT
        );
        assert_eq!(
            repo.read_inbox("ws-1", "t-2", true, None).unwrap()[0].body,
            format!("m{}", MAX_LIMIT)
        );
        let id = repo.create_task("ws-1", "t-1", task("log")).unwrap().id;
        for n in 0..150 {
            repo.update_task(
                "ws-1",
                &id,
                "t-1",
                TaskPatch {
                    note: Some(format!("step {}", n)),
                    ..TaskPatch::default()
                },
            )
            .unwrap();
        }
        assert_eq!(repo.count("task_events"), 151);
        let shown = repo.get_task("ws-1", &id).unwrap().events.unwrap();
        assert_eq!(shown.len(), TASK_EVENTS_SHOWN);
        assert_eq!(shown.last().unwrap().body, "step 149");
    }

    #[test]
    fn keyed_notes_upsert_and_full_text_search() {
        let mut repo = Repo::in_memory();
        let first = repo
            .add_note("ws-1", "t-1", "npm test", Some("test-command"))
            .unwrap();
        let second = repo
            .add_note("ws-1", "t-2", "npm run test:unit", Some("test-command"))
            .unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(second.author, "t-2");
        assert_eq!(second.created_at, first.created_at);
        repo.add_note("ws-1", "t-1", "A API devolve JSON em snake_case", None)
            .unwrap();
        repo.add_note(
            "ws-1",
            "t-1",
            "Configuração do banco: migrações em db.rs",
            None,
        )
        .unwrap();
        repo.add_note("ws-2", "t-9", "npm elsewhere", None).unwrap();

        let hits = repo.search_notes("ws-1", "NPM unit", None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].body, "npm run test:unit");
        // Prefix and accent-insensitive matching.
        assert_eq!(
            repo.search_notes("ws-1", "configuracao migr", None)
                .unwrap()
                .len(),
            1
        );
        // The key is searchable too, and FTS syntax is taken literally.
        assert_eq!(
            repo.search_notes("ws-1", "test-command", None)
                .unwrap()
                .len(),
            1
        );
        assert!(repo
            .search_notes("ws-1", "\"unbalanced AND (", None)
            .is_ok());
        assert_eq!(repo.search_notes("ws-1", "", None).unwrap().len(), 3);
        assert_eq!(repo.search_notes("ws-1", "", Some(1)).unwrap().len(), 1);
        assert!(repo
            .search_notes("ws-1", "elsewhere", None)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn purge_removes_only_that_workspace() {
        let mut repo = Repo::in_memory();
        for ws in ["ws-1", "ws-2"] {
            let a = repo.create_task(ws, "t-1", task("a")).unwrap();
            repo.create_task(
                ws,
                "t-1",
                NewTask {
                    title: "b".into(),
                    depends_on: vec![a.id],
                    ..NewTask::default()
                },
            )
            .unwrap();
            let message = repo.send_message(ws, "t-1", "all", "hi").unwrap();
            repo.read_inbox(ws, "t-2", true, None).unwrap();
            assert!(message.id > 0);
            repo.add_note(ws, "t-1", "note", Some("k")).unwrap();
            repo.report_status(ws, &format!("{}-agent", ws), AgentState::Working, "")
                .unwrap();
        }
        repo.purge_workspace("ws-1").unwrap();
        assert!(repo
            .list_tasks("ws-1", None, None, None)
            .unwrap()
            .is_empty());
        assert!(repo.search_notes("ws-1", "", None).unwrap().is_empty());
        assert!(repo.statuses("ws-1").is_empty());
        assert_eq!(repo.list_tasks("ws-2", None, None, None).unwrap().len(), 2);
        assert_eq!(repo.count("task_deps"), 1);
        assert_eq!(repo.count("task_events"), 2);
        assert_eq!(repo.count("message_reads"), 1);
        assert_eq!(repo.count("notes_fts"), 1);

        repo.retain_workspaces(&HashSet::new()).unwrap();
        assert_eq!(repo.count("tasks"), 0);
        assert_eq!(repo.count("messages"), 0);
    }

    #[test]
    fn statuses_are_scoped_and_validated() {
        let mut repo = Repo::in_memory();
        repo.report_status("ws-1", "t-1", AgentState::Working, "parsing")
            .unwrap();
        repo.report_status("ws-2", "t-5", AgentState::Idle, "")
            .unwrap();
        assert_eq!(repo.statuses("ws-1").len(), 1);
        assert!(repo
            .report_status("ws-1", "t-1", AgentState::Idle, &"x".repeat(501))
            .is_err());
        repo.forget_status("t-1");
        assert!(repo.statuses("ws-1").is_empty());
    }

    #[test]
    fn data_and_setting_survive_a_reopen() {
        let dir = std::env::temp_dir().join(format!("terra-mcp-reopen-{}", now_millis()));
        let path = dir.join("mcp.db");
        {
            let mut repo = Repo::new(super::super::db::open(&path).unwrap());
            assert!(repo.enabled());
            repo.set_enabled(false).unwrap();
            repo.create_task("ws-1", "t-1", task("kept")).unwrap();
            repo.send_message("ws-1", "t-1", "all", "kept").unwrap();
            repo.add_note("ws-1", "t-1", "kept note", None).unwrap();
        }
        let mut repo = Repo::new(super::super::db::open(&path).unwrap());
        assert!(!repo.enabled());
        assert_eq!(repo.list_tasks("ws-1", None, None, None).unwrap().len(), 1);
        assert_eq!(repo.read_inbox("ws-1", "t-2", true, None).unwrap().len(), 1);
        assert_eq!(repo.search_notes("ws-1", "kept", None).unwrap().len(), 1);
        // Ids keep counting after a restart.
        assert_eq!(
            repo.create_task("ws-1", "t-1", task("next")).unwrap().id,
            "T-2"
        );
        drop(repo);
        let _ = std::fs::remove_dir_all(dir);
    }
}
