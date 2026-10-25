//! Queries behind the MCP tools and the Tasks panel: tasks, messages and
//! notes. Every call is scoped by `workspace_id`, which callers take from the
//! caller's token, never from the agent's arguments.
//!
//! Everything is in `mcp.db` and is kept in full (no size-based eviction).

use rusqlite::{params, Connection, OptionalExtension, Row, Transaction};
use std::collections::{HashMap, HashSet};

use super::model::{
    normalize_task_id, Message, NewTask, Note, StoreError, StoreResult, Task, TaskEvent, TaskPatch,
    TaskPriority, TaskStatus,
};

use crate::clock::now_millis;

pub const MAX_TITLE_CHARS: usize = 200;
/// Guards against runaway input; history itself is never trimmed.
pub const MAX_BODY_BYTES: usize = 64 * 1024;
pub const MAX_LABELS: usize = 16;
pub const MAX_LABEL_CHARS: usize = 40;
pub const MAX_NOTE_KEY_CHARS: usize = 80;
pub const DEFAULT_INBOX_LIMIT: usize = 50;
pub const DEFAULT_SEARCH_LIMIT: usize = 20;
pub const MAX_LIMIT: usize = 200;
pub const TASK_EVENTS_SHOWN: usize = 50;
/// The tables a workspace's rows live in; fixed at compile time, so they
/// can be named in SQL with `format!`.
const WORKSPACE_TABLES: [&str; 3] = ["tasks", "messages", "notes"];

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
        if label.chars().count() > MAX_LABEL_CHARS {
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

/// Child rows go with their parents through ON DELETE CASCADE.
fn delete_workspace_rows(tx: &Transaction<'_>, workspace_id: &str) -> StoreResult<()> {
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
    Ok(())
}

fn task_id(conn: &Connection, workspace_id: &str, raw: &str) -> StoreResult<String> {
    let id = normalize_task_id(raw).ok_or_else(|| task_not_found(raw))?;
    conn.query_row(
        "SELECT id FROM tasks WHERE id = ?1 AND workspace_id = ?2",
        params![id, workspace_id],
        |row| row.get(0),
    )
    .optional()?
    .ok_or_else(|| task_not_found(raw))
}

/// Resolve dependency ids with one query, keeping their order and dropping
/// duplicates. Any id that is not a task of the workspace is refused.
fn dependency_ids(
    conn: &Connection,
    workspace_id: &str,
    raw: &[String],
) -> StoreResult<Vec<String>> {
    if raw.is_empty() {
        return Ok(Vec::new());
    }
    let normalized: Vec<Option<String>> = raw.iter().map(|dep| normalize_task_id(dep)).collect();
    let candidates = normalized
        .iter()
        .flatten()
        .map(String::as_str)
        .collect::<serde_json::Value>()
        .to_string();
    let existing: HashSet<String> = {
        let mut stmt = conn.prepare_cached(
            "SELECT id FROM tasks
             WHERE workspace_id = ?1 AND id IN (SELECT value FROM json_each(?2))",
        )?;
        let rows = stmt.query_map(params![workspace_id, candidates], |row| row.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    let mut depends_on: Vec<String> = Vec::new();
    for (dep, id) in raw.iter().zip(normalized) {
        let Some(id) = id.filter(|id| existing.contains(id)) else {
            return Err(StoreError::Invalid(format!(
                "dependency {} is not a task in this workspace",
                dep
            )));
        };
        if !depends_on.contains(&id) {
            depends_on.push(id);
        }
    }
    Ok(depends_on)
}

fn task_from_row(row: &Row<'_>) -> rusqlite::Result<Task> {
    let id: String = row.get(0)?;
    let status: String = row.get(4)?;
    let labels: String = row.get(8)?;
    let labels = serde_json::from_str(&labels).unwrap_or_else(|error| {
        eprintln!("task {} has unreadable labels, showing none: {}", id, error);
        Vec::new()
    });
    Ok(Task {
        id,
        workspace_id: row.get(1)?,
        title: row.get(2)?,
        description: row.get(3)?,
        status: TaskStatus::parse(&status).unwrap_or(TaskStatus::Todo),
        priority: TaskPriority::from_rank(row.get(5)?),
        assignee: row.get(6)?,
        created_by: row.get(7)?,
        labels,
        position: row.get(9)?,
        depends_on: Vec::new(),
        blocked_by: Vec::new(),
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        events: None,
    })
}

fn load_task(
    conn: &Connection,
    workspace_id: &str,
    id: &str,
    events: Option<usize>,
) -> StoreResult<Task> {
    let mut task = conn
        .query_row(
            "SELECT id, workspace_id, title, description, status, priority, assignee, created_by,
                    labels, position, created_at, updated_at
             FROM tasks WHERE id = ?1 AND workspace_id = ?2",
            params![id, workspace_id],
            task_from_row,
        )
        .optional()?
        .ok_or_else(|| task_not_found(id))?;
    attach_task_details(conn, workspace_id, std::slice::from_mut(&mut task), events)?;
    Ok(task)
}

/// Fill the dependencies of `tasks` and, when `events` is set, their latest
/// events, with one query each however many tasks there are.
fn attach_task_details(
    conn: &Connection,
    workspace_id: &str,
    tasks: &mut [Task],
    events: Option<usize>,
) -> StoreResult<()> {
    let ids = tasks
        .iter()
        .map(|task| task.id.as_str())
        .collect::<serde_json::Value>()
        .to_string();
    let index: HashMap<String, usize> = tasks
        .iter()
        .enumerate()
        .map(|(position, task)| (task.id.clone(), position))
        .collect();
    {
        let mut stmt = conn.prepare_cached(
            "SELECT d.task_id, d.depends_on, t.status FROM task_deps d
             JOIN tasks t ON t.id = d.depends_on AND t.workspace_id = ?1
             WHERE d.task_id IN (SELECT value FROM json_each(?2))
             ORDER BY t.created_at",
        )?;
        let rows = stmt.query_map(params![workspace_id, ids], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (task_id, dep, status) = row?;
            let Some(task) = index.get(&task_id).and_then(|at| tasks.get_mut(*at)) else {
                continue;
            };
            if status != TaskStatus::Done.as_str() {
                task.blocked_by.push(dep.clone());
            }
            task.depends_on.push(dep);
        }
    }
    let Some(limit) = events else {
        return Ok(());
    };
    for task in tasks.iter_mut() {
        task.events = Some(Vec::new());
    }
    let mut stmt = conn.prepare_cached(
        "SELECT task_id, actor, kind, body, created_at FROM (
            SELECT id, task_id, actor, kind, body, created_at,
                   ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY id DESC) AS recency
            FROM task_events WHERE task_id IN (SELECT value FROM json_each(?1))
         ) WHERE recency <= ?2 ORDER BY id",
    )?;
    let rows = stmt.query_map(params![ids, limit as i64], |row| {
        Ok((
            row.get::<_, String>(0)?,
            TaskEvent {
                actor: row.get(1)?,
                kind: row.get(2)?,
                body: row.get(3)?,
                created_at: row.get(4)?,
            },
        ))
    })?;
    for row in rows {
        let (task_id, event) = row?;
        if let Some(events) = index
            .get(&task_id)
            .and_then(|at| tasks.get_mut(*at))
            .and_then(|task| task.events.as_mut())
        {
            events.push(event);
        }
    }
    Ok(())
}

/// The writes of `update_task`, inside the caller's transaction. Returns the
/// resolved task id.
fn apply_task_patch(
    tx: &Transaction<'_>,
    workspace_id: &str,
    id: &str,
    actor: &str,
    patch: TaskPatch,
) -> StoreResult<String> {
    let id = task_id(tx, workspace_id, id)?;
    let before = load_task(tx, workspace_id, &id, None)?;
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
    if let Some(title) = &title {
        tx.execute(
            "UPDATE tasks SET title = ?1 WHERE id = ?2 AND workspace_id = ?3",
            params![title, id, workspace_id],
        )?;
    }
    if let Some(description) = &description {
        tx.execute(
            "UPDATE tasks SET description = ?1 WHERE id = ?2 AND workspace_id = ?3",
            params![description, id, workspace_id],
        )?;
    }
    if let Some(priority) = patch.priority {
        tx.execute(
            "UPDATE tasks SET priority = ?1 WHERE id = ?2 AND workspace_id = ?3",
            params![priority.rank(), id, workspace_id],
        )?;
    }
    if let Some(status) = patch.status.filter(|status| *status != before.status) {
        // A task that changes column goes to the end of the new one
        // unless the caller placed it explicitly.
        let position = match patch.position {
            Some(position) => position,
            None => end_of_column(tx, workspace_id, status)?,
        };
        tx.execute(
            "UPDATE tasks SET status = ?1, position = ?2 WHERE id = ?3 AND workspace_id = ?4",
            params![status.as_str(), position, id, workspace_id],
        )?;
        add_event(
            tx,
            &id,
            actor,
            "status",
            &format!("{} → {}", before.status.as_str(), status.as_str()),
            at,
        )?;
    } else if let Some(position) = patch.position {
        tx.execute(
            "UPDATE tasks SET position = ?1 WHERE id = ?2 AND workspace_id = ?3",
            params![position, id, workspace_id],
        )?;
    }
    if let Some(assignee) = &assignee {
        if assignee.as_deref() != before.assignee.as_deref() {
            tx.execute(
                "UPDATE tasks SET assignee = ?1 WHERE id = ?2 AND workspace_id = ?3",
                params![assignee, id, workspace_id],
            )?;
            add_event(
                tx,
                &id,
                actor,
                "assigned",
                assignee.as_deref().unwrap_or(""),
                at,
            )?;
        }
    }
    if let Some(note) = &note {
        add_event(tx, &id, actor, "note", note, at)?;
    }
    tx.execute(
        "UPDATE tasks SET updated_at = ?1 WHERE id = ?2 AND workspace_id = ?3",
        params![at, id, workspace_id],
    )?;
    Ok(id)
}

fn message_from_row(row: &Row<'_>) -> rusqlite::Result<Message> {
    Ok(Message {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        from: row.get(2)?,
        to: row.get(3)?,
        body: row.get(4)?,
        created_at: row.get(5)?,
        read_by: Vec::new(),
    })
}

/// Fill `read_by` of `messages` with one query however many there are.
fn attach_readers(conn: &Connection, messages: &mut [Message]) -> StoreResult<()> {
    let ids = messages
        .iter()
        .map(|message| message.id)
        .collect::<serde_json::Value>()
        .to_string();
    let index: HashMap<i64, usize> = messages
        .iter()
        .enumerate()
        .map(|(position, message)| (message.id, position))
        .collect();
    let mut stmt = conn.prepare_cached(
        "SELECT message_id, reader FROM message_reads
         WHERE message_id IN (SELECT value FROM json_each(?1)) ORDER BY rowid",
    )?;
    let rows = stmt.query_map(params![ids], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (message_id, reader) = row?;
        if let Some(message) = index.get(&message_id).and_then(|at| messages.get_mut(*at)) {
            message.read_by.push(reader);
        }
    }
    Ok(())
}

fn load_message(conn: &Connection, workspace_id: &str, id: i64) -> StoreResult<Message> {
    let mut message = conn
        .query_row(
            "SELECT id, workspace_id, sender, recipient, body, created_at FROM messages
             WHERE id = ?1 AND workspace_id = ?2",
            params![id, workspace_id],
            message_from_row,
        )
        .optional()?
        .ok_or_else(|| {
            StoreError::NotFound(format!("message {} not found in this workspace", id))
        })?;
    attach_readers(conn, std::slice::from_mut(&mut message))?;
    Ok(message)
}

fn insert_message(
    conn: &Connection,
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
    conn.execute(
        "INSERT INTO messages(workspace_id, sender, recipient, body, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![workspace_id, from, to, body, now_millis()],
    )?;
    load_message(conn, workspace_id, conn.last_insert_rowid())
}

fn note_from_row(row: &Row<'_>) -> rusqlite::Result<Note> {
    Ok(Note {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        key: row.get(2)?,
        body: row.get(3)?,
        author: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn load_note(conn: &Connection, workspace_id: &str, id: i64) -> StoreResult<Note> {
    conn.query_row(
        "SELECT id, workspace_id, key, body, author, created_at, updated_at FROM notes
         WHERE id = ?1 AND workspace_id = ?2",
        params![id, workspace_id],
        note_from_row,
    )
    .optional()?
    .ok_or_else(|| StoreError::NotFound(format!("note {} not found in this workspace", id)))
}

pub struct Repo {
    conn: Connection,
}

impl Repo {
    pub fn new(conn: Connection) -> Self {
        Self { conn }
    }

    #[cfg(test)]
    pub fn in_memory() -> Self {
        Self::new(super::db::open_in_memory())
    }

    // ----- settings -------------------------------------------------------

    /// Whether terminals get the MCP server injected. On unless turned off.
    pub fn enabled(&self) -> bool {
        match self
            .conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'enabled'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
        {
            Ok(value) => value.is_none_or(|value| value != "0"),
            Err(error) => {
                eprintln!(
                    "cannot read the MCP enabled setting, assuming on: {}",
                    error
                );
                true
            }
        }
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
        delete_workspace_rows(&tx, workspace_id)?;
        tx.commit()?;
        Ok(())
    }

    /// Purge workspaces that disappeared while the app was not running, all
    /// in one transaction.
    pub fn retain_workspaces(&mut self, known: &HashSet<String>) -> StoreResult<()> {
        let mut gone: Vec<String> = Vec::new();
        for table in WORKSPACE_TABLES {
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
        let tx = self.conn.transaction()?;
        for id in &gone {
            delete_workspace_rows(&tx, id)?;
        }
        tx.commit()?;
        Ok(())
    }

    // ----- tasks ----------------------------------------------------------

    /// Ordered by status (active work first), priority, then position.
    pub fn list_tasks(
        &self,
        workspace_id: &str,
        status: Option<TaskStatus>,
        assignee: Option<&str>,
        events: Option<usize>,
    ) -> StoreResult<Vec<Task>> {
        let mut tasks: Vec<Task> = {
            let mut stmt = self.conn.prepare_cached(
                "SELECT id, workspace_id, title, description, status, priority, assignee, created_by,
                        labels, position, created_at, updated_at
                 FROM tasks
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
                task_from_row,
            )?;
            rows.collect::<Result<_, _>>()?
        };
        attach_task_details(&self.conn, workspace_id, &mut tasks, events)?;
        Ok(tasks)
    }

    pub fn get_task(&self, workspace_id: &str, id: &str) -> StoreResult<Task> {
        let id = task_id(&self.conn, workspace_id, id)?;
        load_task(&self.conn, workspace_id, &id, Some(TASK_EVENTS_SHOWN))
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
        let priority = new.priority.unwrap_or(TaskPriority::Medium);
        let assignee = new.assignee.filter(|id| !id.trim().is_empty());
        let status = if assignee.is_some() {
            TaskStatus::InProgress
        } else {
            TaskStatus::Todo
        };
        let at = now_millis();
        let tx = self.conn.transaction()?;
        let depends_on = dependency_ids(&tx, workspace_id, &new.depends_on)?;
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
        load_task(&self.conn, workspace_id, &id, Some(TASK_EVENTS_SHOWN))
    }

    /// Take a `todo` task. The conditional UPDATE is the lock: of two agents
    /// racing for a task, exactly one sees its row change.
    pub fn claim_task(&mut self, workspace_id: &str, id: &str, who: &str) -> StoreResult<Task> {
        let at = now_millis();
        let tx = self.conn.transaction()?;
        let id = task_id(&tx, workspace_id, id)?;
        let task = load_task(&tx, workspace_id, &id, None)?;
        if !task.blocked_by.is_empty() {
            return Err(StoreError::Conflict(format!(
                "task {} depends on unfinished tasks: {}",
                id,
                task.blocked_by.join(", ")
            )));
        }
        let position = end_of_column(&tx, workspace_id, TaskStatus::InProgress)?;
        let changed = tx.execute(
            "UPDATE tasks SET assignee = ?1, status = 'in_progress', position = ?2, updated_at = ?3
             WHERE id = ?4 AND workspace_id = ?5 AND assignee IS NULL AND status = 'todo'",
            params![who, position, at, id, workspace_id],
        )?;
        if changed == 0 {
            let (owner, status): (Option<String>, String) = tx.query_row(
                "SELECT assignee, status FROM tasks WHERE id = ?1 AND workspace_id = ?2",
                params![id, workspace_id],
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
        load_task(&self.conn, workspace_id, &id, Some(TASK_EVENTS_SHOWN))
    }

    pub fn update_task(
        &mut self,
        workspace_id: &str,
        id: &str,
        actor: &str,
        patch: TaskPatch,
    ) -> StoreResult<Task> {
        let tx = self.conn.transaction()?;
        let id = apply_task_patch(&tx, workspace_id, id, actor, patch)?;
        tx.commit()?;
        load_task(&self.conn, workspace_id, &id, Some(TASK_EVENTS_SHOWN))
    }

    /// Hand a task to `to` and tell them in a message: both are written or
    /// neither is. Done tasks and tasks with unfinished dependencies can't be
    /// assigned; a `todo` task moves to `in_progress`.
    pub fn assign_task(
        &mut self,
        workspace_id: &str,
        id: &str,
        by: &str,
        to: &str,
        note: Option<&str>,
    ) -> StoreResult<(Task, Message)> {
        let tx = self.conn.transaction()?;
        let id = task_id(&tx, workspace_id, id)?;
        let current = load_task(&tx, workspace_id, &id, None)?;
        if !current.blocked_by.is_empty() {
            return Err(StoreError::Conflict(format!(
                "task {} depends on unfinished tasks: {}",
                id,
                current.blocked_by.join(", ")
            )));
        }
        if current.status == TaskStatus::Done {
            return Err(StoreError::Conflict(format!("task {} is already done", id)));
        }
        apply_task_patch(
            &tx,
            workspace_id,
            &id,
            by,
            TaskPatch {
                assignee: Some(Some(to.to_string())),
                status: (current.status == TaskStatus::Todo).then_some(TaskStatus::InProgress),
                ..TaskPatch::default()
            },
        )?;
        let task = load_task(&tx, workspace_id, &id, Some(TASK_EVENTS_SHOWN))?;
        let body = match note.map(str::trim).filter(|note| !note.is_empty()) {
            Some(note) => format!("I assigned you {}: {}. {}", task.id, task.title, note),
            None => format!("I assigned you {}: {}.", task.id, task.title),
        };
        let message = insert_message(&tx, workspace_id, by, to, &body)?;
        tx.commit()?;
        Ok((task, message))
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
        let at = now_millis();
        let tx = self.conn.transaction()?;
        let id = task_id(&tx, workspace_id, id)?;
        let task = load_task(&tx, workspace_id, &id, None)?;
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
        let position = if task.status == TaskStatus::Review {
            task.position
        } else {
            end_of_column(&tx, workspace_id, TaskStatus::Review)?
        };
        tx.execute(
            "UPDATE tasks SET status = 'review', assignee = ?1, position = ?2, updated_at = ?3
             WHERE id = ?4 AND workspace_id = ?5",
            params![who, position, at, id, workspace_id],
        )?;
        add_event(&tx, &id, who, "completed", &summary, at)?;
        tx.commit()?;
        load_task(&self.conn, workspace_id, &id, Some(TASK_EVENTS_SHOWN))
    }

    pub fn delete_task(&mut self, workspace_id: &str, id: &str) -> StoreResult<()> {
        let id = task_id(&self.conn, workspace_id, id)?;
        self.conn.execute(
            "DELETE FROM tasks WHERE id = ?1 AND workspace_id = ?2",
            params![id, workspace_id],
        )?;
        Ok(())
    }

    // ----- messages -------------------------------------------------------

    pub fn send_message(
        &mut self,
        workspace_id: &str,
        from: &str,
        to: &str,
        body: &str,
    ) -> StoreResult<Message> {
        insert_message(&self.conn, workspace_id, from, to, body)
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
        let tx = self.conn.transaction()?;
        let mut messages: Vec<Message> = {
            let mut stmt = tx.prepare_cached(
                "SELECT id, workspace_id, sender, recipient, body, created_at FROM messages m
                 WHERE workspace_id = ?1 AND (recipient = ?2 OR recipient = 'all') AND sender != ?2
                   AND (?3 = 0 OR NOT EXISTS (
                        SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.reader = ?2))
                 ORDER BY id LIMIT ?4",
            )?;
            let rows = stmt.query_map(
                params![workspace_id, reader, unread_only as i64, limit as i64],
                message_from_row,
            )?;
            rows.collect::<Result<_, _>>()?
        };
        let ids = messages
            .iter()
            .map(|message| message.id)
            .collect::<serde_json::Value>()
            .to_string();
        tx.execute(
            "INSERT OR IGNORE INTO message_reads(message_id, reader)
             SELECT value, ?2 FROM json_each(?1)",
            params![ids, reader],
        )?;
        attach_readers(&tx, &mut messages)?;
        tx.commit()?;
        Ok(messages)
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
        if key.is_some_and(|key| key.chars().count() > MAX_NOTE_KEY_CHARS) {
            return Err(StoreError::Invalid(format!(
                "note key is longer than {} characters",
                MAX_NOTE_KEY_CHARS
            )));
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
        load_note(&self.conn, workspace_id, id)
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
        let notes: Vec<Note> = match fts_query(query) {
            Some(fts) => {
                let mut stmt = self.conn.prepare_cached(
                    "SELECT n.id, n.workspace_id, n.key, n.body, n.author, n.created_at, n.updated_at
                     FROM notes_fts f JOIN notes n ON n.id = f.rowid
                     WHERE notes_fts MATCH ?1 AND n.workspace_id = ?2
                     ORDER BY bm25(notes_fts, 2.0, 1.0), n.updated_at DESC LIMIT ?3",
                )?;
                let rows = stmt.query_map(params![fts, workspace_id, limit], note_from_row)?;
                rows.collect::<Result<_, _>>()?
            }
            None => {
                let mut stmt = self.conn.prepare_cached(
                    "SELECT id, workspace_id, key, body, author, created_at, updated_at
                     FROM notes WHERE workspace_id = ?1
                     ORDER BY updated_at DESC, id DESC LIMIT ?2",
                )?;
                let rows = stmt.query_map(params![workspace_id, limit], note_from_row)?;
                rows.collect::<Result<_, _>>()?
            }
        };
        Ok(notes)
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
    fn given_a_task_of_another_workspace_task_writes_find_nothing_and_change_nothing() {
        let mut repo = Repo::in_memory();
        repo.create_task("ws-1", "t-1", task("private")).unwrap();
        let not_found = |result: StoreResult<Task>| matches!(result, Err(StoreError::NotFound(_)));
        assert!(not_found(repo.update_task(
            "ws-2",
            "T-1",
            "t-9",
            TaskPatch {
                title: Some("taken over".into()),
                status: Some(TaskStatus::Done),
                note: Some("mine now".into()),
                ..TaskPatch::default()
            },
        )));
        assert!(not_found(repo.claim_task("ws-2", "T-1", "t-9")));
        assert!(not_found(repo.complete_task("ws-2", "T-1", "t-9", "done")));
        assert!(matches!(
            repo.assign_task("ws-2", "T-1", "t-9", "t-8", None),
            Err(StoreError::NotFound(_))
        ));
        assert!(matches!(
            repo.delete_task("ws-2", "T-1"),
            Err(StoreError::NotFound(_))
        ));

        let task = repo.get_task("ws-1", "T-1").unwrap();
        assert_eq!(task.title, "private");
        assert_eq!(task.status, TaskStatus::Todo);
        assert_eq!(task.assignee, None);
        assert_eq!(task.events.unwrap().len(), 1);
        assert_eq!(repo.count("messages"), 0);
    }

    #[test]
    fn given_ids_of_another_workspace_the_loaders_find_nothing() {
        let mut repo = Repo::in_memory();
        let task_id = repo.create_task("ws-1", "t-1", task("private")).unwrap().id;
        let message_id = repo.send_message("ws-1", "t-1", "all", "hi").unwrap().id;
        let note_id = repo.add_note("ws-1", "t-1", "secret", None).unwrap().id;
        assert!(matches!(
            load_task(&repo.conn, "ws-2", &task_id, None),
            Err(StoreError::NotFound(_))
        ));
        assert!(matches!(
            load_message(&repo.conn, "ws-2", message_id),
            Err(StoreError::NotFound(_))
        ));
        assert!(matches!(
            load_note(&repo.conn, "ws-2", note_id),
            Err(StoreError::NotFound(_))
        ));
    }

    #[test]
    fn given_a_dependency_link_to_another_workspace_it_neither_shows_nor_blocks() {
        let mut repo = Repo::in_memory();
        let foreign = repo.create_task("ws-1", "t-1", task("foreign")).unwrap();
        let local = repo.create_task("ws-2", "t-5", task("local")).unwrap();
        repo.conn
            .execute(
                "INSERT INTO task_deps(task_id, depends_on) VALUES (?1, ?2)",
                params![local.id, foreign.id],
            )
            .unwrap();
        let loaded = repo.get_task("ws-2", &local.id).unwrap();
        assert!(loaded.depends_on.is_empty());
        assert!(loaded.blocked_by.is_empty());
        assert!(repo.claim_task("ws-2", &local.id, "t-5").is_ok());
    }

    #[test]
    fn given_several_tasks_each_gets_its_own_dependencies_and_latest_events() {
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
        repo.create_task(
            "ws-1",
            "t-1",
            NewTask {
                title: "third".into(),
                depends_on: vec![second.id.clone(), first.id.clone(), "T-2".into()],
                ..NewTask::default()
            },
        )
        .unwrap();
        set_status(&mut repo, &first.id, TaskStatus::Done);
        for step in ["a", "b", "c"] {
            repo.update_task(
                "ws-1",
                &second.id,
                "t-1",
                TaskPatch {
                    note: Some(step.into()),
                    ..TaskPatch::default()
                },
            )
            .unwrap();
        }

        let tasks = repo.list_tasks("ws-1", None, None, Some(2)).unwrap();
        let by_title = |title: &str| tasks.iter().find(|task| task.title == title).unwrap();
        assert_eq!(by_title("third").depends_on, vec!["T-1", "T-2"]);
        assert_eq!(by_title("third").blocked_by, vec!["T-2"]);
        assert_eq!(by_title("second").depends_on, vec!["T-1"]);
        assert!(by_title("second").blocked_by.is_empty());
        assert!(by_title("first").depends_on.is_empty());
        let notes: Vec<&str> = by_title("second")
            .events
            .as_ref()
            .unwrap()
            .iter()
            .map(|event| event.body.as_str())
            .collect();
        assert_eq!(notes, vec!["b", "c"]);
        let kinds: Vec<&str> = by_title("third")
            .events
            .as_ref()
            .unwrap()
            .iter()
            .map(|event| event.kind.as_str())
            .collect();
        assert_eq!(kinds, vec!["created"]);
    }

    #[test]
    fn given_an_unknown_dependency_create_task_names_it_and_creates_nothing() {
        let mut repo = Repo::in_memory();
        repo.create_task("ws-1", "t-1", task("base")).unwrap();
        assert_eq!(
            repo.create_task(
                "ws-1",
                "t-1",
                NewTask {
                    title: "next".into(),
                    depends_on: vec!["T-1".into(), "nope".into()],
                    ..NewTask::default()
                },
            ),
            Err(StoreError::Invalid(
                "dependency nope is not a task in this workspace".into()
            ))
        );
        assert_eq!(repo.count("tasks"), 1);
    }

    #[test]
    fn given_unreadable_labels_the_task_loads_with_none() {
        let mut repo = Repo::in_memory();
        let id = repo.create_task("ws-1", "t-1", task("x")).unwrap().id;
        repo.conn
            .execute(
                "UPDATE tasks SET labels = 'not json' WHERE id = ?1",
                params![id],
            )
            .unwrap();
        assert!(repo.get_task("ws-1", &id).unwrap().labels.is_empty());
    }

    #[test]
    fn given_a_todo_task_assign_task_starts_it_and_messages_the_assignee() {
        let mut repo = Repo::in_memory();
        let id = repo.create_task("ws-1", "t-1", task("API")).unwrap().id;
        let (task, message) = repo
            .assign_task("ws-1", &id, "t-1", "t-2", Some("  Use axum. "))
            .unwrap();
        assert_eq!(task.assignee.as_deref(), Some("t-2"));
        assert_eq!(task.status, TaskStatus::InProgress);
        assert_eq!((message.from.as_str(), message.to.as_str()), ("t-1", "t-2"));
        assert_eq!(message.body, "I assigned you T-1: API. Use axum.");

        set_status(&mut repo, &id, TaskStatus::Done);
        assert_eq!(
            repo.assign_task("ws-1", &id, "t-1", "t-3", None)
                .unwrap_err(),
            StoreError::Conflict("task T-1 is already done".into())
        );
    }

    #[test]
    fn given_the_message_cannot_be_written_assign_task_leaves_the_task_untouched() {
        let mut repo = Repo::in_memory();
        let id = repo.create_task("ws-1", "t-1", task("API")).unwrap().id;
        let note = "x".repeat(MAX_BODY_BYTES);
        assert!(matches!(
            repo.assign_task("ws-1", &id, "t-1", "t-2", Some(&note)),
            Err(StoreError::Invalid(_))
        ));
        let task = repo.get_task("ws-1", &id).unwrap();
        assert_eq!(task.assignee, None);
        assert_eq!(task.status, TaskStatus::Todo);
        assert_eq!(task.events.unwrap().len(), 1);
        assert_eq!(repo.count("messages"), 0);
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
        }
        repo.purge_workspace("ws-1").unwrap();
        assert!(repo
            .list_tasks("ws-1", None, None, None)
            .unwrap()
            .is_empty());
        assert!(repo.search_notes("ws-1", "", None).unwrap().is_empty());
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
    fn given_an_unreadable_setting_the_server_stays_enabled() {
        let repo = Repo::in_memory();
        repo.conn
            .execute_batch("ALTER TABLE settings RENAME TO settings_gone")
            .unwrap();
        assert!(repo.enabled());
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
