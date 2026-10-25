//! SQLite connection and schema migrations for `<app_data_dir>/mcp.db`.
//!
//! Migrations are an append-only list applied in one transaction on startup;
//! `PRAGMA user_version` records how many have run. Never edit a shipped
//! migration: add a new one.

use rusqlite::Connection;
use std::path::Path;
use std::time::Duration;

pub const DB_FILE: &str = "mcp.db";
/// How long a connection waits for another one's write lock.
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

const MIGRATION_1: &str = r#"
CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Monotonic counters for human-friendly ids ("T-12").
CREATE TABLE counters (
    name  TEXT PRIMARY KEY,
    value INTEGER NOT NULL
);
INSERT INTO counters(name, value) VALUES ('task', 0);

CREATE TABLE tasks (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    title        TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'todo'
                 CHECK (status IN ('todo','in_progress','review','done','blocked')),
    priority     INTEGER NOT NULL DEFAULT 2,  -- 0 urgent … 3 low
    assignee     TEXT,                        -- terminal id
    created_by   TEXT NOT NULL,               -- terminal id or 'user'
    labels       TEXT NOT NULL DEFAULT '[]',  -- JSON array
    position     REAL NOT NULL DEFAULT 0,     -- order inside a status column
    created_at   INTEGER NOT NULL,            -- unix ms
    updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_tasks_ws_status ON tasks(workspace_id, status);
CREATE INDEX idx_tasks_assignee  ON tasks(assignee);

CREATE TABLE task_deps (
    task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    depends_on TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, depends_on)
);

CREATE TABLE task_events (
    id         INTEGER PRIMARY KEY,
    task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    actor      TEXT NOT NULL,
    kind       TEXT NOT NULL,                 -- created|claimed|status|assigned|note|completed
    body       TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);
CREATE INDEX idx_task_events_task ON task_events(task_id, created_at);

CREATE TABLE messages (
    id           INTEGER PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    sender       TEXT NOT NULL,
    recipient    TEXT NOT NULL,               -- terminal id or 'all'
    body         TEXT NOT NULL,
    created_at   INTEGER NOT NULL
);
CREATE INDEX idx_messages_ws_recipient ON messages(workspace_id, recipient, id);

CREATE TABLE message_reads (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    reader     TEXT NOT NULL,
    PRIMARY KEY (message_id, reader)
);

CREATE TABLE notes (
    id           INTEGER PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    key          TEXT,
    body         TEXT NOT NULL,
    author       TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_notes_ws ON notes(workspace_id, updated_at);
CREATE UNIQUE INDEX idx_notes_ws_key ON notes(workspace_id, key) WHERE key IS NOT NULL;

-- Full-text index over the note key and body, kept in step by triggers.
CREATE VIRTUAL TABLE notes_fts USING fts5(key, body, content='notes', content_rowid='id');
CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, key, body) VALUES (new.id, coalesce(new.key, ''), new.body);
END;
CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, key, body)
    VALUES ('delete', old.id, coalesce(old.key, ''), old.body);
END;
CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, key, body)
    VALUES ('delete', old.id, coalesce(old.key, ''), old.body);
    INSERT INTO notes_fts(rowid, key, body) VALUES (new.id, coalesce(new.key, ''), new.body);
END;
"#;

const MIGRATION_2: &str = r#"
CREATE INDEX idx_task_deps_depends_on ON task_deps(depends_on);
"#;

const MIGRATIONS: &[&str] = &[MIGRATION_1, MIGRATION_2];

pub fn schema_version() -> u32 {
    // MIGRATIONS is a short compile-time list, so its length always fits in a u32.
    MIGRATIONS.len() as u32
}

fn configure(conn: &Connection, file_backed: bool) -> rusqlite::Result<()> {
    conn.busy_timeout(BUSY_TIMEOUT)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    if file_backed {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
    }
    Ok(())
}

/// Bring the schema up to date. Returns the resulting version.
pub fn migrate(conn: &mut Connection) -> Result<u32, String> {
    let current: u32 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    let target = schema_version();
    if current > target {
        return Err(format!(
            "mcp.db has schema version {}, newer than this app understands ({})",
            current, target
        ));
    }
    if current == target {
        return Ok(current);
    }
    let applied = usize::try_from(current).map_err(|error| error.to_string())?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    for (index, sql) in MIGRATIONS.iter().enumerate().skip(applied) {
        tx.execute_batch(sql)
            .map_err(|error| format!("migration {} failed: {}", index + 1, error))?;
    }
    tx.pragma_update(None, "user_version", target)
        .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(target)
}

/// Open the database file and migrate it. Any failure leaves the file as it
/// is: the caller runs the app with the MCP server off.
pub fn open(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut conn = Connection::open(path).map_err(|error| error.to_string())?;
    configure(&conn, true).map_err(|error| error.to_string())?;
    migrate(&mut conn)?;
    Ok(conn)
}

#[cfg(test)]
pub fn open_in_memory() -> Connection {
    let mut conn = Connection::open_in_memory().expect("in-memory SQLite must open");
    configure(&conn, false).expect("in-memory SQLite must configure");
    migrate(&mut conn).expect("migrations must apply to an empty database");
    conn
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir()
            .join(format!("terra-mcp-db-{}-{}", name, nanos))
            .join(DB_FILE)
    }

    #[test]
    fn migrations_apply_from_scratch_and_are_idempotent() {
        let path = temp_path("fresh");
        {
            let conn = open(&path).unwrap();
            let version: u32 = conn
                .query_row("PRAGMA user_version", [], |r| r.get(0))
                .unwrap();
            assert_eq!(version, schema_version());
            let mode: String = conn
                .query_row("PRAGMA journal_mode", [], |r| r.get(0))
                .unwrap();
            assert_eq!(mode, "wal");
            conn.execute(
                "INSERT INTO settings(key, value) VALUES ('probe', 'kept')",
                [],
            )
            .unwrap();
        }
        // Reopening runs no migration again and keeps the data.
        let mut conn = open(&path).unwrap();
        assert_eq!(migrate(&mut conn).unwrap(), schema_version());
        let kept: String = conn
            .query_row("SELECT value FROM settings WHERE key = 'probe'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(kept, "kept");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_newer_schema_is_refused_without_touching_the_file() {
        let path = temp_path("newer");
        {
            let conn = open(&path).unwrap();
            conn.pragma_update(None, "user_version", schema_version() + 1)
                .unwrap();
        }
        let error = open(&path).unwrap_err();
        assert!(error.contains("newer"), "{}", error);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_file_that_is_not_sqlite_fails_to_open() {
        let path = temp_path("garbage");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"definitely not a database, just some bytes here").unwrap();
        assert!(open(&path).is_err());
        // The file is left for the user to inspect.
        assert!(path.exists());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn given_a_version_1_database_when_migrating_then_it_gains_the_depends_on_index() {
        let mut conn = Connection::open_in_memory().unwrap();
        configure(&conn, false).unwrap();
        conn.execute_batch(MIGRATION_1).unwrap();
        conn.pragma_update(None, "user_version", 1).unwrap();

        assert_eq!(migrate(&mut conn).unwrap(), schema_version());

        let indexes: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_task_deps_depends_on'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(indexes, 1);
    }

    #[test]
    fn given_a_migrated_database_when_finding_the_tasks_that_depend_on_one_then_the_plan_uses_the_index(
    ) {
        let conn = open_in_memory();

        let plan: String = conn
            .query_row(
                "EXPLAIN QUERY PLAN SELECT task_id FROM task_deps WHERE depends_on = 'task'",
                [],
                |row| row.get(3),
            )
            .unwrap();

        assert!(plan.contains("idx_task_deps_depends_on"), "{}", plan);
    }

    #[test]
    fn fts5_is_available() {
        let conn = open_in_memory();
        conn.execute(
            "INSERT INTO notes(workspace_id, key, body, author, created_at, updated_at)
             VALUES ('ws', 'k', 'ação rápida', 't-1', 1, 1)",
            [],
        )
        .unwrap();
        let hits: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes_fts WHERE notes_fts MATCH '\"acao\"'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1);
    }
}
