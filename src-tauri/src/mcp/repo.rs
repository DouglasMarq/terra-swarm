use rusqlite::types::Value;
use rusqlite::{
    params, params_from_iter, Connection, OptionalExtension, Row, Transaction, TransactionBehavior,
};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use super::model::{
    task_not_found, Message, Note, StoreError, StoreResult, Task, TaskEvent, TaskPriority,
    TaskStatus, MAX_LIMIT,
};

const WORKSPACE_TABLES: [&str; 3] = ["tasks", "messages", "notes"];
const TASK_STATUS_COLUMN: usize = 4;
const NOTE_KEY_WEIGHT: f64 = 2.0;
const NOTE_BODY_WEIGHT: f64 = 1.0;
const STATUS_ORDER: [TaskStatus; 4] = [
    TaskStatus::InProgress,
    TaskStatus::Todo,
    TaskStatus::Blocked,
    TaskStatus::Review,
];
const TASK_COLUMNS: &str = "id, workspace_id, title, description, status, priority, assignee,
     created_by, labels, position, created_at, updated_at";
static TASK_ORDER_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{}, CASE status WHEN '{}' THEN updated_at END DESC, priority, position, created_at",
        status_rank_sql(),
        TaskStatus::Done.as_str()
    )
});

fn sql_limit(limit: usize) -> i64 {
    i64::try_from(limit).unwrap_or(i64::MAX)
}

fn status_rank_sql() -> String {
    let cases: String = STATUS_ORDER
        .iter()
        .enumerate()
        .map(|(rank, status)| format!("WHEN '{}' THEN {} ", status.as_str(), rank))
        .collect();
    format!("CASE status {}ELSE {} END", cases, STATUS_ORDER.len())
}

struct TaskFilter {
    conditions: Vec<String>,
    values: Vec<Value>,
}

impl TaskFilter {
    fn of(query: &TaskQuery<'_>) -> Self {
        let mut filter = Self {
            conditions: Vec::new(),
            values: Vec::new(),
        };
        filter.add("workspace_id =", Value::Text(query.workspace_id.into()));
        match query.status {
            StatusFilter::Any => {}
            StatusFilter::Is(status) => filter.add("status =", Value::Text(status.as_str().into())),
            StatusFilter::Unfinished => {
                filter.add("status !=", Value::Text(TaskStatus::Done.as_str().into()))
            }
        }
        if let Some(assignee) = query.assignee {
            filter.add("assignee =", Value::Text(assignee.into()));
        }
        filter.values.push(Value::Integer(sql_limit(query.limit)));
        filter
    }

    fn add(&mut self, condition: &str, value: Value) {
        self.values.push(value);
        self.conditions
            .push(format!("{} ?{}", condition, self.values.len()));
    }

    fn sql(&self) -> String {
        format!(
            "SELECT {} FROM tasks WHERE {} ORDER BY {} LIMIT ?{}",
            TASK_COLUMNS,
            self.conditions.join(" AND "),
            *TASK_ORDER_SQL,
            self.values.len()
        )
    }
}

#[derive(Clone, Copy)]
pub enum StatusFilter {
    Any,
    Is(TaskStatus),
    Unfinished,
}

pub struct TaskQuery<'a> {
    pub workspace_id: &'a str,
    pub status: StatusFilter,
    pub assignee: Option<&'a str>,
    pub events: Option<usize>,
    pub limit: usize,
}

impl<'a> TaskQuery<'a> {
    pub fn all(workspace_id: &'a str) -> Self {
        Self {
            workspace_id,
            status: StatusFilter::Any,
            assignee: None,
            events: None,
            limit: MAX_LIMIT,
        }
    }
}

pub struct EventRecord<'a> {
    pub task_id: &'a str,
    pub actor: &'a str,
    pub kind: &'a str,
    pub body: &'a str,
    pub at: i64,
}

pub struct MessageRecord<'a> {
    pub workspace_id: &'a str,
    pub from: &'a str,
    pub to: &'a str,
    pub body: &'a str,
    pub at: i64,
}

pub struct NoteRecord<'a> {
    pub workspace_id: &'a str,
    pub key: Option<&'a str>,
    pub body: &'a str,
    pub author: &'a str,
    pub at: i64,
}

pub struct InboxQuery<'a> {
    pub workspace_id: &'a str,
    pub reader: &'a str,
    pub is_unread_only: bool,
    pub limit: usize,
}

fn fts_query(query: &str) -> Option<String> {
    let terms: Vec<String> = query
        .split_whitespace()
        .map(|term| term.replace('"', ""))
        .filter(|term| !term.is_empty())
        .map(|term| format!("\"{}\"*", term))
        .collect();
    (!terms.is_empty()).then(|| terms.join(" "))
}

fn json_list<T: Into<serde_json::Value>>(items: impl Iterator<Item = T>) -> String {
    items.collect::<serde_json::Value>().to_string()
}

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

fn status_from_row(row: &Row<'_>) -> rusqlite::Result<TaskStatus> {
    let status: String = row.get(TASK_STATUS_COLUMN)?;
    TaskStatus::parse(&status).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            TASK_STATUS_COLUMN,
            rusqlite::types::Type::Text,
            format!("unknown task status {:?}", status).into(),
        )
    })
}

fn task_from_row(row: &Row<'_>) -> rusqlite::Result<Task> {
    let id: String = row.get(0)?;
    let status = status_from_row(row)?;
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
        status,
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

fn task_index(tasks: &[Task]) -> HashMap<String, usize> {
    tasks
        .iter()
        .enumerate()
        .map(|(position, task)| (task.id.clone(), position))
        .collect()
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

#[derive(Clone, Copy)]
pub struct Queries<'c> {
    conn: &'c Connection,
}

impl Queries<'_> {
    pub fn has_task(&self, workspace_id: &str, id: &str) -> StoreResult<bool> {
        let found = self
            .conn
            .query_row(
                "SELECT 1 FROM tasks WHERE id = ?1 AND workspace_id = ?2",
                params![id, workspace_id],
                |_| Ok(()),
            )
            .optional()?;
        Ok(found.is_some())
    }

    pub fn task(&self, workspace_id: &str, id: &str, events: Option<usize>) -> StoreResult<Task> {
        let mut task = self
            .conn
            .query_row(
                "SELECT id, workspace_id, title, description, status, priority, assignee, created_by,
                        labels, position, created_at, updated_at
                 FROM tasks WHERE id = ?1 AND workspace_id = ?2",
                params![id, workspace_id],
                task_from_row,
            )
            .optional()?
            .ok_or_else(|| task_not_found(id))?;
        self.attach_task_details(workspace_id, std::slice::from_mut(&mut task), events)?;
        Ok(task)
    }

    pub fn existing_task_ids(
        &self,
        workspace_id: &str,
        ids: &[&str],
    ) -> StoreResult<HashSet<String>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT id FROM tasks
             WHERE workspace_id = ?1 AND id IN (SELECT value FROM json_each(?2))",
        )?;
        let rows = stmt.query_map(
            params![workspace_id, json_list(ids.iter().copied())],
            |row| row.get(0),
        )?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn list_tasks(&self, query: &TaskQuery<'_>) -> StoreResult<Vec<Task>> {
        let mut tasks: Vec<Task> = {
            let filter = TaskFilter::of(query);
            let mut stmt = self.conn.prepare_cached(&filter.sql())?;
            let rows = stmt.query_map(params_from_iter(&filter.values), task_from_row)?;
            rows.collect::<Result<_, _>>()?
        };
        self.attach_task_details(query.workspace_id, &mut tasks, query.events)?;
        Ok(tasks)
    }

    fn attach_task_details(
        &self,
        workspace_id: &str,
        tasks: &mut [Task],
        events: Option<usize>,
    ) -> StoreResult<()> {
        self.attach_dependencies(workspace_id, tasks)?;
        let Some(limit) = events else {
            return Ok(());
        };
        self.attach_events(tasks, limit)
    }

    fn attach_dependencies(&self, workspace_id: &str, tasks: &mut [Task]) -> StoreResult<()> {
        let index = task_index(tasks);
        let mut stmt = self.conn.prepare_cached(
            "SELECT d.task_id, d.depends_on, t.status FROM task_deps d
             JOIN tasks t ON t.id = d.depends_on AND t.workspace_id = ?1
             WHERE d.task_id IN (SELECT value FROM json_each(?2))
             ORDER BY t.created_at",
        )?;
        let ids = json_list(tasks.iter().map(|task| task.id.as_str()));
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
        Ok(())
    }

    fn attach_events(&self, tasks: &mut [Task], limit: usize) -> StoreResult<()> {
        let index = task_index(tasks);
        for task in tasks.iter_mut() {
            task.events = Some(Vec::new());
        }
        let mut stmt = self.conn.prepare_cached(
            "SELECT task_id, actor, kind, body, created_at FROM (
                SELECT id, task_id, actor, kind, body, created_at,
                       ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY id DESC) AS recency
                FROM task_events WHERE task_id IN (SELECT value FROM json_each(?1))
             ) WHERE recency <= ?2 ORDER BY id",
        )?;
        let ids = json_list(tasks.iter().map(|task| task.id.as_str()));
        let rows = stmt.query_map(params![ids, sql_limit(limit)], |row| {
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

    pub fn next_task_number(&self) -> StoreResult<i64> {
        Ok(self.conn.query_row(
            "UPDATE counters SET value = value + 1 WHERE name = 'task' RETURNING value",
            [],
            |row| row.get(0),
        )?)
    }

    pub fn max_position(&self, workspace_id: &str, status: TaskStatus) -> StoreResult<Option<f64>> {
        Ok(self.conn.query_row(
            "SELECT MAX(position) FROM tasks WHERE workspace_id = ?1 AND status = ?2",
            params![workspace_id, status.as_str()],
            |row| row.get(0),
        )?)
    }

    pub fn insert_task(&self, task: &Task) -> StoreResult<()> {
        let labels = serde_json::to_string(&task.labels)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        self.conn.execute(
            "INSERT INTO tasks(id, workspace_id, title, description, status, priority, assignee,
                               created_by, labels, position, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                task.id,
                task.workspace_id,
                task.title,
                task.description,
                task.status.as_str(),
                task.priority.rank(),
                task.assignee,
                task.created_by,
                labels,
                task.position,
                task.created_at,
                task.updated_at
            ],
        )?;
        for dep in &task.depends_on {
            self.conn.execute(
                "INSERT INTO task_deps(task_id, depends_on) VALUES (?1, ?2)",
                params![task.id, dep],
            )?;
        }
        Ok(())
    }

    pub fn save_task(&self, task: &Task) -> StoreResult<()> {
        self.conn.execute(
            "UPDATE tasks SET title = ?1, description = ?2, status = ?3, priority = ?4,
                              assignee = ?5, position = ?6, updated_at = ?7
             WHERE id = ?8 AND workspace_id = ?9",
            params![
                task.title,
                task.description,
                task.status.as_str(),
                task.priority.rank(),
                task.assignee,
                task.position,
                task.updated_at,
                task.id,
                task.workspace_id
            ],
        )?;
        Ok(())
    }

    pub fn add_event(&self, event: &EventRecord<'_>) -> StoreResult<()> {
        self.conn.execute(
            "INSERT INTO task_events(task_id, actor, kind, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![event.task_id, event.actor, event.kind, event.body, event.at],
        )?;
        Ok(())
    }

    pub fn delete_task(&self, workspace_id: &str, id: &str) -> StoreResult<()> {
        self.conn.execute(
            "DELETE FROM tasks WHERE id = ?1 AND workspace_id = ?2",
            params![id, workspace_id],
        )?;
        Ok(())
    }

    pub fn insert_message(&self, message: &MessageRecord<'_>) -> StoreResult<Message> {
        self.conn.execute(
            "INSERT INTO messages(workspace_id, sender, recipient, body, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                message.workspace_id,
                message.from,
                message.to,
                message.body,
                message.at
            ],
        )?;
        self.message(message.workspace_id, self.conn.last_insert_rowid())
    }

    pub fn message(&self, workspace_id: &str, id: i64) -> StoreResult<Message> {
        let mut message = self
            .conn
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
        self.attach_readers(std::slice::from_mut(&mut message))?;
        Ok(message)
    }

    pub fn inbox(&self, query: &InboxQuery<'_>) -> StoreResult<Vec<Message>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT id, workspace_id, sender, recipient, body, created_at FROM messages m
                 WHERE workspace_id = ?1 AND (recipient = ?2 OR recipient = 'all') AND sender != ?2
                   AND (?3 = 0 OR NOT EXISTS (
                        SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.reader = ?2))
                 ORDER BY id LIMIT ?4",
        )?;
        let rows = stmt.query_map(
            params![
                query.workspace_id,
                query.reader,
                query.is_unread_only,
                sql_limit(query.limit)
            ],
            message_from_row,
        )?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn mark_read(&self, reader: &str, messages: &[Message]) -> StoreResult<()> {
        let ids = json_list(messages.iter().map(|message| message.id));
        self.conn.execute(
            "INSERT OR IGNORE INTO message_reads(message_id, reader)
             SELECT value, ?2 FROM json_each(?1)",
            params![ids, reader],
        )?;
        Ok(())
    }

    pub fn attach_readers(&self, messages: &mut [Message]) -> StoreResult<()> {
        let index: HashMap<i64, usize> = messages
            .iter()
            .enumerate()
            .map(|(position, message)| (message.id, position))
            .collect();
        let mut stmt = self.conn.prepare_cached(
            "SELECT message_id, reader FROM message_reads
             WHERE message_id IN (SELECT value FROM json_each(?1)) ORDER BY rowid",
        )?;
        let ids = json_list(messages.iter().map(|message| message.id));
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

    pub fn unread_count(&self, workspace_id: &str, reader: &str) -> StoreResult<usize> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM messages m
             WHERE workspace_id = ?1 AND (recipient = ?2 OR recipient = 'all') AND sender != ?2
               AND NOT EXISTS (
                    SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.reader = ?2)",
            params![workspace_id, reader],
            |row| row.get(0),
        )?;
        Ok(usize::try_from(count)
            .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(0, count))?)
    }

    pub fn upsert_note(&self, note: &NoteRecord<'_>) -> StoreResult<Note> {
        let id: i64 = self.conn.query_row(
            "INSERT INTO notes(workspace_id, key, body, author, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT(workspace_id, key) WHERE key IS NOT NULL
             DO UPDATE SET body = excluded.body, author = excluded.author, updated_at = excluded.updated_at
             RETURNING id",
            params![note.workspace_id, note.key, note.body, note.author, note.at],
            |row| row.get(0),
        )?;
        self.note(note.workspace_id, id)
    }

    pub fn note(&self, workspace_id: &str, id: i64) -> StoreResult<Note> {
        self.conn
            .query_row(
                "SELECT id, workspace_id, key, body, author, created_at, updated_at FROM notes
                 WHERE id = ?1 AND workspace_id = ?2",
                params![id, workspace_id],
                note_from_row,
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound(format!("note {} not found in this workspace", id)))
    }

    pub fn search_notes(
        &self,
        workspace_id: &str,
        query: &str,
        limit: usize,
    ) -> StoreResult<Vec<Note>> {
        let notes: Vec<Note> = match fts_query(query) {
            Some(fts) => {
                let mut stmt = self.conn.prepare_cached(
                    "SELECT n.id, n.workspace_id, n.key, n.body, n.author, n.created_at, n.updated_at
                     FROM notes_fts f JOIN notes n ON n.id = f.rowid
                     WHERE notes_fts MATCH ?1 AND n.workspace_id = ?2
                     ORDER BY bm25(notes_fts, ?4, ?5), n.updated_at DESC LIMIT ?3",
                )?;
                let rows = stmt.query_map(
                    params![
                        fts,
                        workspace_id,
                        sql_limit(limit),
                        NOTE_KEY_WEIGHT,
                        NOTE_BODY_WEIGHT
                    ],
                    note_from_row,
                )?;
                rows.collect::<Result<_, _>>()?
            }
            None => {
                let mut stmt = self.conn.prepare_cached(
                    "SELECT id, workspace_id, key, body, author, created_at, updated_at
                     FROM notes WHERE workspace_id = ?1
                     ORDER BY updated_at DESC, id DESC LIMIT ?2",
                )?;
                let rows =
                    stmt.query_map(params![workspace_id, sql_limit(limit)], note_from_row)?;
                rows.collect::<Result<_, _>>()?
            }
        };
        Ok(notes)
    }
}

pub struct RepoTx<'r> {
    tx: Transaction<'r>,
}

impl RepoTx<'_> {
    pub fn queries(&self) -> Queries<'_> {
        Queries { conn: &self.tx }
    }

    pub fn commit(self) -> StoreResult<()> {
        self.tx.commit()?;
        Ok(())
    }
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

    pub fn queries(&self) -> Queries<'_> {
        Queries { conn: &self.conn }
    }

    pub fn transaction(&mut self) -> StoreResult<RepoTx<'_>> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        Ok(RepoTx { tx })
    }

    pub fn is_enabled(&self) -> bool {
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

    pub fn set_enabled(&self, is_enabled: bool) -> StoreResult<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO settings(key, value) VALUES ('enabled', ?1)",
            params![if is_enabled { "1" } else { "0" }],
        )?;
        Ok(())
    }

    pub fn purge_workspace(&mut self, workspace_id: &str) -> StoreResult<()> {
        let tx = self.conn.transaction()?;
        delete_workspace_rows(&tx, workspace_id)?;
        tx.commit()?;
        Ok(())
    }

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

    #[cfg(test)]
    pub(super) fn count(&self, table: &str) -> i64 {
        self.conn
            .query_row(&format!("SELECT COUNT(*) FROM {}", table), [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    #[cfg(test)]
    pub(super) fn execute(&self, sql: &str, values: &[&dyn rusqlite::ToSql]) {
        self.conn.execute(sql, values).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::super::messages::{self, InboxRequest, Outgoing};
    use super::super::model::NewTask;
    use super::super::notes::{self, NoteDraft, NoteSearch};
    use super::super::tasks;
    use super::super::test_support::actor;
    use super::*;
    use crate::clock::now_millis;
    use rusqlite::params;

    fn task(title: &str) -> NewTask {
        NewTask {
            title: title.into(),
            ..NewTask::default()
        }
    }

    #[test]
    fn given_ids_of_another_workspace_when_loading_then_nothing_is_found() {
        let mut repo = Repo::in_memory();
        let task_id = tasks::create(&mut repo, &actor("ws-1", "t-1"), task("private"))
            .unwrap()
            .id;
        let message_id = messages::send(
            repo.queries(),
            &actor("ws-1", "t-1"),
            &Outgoing {
                to: "all",
                body: "hi",
            },
        )
        .unwrap()
        .id;
        let note_id = notes::add(
            repo.queries(),
            &actor("ws-1", "t-1"),
            &NoteDraft {
                key: None,
                body: "secret",
            },
        )
        .unwrap()
        .id;
        assert!(matches!(
            repo.queries().task("ws-2", &task_id, None),
            Err(StoreError::NotFound(_))
        ));
        assert!(matches!(
            repo.queries().message("ws-2", message_id),
            Err(StoreError::NotFound(_))
        ));
        assert!(matches!(
            repo.queries().note("ws-2", note_id),
            Err(StoreError::NotFound(_))
        ));
    }

    #[test]
    fn given_unreadable_labels_when_loading_the_task_then_it_has_none() {
        let mut repo = Repo::in_memory();
        let id = tasks::create(&mut repo, &actor("ws-1", "t-1"), task("x"))
            .unwrap()
            .id;
        repo.execute(
            "UPDATE tasks SET labels = 'not json' WHERE id = ?1",
            params![id],
        );
        assert!(tasks::get(&repo, "ws-1", &id).unwrap().labels.is_empty());
    }

    #[test]
    fn given_an_unknown_stored_status_when_loading_the_task_then_it_is_a_database_error() {
        let mut repo = Repo::in_memory();
        let id = tasks::create(&mut repo, &actor("ws-1", "t-1"), task("x"))
            .unwrap()
            .id;
        repo.execute("PRAGMA ignore_check_constraints = ON", &[]);
        repo.execute(
            "UPDATE tasks SET status = 'archived' WHERE id = ?1",
            params![id],
        );

        assert!(matches!(
            tasks::get(&repo, "ws-1", &id),
            Err(StoreError::Database(_))
        ));
    }

    #[test]
    fn given_a_limit_when_listing_tasks_then_open_tasks_come_first_and_then_the_latest_done() {
        let mut repo = Repo::in_memory();
        let ids: Vec<String> = ["open", "done long ago", "done lately"]
            .into_iter()
            .map(|title| {
                tasks::create(&mut repo, &actor("ws-1", "t-1"), task(title))
                    .unwrap()
                    .id
            })
            .collect();
        for (id, updated_at) in [(&ids[1], 10), (&ids[2], 20)] {
            repo.execute(
                "UPDATE tasks SET status = 'done', updated_at = ?2 WHERE id = ?1",
                params![id, updated_at],
            );
        }

        let listed = repo
            .queries()
            .list_tasks(&TaskQuery {
                limit: 2,
                ..TaskQuery::all("ws-1")
            })
            .unwrap();

        let listed: Vec<&str> = listed.iter().map(|task| task.id.as_str()).collect();
        assert_eq!(listed, [ids[0].as_str(), ids[2].as_str()]);
    }

    #[test]
    fn given_the_unfinished_filter_when_listing_an_agents_tasks_then_done_ones_are_left_out() {
        let mut repo = Repo::in_memory();
        let ids: Vec<String> = ["open", "finished"]
            .into_iter()
            .map(|title| {
                tasks::create(
                    &mut repo,
                    &actor("ws-1", "t-1"),
                    NewTask {
                        title: title.into(),
                        assignee: Some("t-1".into()),
                        ..NewTask::default()
                    },
                )
                .unwrap()
                .id
            })
            .collect();
        repo.execute(
            "UPDATE tasks SET status = 'done' WHERE id = ?1",
            params![ids[1]],
        );
        let query = TaskQuery {
            status: StatusFilter::Unfinished,
            assignee: Some("t-1"),
            ..TaskQuery::all("ws-1")
        };

        let listed = repo.queries().list_tasks(&query).unwrap();

        let listed: Vec<&str> = listed.iter().map(|task| task.id.as_str()).collect();
        assert_eq!(listed, [ids[0].as_str()]);
        let plan = list_tasks_plan(&repo, &query);
        assert!(plan.contains("idx_tasks_ws_assignee"), "{}", plan);
    }

    fn list_tasks_plan(repo: &Repo, query: &TaskQuery<'_>) -> String {
        let filter = TaskFilter::of(query);
        let mut stmt = repo
            .conn
            .prepare(&format!("EXPLAIN QUERY PLAN {}", filter.sql()))
            .unwrap();
        let rows = stmt
            .query_map(params_from_iter(&filter.values), |row| {
                row.get::<_, String>(3)
            })
            .unwrap();
        rows.collect::<Result<Vec<_>, _>>().unwrap().join("\n")
    }

    #[test]
    fn given_an_assignee_filter_when_listing_tasks_then_the_plan_uses_the_workspace_assignee_index()
    {
        let repo = Repo::in_memory();

        let plan = list_tasks_plan(
            &repo,
            &TaskQuery {
                assignee: Some("t-1"),
                ..TaskQuery::all("ws-1")
            },
        );

        assert!(plan.contains("idx_tasks_ws_assignee"), "{}", plan);
    }

    #[test]
    fn given_a_status_filter_when_listing_tasks_then_the_plan_searches_the_workspace_status_index()
    {
        let repo = Repo::in_memory();

        let plan = list_tasks_plan(
            &repo,
            &TaskQuery {
                status: StatusFilter::Is(TaskStatus::Review),
                ..TaskQuery::all("ws-1")
            },
        );

        assert!(
            plan.contains("idx_tasks_ws_status (workspace_id=? AND status=?)"),
            "{}",
            plan
        );
    }

    #[test]
    fn given_two_workspaces_when_purging_one_then_only_its_data_is_removed() {
        let mut repo = Repo::in_memory();
        for workspace_id in ["ws-1", "ws-2"] {
            let first = tasks::create(&mut repo, &actor(workspace_id, "t-1"), task("a")).unwrap();
            tasks::create(
                &mut repo,
                &actor(workspace_id, "t-1"),
                NewTask {
                    title: "b".into(),
                    depends_on: vec![first.id],
                    ..NewTask::default()
                },
            )
            .unwrap();
            let message = messages::send(
                repo.queries(),
                &actor(workspace_id, "t-1"),
                &Outgoing {
                    to: "all",
                    body: "hi",
                },
            )
            .unwrap();
            messages::read_inbox(
                &mut repo,
                &actor(workspace_id, "t-2"),
                &InboxRequest {
                    is_unread_only: true,
                    limit: None,
                },
            )
            .unwrap();
            assert!(message.id > 0);
            notes::add(
                repo.queries(),
                &actor(workspace_id, "t-1"),
                &NoteDraft {
                    key: Some("k"),
                    body: "note",
                },
            )
            .unwrap();
        }
        repo.purge_workspace("ws-1").unwrap();
        assert!(repo
            .queries()
            .list_tasks(&TaskQuery::all("ws-1"))
            .unwrap()
            .is_empty());
        assert!(notes::search(
            repo.queries(),
            "ws-1",
            &NoteSearch {
                query: "",
                limit: None
            }
        )
        .unwrap()
        .is_empty());
        assert_eq!(
            repo.queries()
                .list_tasks(&TaskQuery::all("ws-2"))
                .unwrap()
                .len(),
            2
        );
        assert_eq!(repo.count("task_deps"), 1);
        assert_eq!(repo.count("task_events"), 2);
        assert_eq!(repo.count("message_reads"), 1);
        assert_eq!(repo.count("notes_fts"), 1);

        repo.retain_workspaces(&HashSet::new()).unwrap();
        assert_eq!(repo.count("tasks"), 0);
        assert_eq!(repo.count("messages"), 0);
    }

    #[test]
    fn given_an_unreadable_setting_when_reading_it_then_the_server_stays_enabled() {
        let repo = Repo::in_memory();
        repo.execute("ALTER TABLE settings RENAME TO settings_gone", &[]);
        assert!(repo.is_enabled());
    }

    #[test]
    fn given_stored_data_and_settings_when_reopening_then_they_survive() {
        let dir = std::env::temp_dir().join(format!("terra-mcp-reopen-{}", now_millis()));
        let path = dir.join("mcp.db");
        {
            let mut repo = Repo::new(super::super::db::open(&path).unwrap());
            assert!(repo.is_enabled());
            repo.set_enabled(false).unwrap();
            tasks::create(&mut repo, &actor("ws-1", "t-1"), task("kept")).unwrap();
            messages::send(
                repo.queries(),
                &actor("ws-1", "t-1"),
                &Outgoing {
                    to: "all",
                    body: "kept",
                },
            )
            .unwrap();
            notes::add(
                repo.queries(),
                &actor("ws-1", "t-1"),
                &NoteDraft {
                    key: None,
                    body: "kept note",
                },
            )
            .unwrap();
        }
        let mut repo = Repo::new(super::super::db::open(&path).unwrap());
        assert!(!repo.is_enabled());
        assert_eq!(
            repo.queries()
                .list_tasks(&TaskQuery::all("ws-1"))
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            messages::read_inbox(
                &mut repo,
                &actor("ws-1", "t-2"),
                &InboxRequest {
                    is_unread_only: true,
                    limit: None
                }
            )
            .unwrap()
            .len(),
            1
        );
        assert_eq!(
            notes::search(
                repo.queries(),
                "ws-1",
                &NoteSearch {
                    query: "kept",
                    limit: None
                }
            )
            .unwrap()
            .len(),
            1
        );
        assert_eq!(
            tasks::create(&mut repo, &actor("ws-1", "t-1"), task("next"))
                .unwrap()
                .id,
            "T-2"
        );
        drop(repo);
        let _ = std::fs::remove_dir_all(dir);
    }
}
