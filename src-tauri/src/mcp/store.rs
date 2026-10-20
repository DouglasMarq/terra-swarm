//! SQLite-backed state shared by the agents of a workspace: the task board,
//! messages between terminals and project notes. Agent statuses are runtime
//! facts and stay in memory, so a restart never shows a stale "working".
//!
//! Every query is scoped by `workspace_id`; callers pass the workspace taken
//! from the caller's token, never one supplied by the agent.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

pub const MAX_TITLE_CHARS: usize = 200;
pub const MAX_BODY_BYTES: usize = 16 * 1024;
pub const MAX_TASKS_PER_WORKSPACE: usize = 1000;
pub const MAX_MESSAGES_PER_WORKSPACE: usize = 500;
pub const MAX_NOTES_PER_WORKSPACE: usize = 500;
pub const MAX_NOTES_PER_TASK: usize = 100;
pub const MAX_LABELS: usize = 16;
pub const SEARCH_LIMIT: usize = 50;

const SCHEMA_VERSION: i64 = 1;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    assignee TEXT,
    created_by TEXT NOT NULL,
    priority TEXT NOT NULL,
    labels TEXT NOT NULL DEFAULT '[]',
    depends_on TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_workspace ON tasks(workspace_id);
CREATE TABLE IF NOT EXISTS task_notes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    task_seq INTEGER NOT NULL REFERENCES tasks(seq) ON DELETE CASCADE,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS task_notes_task ON task_notes(task_seq);
CREATE TABLE IF NOT EXISTS messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_workspace ON messages(workspace_id);
CREATE TABLE IF NOT EXISTS message_reads (
    message_seq INTEGER NOT NULL REFERENCES messages(seq) ON DELETE CASCADE,
    reader TEXT NOT NULL,
    PRIMARY KEY (message_seq, reader)
);
CREATE TABLE IF NOT EXISTS notes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    key TEXT,
    body TEXT NOT NULL,
    author TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_workspace ON notes(workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS notes_key ON notes(workspace_id, key) WHERE key IS NOT NULL;
"#;

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
        Self::ALL.into_iter().find(|status| status.as_str() == value)
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskPriority {
    Low,
    Medium,
    High,
    Urgent,
}

impl TaskPriority {
    pub const ALL: [TaskPriority; 4] = [
        TaskPriority::Low,
        TaskPriority::Medium,
        TaskPriority::High,
        TaskPriority::Urgent,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            TaskPriority::Low => "low",
            TaskPriority::Medium => "medium",
            TaskPriority::High => "high",
            TaskPriority::Urgent => "urgent",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|priority| priority.as_str() == value)
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct TaskNote {
    pub author: String,
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
    pub assignee: Option<String>,
    pub created_by: String,
    pub priority: TaskPriority,
    pub labels: Vec<String>,
    pub depends_on: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub notes: Vec<TaskNote>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Message {
    pub id: String,
    pub workspace_id: String,
    pub from: String,
    pub to: String,
    pub body: String,
    pub created_at: i64,
    pub read_by: Vec<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Note {
    pub id: String,
    pub workspace_id: String,
    pub key: Option<String>,
    pub body: String,
    pub author: String,
    pub created_at: i64,
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
    pub note: Option<String>,
}

#[derive(Debug, PartialEq)]
pub enum StoreError {
    NotFound(String),
    Invalid(String),
    Conflict(String),
    Database(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::NotFound(message)
            | StoreError::Invalid(message)
            | StoreError::Conflict(message) => f.write_str(message),
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

fn format_id(prefix: char, seq: i64) -> String {
    format!("{}-{}", prefix, seq)
}

/// Accept `T-12`, `t-12` and a bare `12`, so agents can be sloppy with ids.
fn parse_id(prefix: char, raw: &str) -> Option<i64> {
    let raw = raw.trim();
    let digits = raw
        .strip_prefix(prefix)
        .or_else(|| raw.strip_prefix(prefix.to_ascii_lowercase()))
        .and_then(|rest| rest.strip_prefix('-'))
        .unwrap_or(raw);
    digits.parse::<i64>().ok().filter(|seq| *seq > 0)
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
            return Err(StoreError::Invalid(format!("label `{}` is too long", label)));
        }
        labels.push(label.to_string());
    }
    if labels.len() > MAX_LABELS {
        return Err(StoreError::Invalid(format!("at most {} labels", MAX_LABELS)));
    }
    Ok(labels)
}

fn json_list(raw: &str) -> Vec<String> {
    serde_json::from_str(raw).unwrap_or_default()
}

fn json_text(list: &[String]) -> String {
    serde_json::to_string(list).unwrap_or_else(|_| "[]".into())
}

/// Move a damaged database (and its WAL side files) out of the way, keeping
/// it for inspection the same way the workspace store keeps `.bak` files.
fn backup_corrupt(path: &Path) {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("mcp.sqlite")
        .to_string();
    let mut target = path.with_file_name(format!("{}.bak", file_name));
    let mut index = 1u32;
    while target.exists() {
        target = path.with_file_name(format!("{}.bak-{}", file_name, index));
        index += 1;
    }
    if let Err(error) = std::fs::rename(path, &target) {
        eprintln!("failed to back up corrupt MCP database: {}", error);
    }
    for suffix in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(path.with_file_name(format!("{}{}", file_name, suffix)));
    }
}

pub struct McpStore {
    conn: Connection,
    statuses: HashMap<String, AgentStatus>,
}

impl McpStore {
    /// Open (or create) the database at `path`. A file that SQLite cannot
    /// read is renamed to `.bak` and replaced by an empty database, so a
    /// damaged board never keeps the app from starting.
    pub fn open(path: PathBuf) -> Self {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match Self::try_open(&path) {
            Ok(store) => store,
            Err(error) => {
                eprintln!(
                    "MCP database is unreadable ({}); backing up to .bak and starting fresh",
                    error
                );
                backup_corrupt(&path);
                Self::try_open(&path).unwrap_or_else(|error| {
                    eprintln!("failed to create MCP database ({}); using memory", error);
                    Self::in_memory()
                })
            }
        }
    }

    fn try_open(path: &Path) -> StoreResult<Self> {
        let conn = Connection::open(path)?;
        let check: String = conn.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
        if check != "ok" {
            return Err(StoreError::Database(check));
        }
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        Self::init(conn)
    }

    pub fn in_memory() -> Self {
        let conn = Connection::open_in_memory().expect("in-memory SQLite must open");
        Self::init(conn).expect("in-memory schema must apply")
    }

    fn init(conn: Connection) -> StoreResult<Self> {
        conn.busy_timeout(std::time::Duration::from_secs(2))?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(SCHEMA)?;
        let version: Option<String> = conn
            .query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |row| {
                row.get(0)
            })
            .optional()?;
        match version.and_then(|value| value.parse::<i64>().ok()) {
            None => {
                conn.execute(
                    "INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?1)",
                    params![SCHEMA_VERSION.to_string()],
                )?;
            }
            Some(version) if version > SCHEMA_VERSION => {
                return Err(StoreError::Database(format!(
                    "database schema {} is newer than this app ({})",
                    version, SCHEMA_VERSION
                )));
            }
            Some(_) => {}
        }
        Ok(Self {
            conn,
            statuses: HashMap::new(),
        })
    }

    // ----- settings -------------------------------------------------------

    /// Whether terminals get the MCP server injected. On unless turned off.
    pub fn enabled(&self) -> bool {
        self.conn
            .query_row("SELECT value FROM meta WHERE key = 'enabled'", [], |row| {
                row.get::<_, String>(0)
            })
            .optional()
            .ok()
            .flatten()
            .map_or(true, |value| value != "0")
    }

    pub fn set_enabled(&self, enabled: bool) -> StoreResult<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('enabled', ?1)",
            params![if enabled { "1" } else { "0" }],
        )?;
        Ok(())
    }

    /// Drop everything that belongs to workspaces that no longer exist.
    pub fn retain_workspaces(&mut self, known: &HashSet<String>) -> StoreResult<()> {
        let tx = self.conn.transaction()?;
        for table in ["tasks", "messages", "notes"] {
            let ids: Vec<String> = {
                let mut stmt =
                    tx.prepare(&format!("SELECT DISTINCT workspace_id FROM {}", table))?;
                let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
                rows.collect::<Result<_, _>>()?
            };
            for id in ids.into_iter().filter(|id| !known.contains(id)) {
                tx.execute(
                    &format!("DELETE FROM {} WHERE workspace_id = ?1", table),
                    params![id],
                )?;
            }
        }
        tx.commit()?;
        self.statuses
            .retain(|_, status| known.contains(&status.workspace_id));
        Ok(())
    }

    // ----- tasks ----------------------------------------------------------

    fn task_seq(&self, workspace_id: &str, raw: &str) -> StoreResult<i64> {
        let seq = parse_id('T', raw).ok_or_else(|| task_not_found(raw))?;
        self.conn
            .query_row(
                "SELECT seq FROM tasks WHERE seq = ?1 AND workspace_id = ?2",
                params![seq, workspace_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| task_not_found(raw))
    }

    fn load_task(&self, seq: i64) -> StoreResult<Task> {
        let mut task = self.conn.query_row(
            "SELECT seq, workspace_id, title, description, status, assignee, created_by,
                    priority, labels, depends_on, created_at, updated_at
             FROM tasks WHERE seq = ?1",
            params![seq],
            |row| {
                let status: String = row.get(4)?;
                let priority: String = row.get(7)?;
                Ok(Task {
                    id: format_id('T', row.get(0)?),
                    workspace_id: row.get(1)?,
                    title: row.get(2)?,
                    description: row.get(3)?,
                    status: TaskStatus::parse(&status).unwrap_or(TaskStatus::Todo),
                    assignee: row.get(5)?,
                    created_by: row.get(6)?,
                    priority: TaskPriority::parse(&priority).unwrap_or(TaskPriority::Medium),
                    labels: json_list(&row.get::<_, String>(8)?),
                    depends_on: json_list(&row.get::<_, String>(9)?),
                    created_at: row.get(10)?,
                    updated_at: row.get(11)?,
                    notes: Vec::new(),
                })
            },
        )?;
        let mut stmt = self.conn.prepare_cached(
            "SELECT author, body, created_at FROM task_notes WHERE task_seq = ?1 ORDER BY seq",
        )?;
        let notes = stmt.query_map(params![seq], |row| {
            Ok(TaskNote {
                author: row.get(0)?,
                body: row.get(1)?,
                created_at: row.get(2)?,
            })
        })?;
        task.notes = notes.collect::<Result<_, _>>()?;
        Ok(task)
    }

    fn add_task_note(&self, seq: i64, author: &str, body: &str, at: i64) -> StoreResult<()> {
        self.conn.execute(
            "INSERT INTO task_notes(task_seq, author, body, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![seq, author, body, at],
        )?;
        self.conn.execute(
            "DELETE FROM task_notes WHERE task_seq = ?1 AND seq NOT IN (
                SELECT seq FROM task_notes WHERE task_seq = ?1 ORDER BY seq DESC LIMIT ?2)",
            params![seq, MAX_NOTES_PER_TASK as i64],
        )?;
        Ok(())
    }

    pub fn list_tasks(
        &self,
        workspace_id: &str,
        status: Option<TaskStatus>,
        assignee: Option<&str>,
    ) -> StoreResult<Vec<Task>> {
        let seqs: Vec<i64> = {
            let mut stmt = self.conn.prepare_cached(
                "SELECT seq FROM tasks
                 WHERE workspace_id = ?1
                   AND (?2 IS NULL OR status = ?2)
                   AND (?3 IS NULL OR assignee = ?3)
                 ORDER BY seq",
            )?;
            let rows = stmt.query_map(
                params![workspace_id, status.map(TaskStatus::as_str), assignee],
                |row| row.get(0),
            )?;
            rows.collect::<Result<_, _>>()?
        };
        seqs.into_iter().map(|seq| self.load_task(seq)).collect()
    }

    pub fn get_task(&self, workspace_id: &str, id: &str) -> StoreResult<Task> {
        let seq = self.task_seq(workspace_id, id)?;
        self.load_task(seq)
    }

    fn check_dependencies(&self, workspace_id: &str, raw: &[String]) -> StoreResult<Vec<String>> {
        let mut ids: Vec<String> = Vec::new();
        for dep in raw {
            let seq = self.task_seq(workspace_id, dep).map_err(|_| {
                StoreError::Invalid(format!("dependency {} is not a task in this workspace", dep))
            })?;
            let id = format_id('T', seq);
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        Ok(ids)
    }

    pub fn create_task(
        &mut self,
        workspace_id: &str,
        created_by: &str,
        new: NewTask,
    ) -> StoreResult<Task> {
        let title = clean_title(&new.title)?;
        let description = clean_body(new.description.as_deref().unwrap_or(""), "description", true)?;
        let labels = clean_labels(&new.labels)?;
        let depends_on = self.check_dependencies(workspace_id, &new.depends_on)?;
        let priority = new.priority.unwrap_or(TaskPriority::Medium);
        let assignee = new.assignee.filter(|id| !id.trim().is_empty());
        let status = if assignee.is_some() {
            TaskStatus::InProgress
        } else {
            TaskStatus::Todo
        };

        let tx = self.conn.transaction()?;
        let count: i64 = tx.query_row(
            "SELECT COUNT(*) FROM tasks WHERE workspace_id = ?1",
            params![workspace_id],
            |row| row.get(0),
        )?;
        if count as usize >= MAX_TASKS_PER_WORKSPACE {
            // Make room by forgetting the oldest finished work first.
            let freed = tx.execute(
                "DELETE FROM tasks WHERE seq IN (
                    SELECT seq FROM tasks WHERE workspace_id = ?1 AND status = 'done'
                    ORDER BY updated_at LIMIT ?2)",
                params![workspace_id, (count as usize + 1 - MAX_TASKS_PER_WORKSPACE) as i64],
            )?;
            if freed == 0 {
                return Err(StoreError::Conflict(format!(
                    "the board already holds {} open tasks; finish or delete some first",
                    MAX_TASKS_PER_WORKSPACE
                )));
            }
        }
        let at = now_millis();
        tx.execute(
            "INSERT INTO tasks(workspace_id, title, description, status, assignee, created_by,
                               priority, labels, depends_on, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
            params![
                workspace_id,
                title,
                description,
                status.as_str(),
                assignee,
                created_by,
                priority.as_str(),
                json_text(&labels),
                json_text(&depends_on),
                at
            ],
        )?;
        let seq = tx.last_insert_rowid();
        tx.commit()?;
        self.load_task(seq)
    }

    /// Take an unassigned task. The conditional UPDATE is the lock: two
    /// agents racing for the same task cannot both see their own id.
    pub fn claim_task(&mut self, workspace_id: &str, id: &str, who: &str) -> StoreResult<Task> {
        let seq = self.task_seq(workspace_id, id)?;
        let task = self.load_task(seq)?;
        if task.status == TaskStatus::Done {
            return Err(StoreError::Conflict(format!("task {} is already done", task.id)));
        }
        let open: Vec<String> = task
            .depends_on
            .iter()
            .filter(|dep| {
                self.get_task(workspace_id, dep)
                    .map_or(false, |dep| dep.status != TaskStatus::Done)
            })
            .cloned()
            .collect();
        if !open.is_empty() {
            return Err(StoreError::Conflict(format!(
                "task {} depends on unfinished tasks: {}",
                task.id,
                open.join(", ")
            )));
        }
        let tx = self.conn.transaction()?;
        let at = now_millis();
        let changed = tx.execute(
            "UPDATE tasks SET assignee = ?1, status = 'in_progress', updated_at = ?2
             WHERE seq = ?3 AND (assignee IS NULL OR assignee = ?1) AND status != 'done'",
            params![who, at, seq],
        )?;
        if changed == 0 {
            let owner: Option<String> = tx.query_row(
                "SELECT assignee FROM tasks WHERE seq = ?1",
                params![seq],
                |row| row.get(0),
            )?;
            return Err(StoreError::Conflict(match owner {
                Some(owner) => format!("task {} is already claimed by {}", task.id, owner),
                None => format!("task {} cannot be claimed right now", task.id),
            }));
        }
        tx.commit()?;
        if task.assignee.as_deref() != Some(who) {
            self.add_task_note(seq, who, "claimed the task", at)?;
        }
        self.load_task(seq)
    }

    pub fn update_task(
        &mut self,
        workspace_id: &str,
        id: &str,
        actor: &str,
        patch: TaskPatch,
    ) -> StoreResult<Task> {
        let seq = self.task_seq(workspace_id, id)?;
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
        let at = now_millis();
        let tx = self.conn.transaction()?;
        if let Some(title) = &title {
            tx.execute("UPDATE tasks SET title = ?1 WHERE seq = ?2", params![title, seq])?;
        }
        if let Some(description) = &description {
            tx.execute(
                "UPDATE tasks SET description = ?1 WHERE seq = ?2",
                params![description, seq],
            )?;
        }
        if let Some(status) = patch.status {
            tx.execute(
                "UPDATE tasks SET status = ?1 WHERE seq = ?2",
                params![status.as_str(), seq],
            )?;
        }
        if let Some(priority) = patch.priority {
            tx.execute(
                "UPDATE tasks SET priority = ?1 WHERE seq = ?2",
                params![priority.as_str(), seq],
            )?;
        }
        if let Some(assignee) = &assignee {
            tx.execute(
                "UPDATE tasks SET assignee = ?1 WHERE seq = ?2",
                params![assignee, seq],
            )?;
        }
        tx.execute("UPDATE tasks SET updated_at = ?1 WHERE seq = ?2", params![at, seq])?;
        tx.commit()?;
        let mut log: Vec<String> = Vec::new();
        if let Some(status) = patch.status {
            log.push(format!("status → {}", status.as_str()));
        }
        if let Some(assignee) = &assignee {
            log.push(match assignee {
                Some(id) => format!("assigned to {}", id),
                None => "unassigned".into(),
            });
        }
        if let Some(note) = note {
            log.push(note);
        }
        if !log.is_empty() {
            self.add_task_note(seq, actor, &log.join(" · "), at)?;
        }
        self.load_task(seq)
    }

    /// Hand the work in for review. Only the assignee (or anyone, while the
    /// task is unassigned) can complete it.
    pub fn complete_task(
        &mut self,
        workspace_id: &str,
        id: &str,
        who: &str,
        summary: &str,
    ) -> StoreResult<Task> {
        let summary = clean_body(summary, "summary", false)?;
        let task = self.get_task(workspace_id, id)?;
        if let Some(owner) = task.assignee.as_deref() {
            if owner != who {
                return Err(StoreError::Conflict(format!(
                    "task {} is assigned to {}; only they can complete it",
                    task.id, owner
                )));
            }
        }
        if task.status == TaskStatus::Done {
            return Err(StoreError::Conflict(format!("task {} is already done", task.id)));
        }
        self.update_task(
            workspace_id,
            id,
            who,
            TaskPatch {
                status: Some(TaskStatus::Review),
                assignee: Some(Some(who.to_string())),
                note: Some(format!("completed: {}", summary)),
                ..TaskPatch::default()
            },
        )
    }

    pub fn delete_task(&mut self, workspace_id: &str, id: &str) -> StoreResult<()> {
        let seq = self.task_seq(workspace_id, id)?;
        self.conn
            .execute("DELETE FROM tasks WHERE seq = ?1", params![seq])?;
        Ok(())
    }

    // ----- messages -------------------------------------------------------

    fn load_message(&self, seq: i64) -> StoreResult<Message> {
        let mut message = self.conn.query_row(
            "SELECT seq, workspace_id, from_id, to_id, body, created_at FROM messages WHERE seq = ?1",
            params![seq],
            |row| {
                Ok(Message {
                    id: format_id('M', row.get(0)?),
                    workspace_id: row.get(1)?,
                    from: row.get(2)?,
                    to: row.get(3)?,
                    body: row.get(4)?,
                    created_at: row.get(5)?,
                    read_by: Vec::new(),
                })
            },
        )?;
        let mut stmt = self
            .conn
            .prepare_cached("SELECT reader FROM message_reads WHERE message_seq = ?1 ORDER BY rowid")?;
        let readers = stmt.query_map(params![seq], |row| row.get::<_, String>(0))?;
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
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO messages(workspace_id, from_id, to_id, body, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![workspace_id, from, to, body, now_millis()],
        )?;
        let seq = tx.last_insert_rowid();
        tx.execute(
            "DELETE FROM messages WHERE workspace_id = ?1 AND seq NOT IN (
                SELECT seq FROM messages WHERE workspace_id = ?1 ORDER BY seq DESC LIMIT ?2)",
            params![workspace_id, MAX_MESSAGES_PER_WORKSPACE as i64],
        )?;
        tx.commit()?;
        self.load_message(seq)
    }

    /// Messages addressed to `reader` (directly or to `all`), oldest first.
    /// Every returned message is marked as read by `reader`.
    pub fn read_inbox(
        &mut self,
        workspace_id: &str,
        reader: &str,
        unread_only: bool,
    ) -> StoreResult<Vec<Message>> {
        let seqs: Vec<i64> = {
            let mut stmt = self.conn.prepare_cached(
                "SELECT seq FROM messages m
                 WHERE workspace_id = ?1 AND (to_id = ?2 OR to_id = 'all') AND from_id != ?2
                   AND (?3 = 0 OR NOT EXISTS (
                        SELECT 1 FROM message_reads r WHERE r.message_seq = m.seq AND r.reader = ?2))
                 ORDER BY seq",
            )?;
            let rows = stmt.query_map(params![workspace_id, reader, unread_only as i64], |row| {
                row.get(0)
            })?;
            rows.collect::<Result<_, _>>()?
        };
        let tx = self.conn.transaction()?;
        for seq in &seqs {
            tx.execute(
                "INSERT OR IGNORE INTO message_reads(message_seq, reader) VALUES (?1, ?2)",
                params![seq, reader],
            )?;
        }
        tx.commit()?;
        seqs.into_iter().map(|seq| self.load_message(seq)).collect()
    }

    pub fn unread_count(&self, workspace_id: &str, reader: &str) -> StoreResult<usize> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM messages m
             WHERE workspace_id = ?1 AND (to_id = ?2 OR to_id = 'all') AND from_id != ?2
               AND NOT EXISTS (
                    SELECT 1 FROM message_reads r WHERE r.message_seq = m.seq AND r.reader = ?2)",
            params![workspace_id, reader],
            |row| row.get(0),
        )?;
        Ok(count as usize)
    }

    #[cfg(test)]
    pub fn list_messages(&self, workspace_id: &str, limit: usize) -> StoreResult<Vec<Message>> {
        let seqs: Vec<i64> = {
            let mut stmt = self.conn.prepare_cached(
                "SELECT seq FROM (SELECT seq FROM messages WHERE workspace_id = ?1
                                  ORDER BY seq DESC LIMIT ?2) ORDER BY seq",
            )?;
            let rows = stmt.query_map(params![workspace_id, limit as i64], |row| row.get(0))?;
            rows.collect::<Result<_, _>>()?
        };
        seqs.into_iter().map(|seq| self.load_message(seq)).collect()
    }

    // ----- notes ----------------------------------------------------------

    fn load_note(&self, seq: i64) -> StoreResult<Note> {
        Ok(self.conn.query_row(
            "SELECT seq, workspace_id, key, body, author, created_at FROM notes WHERE seq = ?1",
            params![seq],
            |row| {
                Ok(Note {
                    id: format_id('N', row.get(0)?),
                    workspace_id: row.get(1)?,
                    key: row.get(2)?,
                    body: row.get(3)?,
                    author: row.get(4)?,
                    created_at: row.get(5)?,
                })
            },
        )?)
    }

    /// Save a note. A note with the same `key` is replaced, so keys work as
    /// named facts ("test-command", "api-conventions").
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
            return Err(StoreError::Invalid("note key is longer than 80 characters".into()));
        }
        let at = now_millis();
        let tx = self.conn.transaction()?;
        let existing: Option<i64> = match key {
            Some(key) => tx
                .query_row(
                    "SELECT seq FROM notes WHERE workspace_id = ?1 AND key = ?2",
                    params![workspace_id, key],
                    |row| row.get(0),
                )
                .optional()?,
            None => None,
        };
        let seq = match existing {
            Some(seq) => {
                tx.execute(
                    "UPDATE notes SET body = ?1, author = ?2, created_at = ?3 WHERE seq = ?4",
                    params![body, author, at, seq],
                )?;
                seq
            }
            None => {
                tx.execute(
                    "INSERT INTO notes(workspace_id, key, body, author, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![workspace_id, key, body, author, at],
                )?;
                tx.last_insert_rowid()
            }
        };
        tx.execute(
            "DELETE FROM notes WHERE workspace_id = ?1 AND seq NOT IN (
                SELECT seq FROM notes WHERE workspace_id = ?1 ORDER BY created_at DESC, seq DESC LIMIT ?2)",
            params![workspace_id, MAX_NOTES_PER_WORKSPACE as i64],
        )?;
        tx.commit()?;
        self.load_note(seq)
    }

    /// Case-insensitive search over key and body; every word of `query` must
    /// match. An empty query lists the most recent notes.
    pub fn search_notes(&self, workspace_id: &str, query: &str) -> StoreResult<Vec<Note>> {
        let terms: Vec<String> = query
            .split_whitespace()
            .map(|term| term.to_lowercase())
            .collect();
        let seqs: Vec<i64> = {
            let mut stmt = self.conn.prepare_cached(
                "SELECT seq FROM notes WHERE workspace_id = ?1 ORDER BY created_at DESC, seq DESC",
            )?;
            let rows = stmt.query_map(params![workspace_id], |row| row.get(0))?;
            rows.collect::<Result<_, _>>()?
        };
        let mut notes = Vec::new();
        for seq in seqs {
            let note = self.load_note(seq)?;
            let haystack = format!(
                "{} {}",
                note.key.as_deref().unwrap_or(""),
                note.body
            )
            .to_lowercase();
            if terms.iter().all(|term| haystack.contains(term.as_str())) {
                notes.push(note);
                if notes.len() >= SEARCH_LIMIT {
                    break;
                }
            }
        }
        Ok(notes)
    }

    // ----- agent status ---------------------------------------------------

    pub fn report_status(
        &mut self,
        workspace_id: &str,
        terminal_id: &str,
        state: AgentState,
        summary: &str,
    ) -> StoreResult<AgentStatus> {
        let summary = summary.trim();
        if summary.chars().count() > 500 {
            return Err(StoreError::Invalid("summary is longer than 500 characters".into()));
        }
        let status = AgentStatus {
            terminal_id: terminal_id.to_string(),
            workspace_id: workspace_id.to_string(),
            state,
            summary: summary.to_string(),
            updated_at: now_millis(),
        };
        self.statuses.insert(terminal_id.to_string(), status.clone());
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

    #[test]
    fn task_crud_round_trip() {
        let mut store = McpStore::in_memory();
        let created = store
            .create_task(
                "ws-1",
                "t-1",
                NewTask {
                    title: "  Write the parser ".into(),
                    description: Some("tokens first".into()),
                    priority: Some(TaskPriority::High),
                    labels: vec!["backend".into(), "backend".into(), " ".into()],
                    ..NewTask::default()
                },
            )
            .unwrap();
        assert_eq!(created.id, "T-1");
        assert_eq!(created.title, "Write the parser");
        assert_eq!(created.status, TaskStatus::Todo);
        assert_eq!(created.priority, TaskPriority::High);
        assert_eq!(created.labels, vec!["backend".to_string()]);
        assert_eq!(created.created_by, "t-1");

        assert_eq!(store.get_task("ws-1", "t-1").unwrap().id, "T-1");
        assert_eq!(store.get_task("ws-1", "1").unwrap().id, "T-1");

        let updated = store
            .update_task(
                "ws-1",
                "T-1",
                "user",
                TaskPatch {
                    status: Some(TaskStatus::Blocked),
                    note: Some("waiting on the lexer".into()),
                    ..TaskPatch::default()
                },
            )
            .unwrap();
        assert_eq!(updated.status, TaskStatus::Blocked);
        assert_eq!(updated.notes.len(), 1);
        assert!(updated.notes[0].body.contains("waiting on the lexer"));
        assert!(updated.notes[0].body.contains("status → blocked"));

        assert_eq!(store.list_tasks("ws-1", None, None).unwrap().len(), 1);
        assert_eq!(
            store
                .list_tasks("ws-1", Some(TaskStatus::Todo), None)
                .unwrap()
                .len(),
            0
        );
        store.delete_task("ws-1", "T-1").unwrap();
        assert!(matches!(
            store.get_task("ws-1", "T-1"),
            Err(StoreError::NotFound(_))
        ));
    }

    #[test]
    fn tasks_are_invisible_from_other_workspaces() {
        let mut store = McpStore::in_memory();
        store.create_task("ws-1", "t-1", task("secret")).unwrap();
        assert!(store.list_tasks("ws-2", None, None).unwrap().is_empty());
        assert!(matches!(
            store.get_task("ws-2", "T-1"),
            Err(StoreError::NotFound(_))
        ));
        assert!(store.claim_task("ws-2", "T-1", "t-9").is_err());
        assert!(store.delete_task("ws-2", "T-1").is_err());
        assert!(store
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
        let mut store = McpStore::in_memory();
        assert!(matches!(
            store.create_task("ws-1", "t-1", task("   ")),
            Err(StoreError::Invalid(_))
        ));
        assert!(store
            .create_task("ws-1", "t-1", task(&"x".repeat(MAX_TITLE_CHARS + 1)))
            .is_err());
        assert!(store
            .send_message("ws-1", "t-1", "all", &"x".repeat(MAX_BODY_BYTES + 1))
            .is_err());
        assert!(store.add_note("ws-1", "t-1", "", None).is_err());
    }

    #[test]
    fn claim_is_exclusive_and_respects_dependencies() {
        let mut store = McpStore::in_memory();
        let first = store.create_task("ws-1", "t-1", task("first")).unwrap();
        let second = store
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
        assert_eq!(second.depends_on, vec!["T-1".to_string()]);

        let err = store.claim_task("ws-1", &second.id, "t-2").unwrap_err();
        assert!(err.to_string().contains("T-1"));

        let claimed = store.claim_task("ws-1", &first.id, "t-2").unwrap();
        assert_eq!(claimed.assignee.as_deref(), Some("t-2"));
        assert_eq!(claimed.status, TaskStatus::InProgress);
        // Claiming your own task again is a no-op, not an error.
        assert!(store.claim_task("ws-1", &first.id, "t-2").is_ok());
        let err = store.claim_task("ws-1", &first.id, "t-3").unwrap_err();
        assert_eq!(
            err,
            StoreError::Conflict("task T-1 is already claimed by t-2".into())
        );

        let err = store
            .complete_task("ws-1", &first.id, "t-3", "done")
            .unwrap_err();
        assert!(matches!(err, StoreError::Conflict(_)));
        let reviewed = store
            .complete_task("ws-1", &first.id, "t-2", "parser works")
            .unwrap();
        assert_eq!(reviewed.status, TaskStatus::Review);
        assert!(reviewed.notes.last().unwrap().body.contains("parser works"));
    }

    #[test]
    fn concurrent_claims_have_exactly_one_winner() {
        let store = Arc::new(Mutex::new(McpStore::in_memory()));
        let id = store
            .lock()
            .unwrap()
            .create_task("ws-1", "t-1", task("race"))
            .unwrap()
            .id;
        let agents = 8;
        let barrier = Arc::new(Barrier::new(agents));
        let handles: Vec<_> = (0..agents)
            .map(|n| {
                let store = Arc::clone(&store);
                let barrier = Arc::clone(&barrier);
                let id = id.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    store
                        .lock()
                        .unwrap()
                        .claim_task("ws-1", &id, &format!("t-{}", n + 10))
                        .is_ok()
                })
            })
            .collect();
        let winners = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .filter(|won| *won)
            .count();
        assert_eq!(winners, 1);
    }

    #[test]
    fn inbox_marks_messages_read_and_skips_own_messages() {
        let mut store = McpStore::in_memory();
        store.send_message("ws-1", "t-1", "t-2", "hi two").unwrap();
        store.send_message("ws-1", "t-1", "all", "hi all").unwrap();
        store.send_message("ws-1", "t-2", "all", "mine").unwrap();
        store.send_message("ws-1", "t-1", "t-3", "not for two").unwrap();
        store.send_message("ws-2", "t-8", "all", "other project").unwrap();

        assert_eq!(store.unread_count("ws-1", "t-2").unwrap(), 2);
        let inbox = store.read_inbox("ws-1", "t-2", true).unwrap();
        let bodies: Vec<&str> = inbox.iter().map(|m| m.body.as_str()).collect();
        assert_eq!(bodies, vec!["hi two", "hi all"]);
        assert!(inbox.iter().all(|m| m.read_by.contains(&"t-2".to_string())));
        assert!(store.read_inbox("ws-1", "t-2", true).unwrap().is_empty());
        assert_eq!(store.read_inbox("ws-1", "t-2", false).unwrap().len(), 2);
        assert_eq!(store.unread_count("ws-1", "t-2").unwrap(), 0);
    }

    #[test]
    fn messages_and_notes_drop_the_oldest_over_the_limit() {
        let mut store = McpStore::in_memory();
        for n in 0..MAX_MESSAGES_PER_WORKSPACE + 5 {
            store
                .send_message("ws-1", "t-1", "all", &format!("m{}", n))
                .unwrap();
        }
        let all = store
            .list_messages("ws-1", MAX_MESSAGES_PER_WORKSPACE * 2)
            .unwrap();
        assert_eq!(all.len(), MAX_MESSAGES_PER_WORKSPACE);
        assert_eq!(all[0].body, "m5");

        for n in 0..MAX_NOTES_PER_WORKSPACE + 3 {
            store
                .add_note("ws-1", "t-1", &format!("note {}", n), None)
                .unwrap();
        }
        let notes = store.search_notes("ws-1", "note 0").unwrap();
        assert!(notes.iter().all(|note| note.body != "note 0"));
        let count: i64 = store
            .conn
            .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count as usize, MAX_NOTES_PER_WORKSPACE);
    }

    #[test]
    fn task_log_keeps_the_newest_notes() {
        let mut store = McpStore::in_memory();
        let id = store.create_task("ws-1", "t-1", task("log")).unwrap().id;
        for n in 0..MAX_NOTES_PER_TASK + 4 {
            store
                .update_task(
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
        let task = store.get_task("ws-1", &id).unwrap();
        assert_eq!(task.notes.len(), MAX_NOTES_PER_TASK);
        assert_eq!(task.notes[0].body, "step 4");
    }

    #[test]
    fn task_limit_evicts_done_tasks_first() {
        let mut store = McpStore::in_memory();
        for n in 0..MAX_TASKS_PER_WORKSPACE {
            store.create_task("ws-1", "t-1", task(&format!("{}", n))).unwrap();
        }
        assert!(matches!(
            store.create_task("ws-1", "t-1", task("one too many")),
            Err(StoreError::Conflict(_))
        ));
        store
            .update_task(
                "ws-1",
                "T-1",
                "user",
                TaskPatch {
                    status: Some(TaskStatus::Done),
                    ..TaskPatch::default()
                },
            )
            .unwrap();
        store.create_task("ws-1", "t-1", task("fits now")).unwrap();
        assert!(store.get_task("ws-1", "T-1").is_err());
    }

    #[test]
    fn keyed_notes_are_replaced_and_searchable() {
        let mut store = McpStore::in_memory();
        let first = store
            .add_note("ws-1", "t-1", "npm test", Some("test-command"))
            .unwrap();
        let second = store
            .add_note("ws-1", "t-2", "npm run test:unit", Some("test-command"))
            .unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(second.author, "t-2");
        store
            .add_note("ws-1", "t-1", "API returns snake_case JSON", None)
            .unwrap();
        store.add_note("ws-2", "t-9", "npm elsewhere", None).unwrap();

        let hits = store.search_notes("ws-1", "NPM unit").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].body, "npm run test:unit");
        assert_eq!(store.search_notes("ws-1", "").unwrap().len(), 2);
        assert_eq!(store.search_notes("ws-1", "test-command").unwrap().len(), 1);
    }

    #[test]
    fn statuses_are_scoped_and_validated() {
        let mut store = McpStore::in_memory();
        store
            .report_status("ws-1", "t-1", AgentState::Working, "parsing")
            .unwrap();
        store
            .report_status("ws-2", "t-5", AgentState::Idle, "")
            .unwrap();
        assert_eq!(store.statuses("ws-1").len(), 1);
        assert!(store
            .report_status("ws-1", "t-1", AgentState::Idle, &"x".repeat(501))
            .is_err());
        store.forget_status("t-1");
        assert!(store.statuses("ws-1").is_empty());
    }

    #[test]
    fn enabled_defaults_on_and_persists() {
        let dir = std::env::temp_dir().join(format!("terra-mcp-store-{}", now_millis()));
        let path = dir.join("mcp.sqlite");
        {
            let mut store = McpStore::open(path.clone());
            assert!(store.enabled());
            store.set_enabled(false).unwrap();
            store.create_task("ws-1", "t-1", task("kept")).unwrap();
            store.create_task("ws-gone", "t-1", task("dropped")).unwrap();
            store
                .retain_workspaces(&HashSet::from(["ws-1".to_string()]))
                .unwrap();
        }
        let store = McpStore::open(path.clone());
        assert!(!store.enabled());
        assert_eq!(store.list_tasks("ws-1", None, None).unwrap().len(), 1);
        assert!(store.list_tasks("ws-gone", None, None).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupt_database_is_backed_up() {
        let dir = std::env::temp_dir().join(format!("terra-mcp-corrupt-{}", now_millis()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("mcp.sqlite");
        std::fs::write(&path, b"this is not a sqlite database at all, not even close").unwrap();
        let mut store = McpStore::open(path.clone());
        store.create_task("ws-1", "t-1", task("fresh")).unwrap();
        assert!(dir.join("mcp.sqlite.bak").exists());
        let _ = std::fs::remove_dir_all(dir);
    }
}
