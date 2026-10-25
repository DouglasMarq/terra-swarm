use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

use crate::mcp::McpHub;
use crate::pty::{bump_next_terminal_id, kill_all, kill_terminal_inner, PtyManager};
use crate::sync::LockExt;
use crate::workspace::{
    bump_next_group_id, bump_next_id, emit_workspaces_changed, mark_imported_sessions_suspended,
    parse_import_snapshot, replace_store_file, transfer_counts, validate_explicit_path,
    WorkspaceSnapshotTransfer, WorkspaceStore, WORKSPACE_FILE_VERSION,
};

/// Called by `close_workspace`: workspaces live in `workspaces.json`, so
/// their MCP data has no foreign key to cascade from.
fn purge_workspace(app: &AppHandle, workspace_id: &str) {
    if let Some(hub) = app.try_state::<Arc<McpHub>>() {
        hub.purge_workspace(workspace_id);
    }
}

/// Mark a group suspended and stop its PTYs without deleting terminal
/// metadata or durable scrollback. Resume remains a metadata-only operation;
/// the frontend decides when to enqueue respawns.
#[tauri::command(async)]
pub fn suspend_group(app: AppHandle, id: String) -> Result<(), String> {
    let store = app.state::<Mutex<WorkspaceStore>>();
    let terminal_ids = {
        let mut store = store.lock_or_recover();
        store.suspend_group(&id)?
    };
    let manager = app.state::<Mutex<PtyManager>>();
    for terminal_id in terminal_ids {
        kill_terminal_inner(&manager, &terminal_id);
    }
    emit_workspaces_changed(&app);
    Ok(())
}

#[tauri::command(async)]
pub fn close_workspace(app: AppHandle, id: String) -> Result<(), String> {
    let store = app.state::<Mutex<WorkspaceStore>>();
    let terminals = {
        let mut store = store.lock_or_recover();
        store.remove(&id).map(|ws| ws.terminals)
    };
    purge_workspace(&app, &id);
    if let Some(terminals) = terminals {
        let manager = app.state::<Mutex<PtyManager>>();
        for t in terminals {
            kill_terminal_inner(&manager, &t.id);
        }
    }
    emit_workspaces_changed(&app);
    Ok(())
}

/// Import a validated legacy/v1/v2 snapshot.  The current store is backed up
/// and replaced atomically; all currently tracked PTYs are stopped so the
/// imported metadata cannot accidentally describe an inherited live process.
#[tauri::command(async)]
pub fn import_workspace_snapshot(
    app: AppHandle,
    path: String,
) -> Result<WorkspaceSnapshotTransfer, String> {
    let source = validate_explicit_path(&path)?;
    let raw = std::fs::read_to_string(&source).map_err(|error| {
        format!(
            "failed to read workspace snapshot {}: {}",
            source.display(),
            error
        )
    })?;
    let mut imported = parse_import_snapshot(&raw)?;
    mark_imported_sessions_suspended(&mut imported);
    let counts = transfer_counts(&imported);
    let json = imported
        .serialized_snapshot()
        .map_err(|error| format!("failed to serialize imported workspace snapshot: {}", error))?;

    let state = app.state::<Mutex<WorkspaceStore>>();
    let mut current = state.lock_or_recover();
    let target = current
        .save_path
        .clone()
        .ok_or_else(|| "workspace store has no persistence path".to_string())?;
    let backup = replace_store_file(&target, &json)?;

    // A transfer is metadata-only. Stop every process known to this app
    // before swapping the in-memory store, including sessions absent from the
    // old persisted file after a previous interrupted operation.
    let manager = app.state::<Mutex<PtyManager>>();
    kill_all(&manager);

    imported.save_path = Some(target);
    for workspace in &imported.workspaces {
        bump_next_id(&workspace.id);
        for terminal in &workspace.terminals {
            bump_next_terminal_id(&terminal.id);
        }
    }
    for group in &imported.groups {
        bump_next_group_id(&group.id);
    }
    *current = imported;
    drop(current);
    emit_workspaces_changed(&app);

    Ok(WorkspaceSnapshotTransfer {
        version: WORKSPACE_FILE_VERSION,
        path: source.to_string_lossy().into_owned(),
        backup_path: backup.map(|path| path.to_string_lossy().into_owned()),
        workspace_count: counts.0,
        group_count: counts.1,
        terminal_count: counts.2,
        suspended_terminal_count: counts.3,
    })
}
