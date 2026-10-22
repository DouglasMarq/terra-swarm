---
paths:
  - "src-tauri/src/mcp/**"
  - "src-tauri/src/workspace/persistence.rs"
  - "src-tauri/src/workspace/snapshot.rs"
  - "src-tauri/src/scrollback.rs"
  - "src/domain/migration.ts"
---

## Scope

- The only database is SQLite (`rusqlite`, bundled) at `<app data>/mcp.db`, owned by the MCP hub. On macOS: `~/Library/Application Support/com.terra-swarm.app/mcp.db`.
- Other persisted state is plain files owned by the backend: `workspaces.json` (`workspace/persistence.rs`: versioned envelope, forgiving decode, debounced atomic writes, `.bak` of anything dropped), durable scrollback (`scrollback.rs`) and the frontend's `localStorage` preferences. Their format rules are in §Persisted files.

## Schema changes

- Migrations are SQL strings in the append-only `MIGRATIONS` list in `src-tauri/src/mcp/db.rs` (`MIGRATION_1`, `MIGRATION_2`, ...). `migrate` applies the missing ones in one transaction on startup and records the count in `PRAGMA user_version`; a database newer than the app is refused, never downgraded.
- !IMPORTANT: NEVER edit a migration that has already been merged into `development` or released — add a new `MIGRATION_<n+1>` constant and append it to `MIGRATIONS`. The pre-tool hook cannot enforce this, because every migration lives in the same file as the migration runner: before touching an existing `MIGRATION_<n>`, check it is absent from `development` (`git show development:src-tauri/src/mcp/db.rs`).
- !IMPORTANT: NEVER DROP TABLES OR COLUMNS WITHOUT EXPLICIT USER CONFIRMATION.
- A failed open or migration leaves the file untouched and the app runs with the MCP server off (Settings shows the reason). A new migration must keep that true: no partial writes outside the migration transaction.
- Every new migration gets a `db.rs` test that upgrades a database at the previous version (with rows in it) besides the existing from-scratch test (`migrations_apply_from_scratch_and_are_idempotent`).

## Naming conventions

| Element | Convention | Example |
| --- | --- | --- |
| Table name | lowercase plural, snake_case | `tasks`, `task_events`, `message_reads` |
| Column name | snake_case | `workspace_id`, `created_at` |
| Index name | `idx_<table>_<columns>` (existing style) | `idx_tasks_ws_status`, `idx_notes_ws_key` |
| FTS table / triggers | `<table>_fts`, `<table>_ai` / `_ad` / `_au` | `notes_fts`, `notes_au` |
| Timestamps | `INTEGER` unix milliseconds, `_at` suffix | `updated_at` |
| Closed sets | `TEXT` + `CHECK (... IN (...))` | `tasks.status` |

## Queries

- !IMPORTANT: Use bound parameters (`params![...]`, `?1`) for every value — see `.claude/rules/security.md`. `format!` into SQL is allowed only for compile-time table names from constants.
- !IMPORTANT: Every query on `tasks`, `messages` and `notes` is filtered by `workspace_id`, taken from the caller's identity.
- Every column used in a frequent `WHERE`/`JOIN`/`ORDER BY` is covered by an index (`workspace_id` + status, recipient, key).
- Multi-row writes that must succeed together run inside one `self.conn.transaction()` (task + dependencies + history event; claim checks + update).
- Avoid loops that perform individual queries for each iteration — prefer batch operations or set-based queries.
- `foreign_keys = ON` and `busy_timeout` are set for every connection; file databases use `journal_mode = WAL` and `synchronous = NORMAL` (`db.rs::configure`). Children reference their task with `ON DELETE CASCADE`.
- `notes_fts` is an external-content FTS5 table kept in step by the `notes_ai/ad/au` triggers: any new write path to `notes` goes through SQL that fires them.
- SQLite calls are blocking: they run under `spawn_blocking` or in `#[tauri::command(async)]` commands, never directly on the async runtime.
- Store errors are `StoreError` (`NotFound`, `Invalid`, `Conflict`, `Unavailable`, `Database`); NEVER return `rusqlite::Error` text to agents beyond what `StoreError::Database` already wraps.

## Persisted files

- !IMPORTANT: Files written by a released version must still load in the next one. Change a format by bumping its version and adding a migration step (`workspaces.json` envelope, `src/domain/migration.ts` for `WorkspaceSnapshotV2`), never by reinterpreting existing fields.
- Writes are atomic (temporary file + rename) and decoding is forgiving: drop and back up what can't be read instead of failing the whole file.
- Persisted file names are derived from validated ids, never from raw input (`scrollback.rs` refuses ids that are not plain path components and refuses symlinks).
