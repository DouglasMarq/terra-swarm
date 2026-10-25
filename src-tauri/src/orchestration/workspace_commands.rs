use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, Runtime};

use crate::mcp::McpHub;
use crate::pty::{bump_next_terminal_id, kill_all, kill_terminal_inner, PtyManager};
use crate::sync::LockExt;
use crate::workspace::{
    bump_next_group_id, bump_next_id, change_and_save, emit_workspaces_changed,
    mark_imported_sessions_suspended, parse_import_snapshot, read_snapshot_file,
    replace_store_file, transfer_summary, validate_explicit_path, WorkspaceSnapshotTransfer,
    WorkspaceStore,
};

/// Called by `close_workspace`: workspaces live in `workspaces.json`, so
/// their MCP data has no foreign key to cascade from.
fn purge_workspace<R: Runtime>(app: &AppHandle<R>, workspace_id: &str) {
    if let Some(hub) = app.try_state::<Arc<McpHub<R>>>() {
        hub.purge_workspace(workspace_id);
    }
}

fn stop_terminals<R: Runtime>(app: &AppHandle<R>, terminal_ids: &[String]) {
    let manager = app.state::<Mutex<PtyManager>>();
    for terminal_id in terminal_ids {
        kill_terminal_inner(&manager, terminal_id);
    }
}

/// Mark a group suspended and stop its PTYs without deleting terminal
/// metadata or durable scrollback. Resume remains a metadata-only operation;
/// the frontend decides when to enqueue respawns.
#[tauri::command(async)]
pub fn suspend_group(app: AppHandle, id: String) -> Result<(), String> {
    suspend_and_stop(&app, &id)
}

fn suspend_and_stop<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<(), String> {
    let store = app.state::<Mutex<WorkspaceStore>>();
    let terminal_ids = change_and_save(&store, |store| {
        let terminal_ids = store.group_terminal_ids(id)?;
        store.suspend_group(id)?;
        Ok(terminal_ids)
    })?;
    stop_terminals(app, &terminal_ids);
    emit_workspaces_changed(app);
    Ok(())
}

#[tauri::command(async)]
pub fn close_workspace(app: AppHandle, id: String) -> Result<(), String> {
    close_and_stop(&app, &id);
    Ok(())
}

fn close_and_stop<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let store = app.state::<Mutex<WorkspaceStore>>();
    let terminal_ids = change_and_save(&store, |store| {
        store
            .remove(id)
            .ok_or_else(|| format!("workspace {} not found", id))
    })
    .map(|workspace| {
        workspace
            .terminals
            .into_iter()
            .map(|terminal| terminal.id)
            .collect::<Vec<_>>()
    })
    .unwrap_or_default();
    purge_workspace(app, id);
    stop_terminals(app, &terminal_ids);
    emit_workspaces_changed(app);
}

/// Import a validated legacy/v1/v2 snapshot.  The current store is backed up
/// and replaced atomically; all currently tracked PTYs are stopped so the
/// imported metadata cannot accidentally describe an inherited live process.
#[tauri::command(async)]
pub fn import_workspace_snapshot(
    app: AppHandle,
    path: String,
) -> Result<WorkspaceSnapshotTransfer, String> {
    import_snapshot(&app, &path)
}

fn import_snapshot<R: Runtime>(
    app: &AppHandle<R>,
    path: &str,
) -> Result<WorkspaceSnapshotTransfer, String> {
    let source = validate_explicit_path(path)?;
    let mut imported = parse_import_snapshot(&read_snapshot_file(&source)?)?;
    mark_imported_sessions_suspended(&mut imported);
    let mut transfer = transfer_summary(&imported, &source);
    let json = imported
        .serialized_snapshot()
        .map_err(|error| format!("failed to serialize imported workspace snapshot: {}", error))?;
    let backup = replace_running_store(app, imported, &json)?;
    emit_workspaces_changed(app);
    transfer.backup_path = backup.map(|path| path.to_string_lossy().into_owned());
    Ok(transfer)
}

fn replace_running_store<R: Runtime>(
    app: &AppHandle<R>,
    mut imported: WorkspaceStore,
    json: &str,
) -> Result<Option<PathBuf>, String> {
    let state = app.state::<Mutex<WorkspaceStore>>();
    let mut current = state.lock_or_recover();
    let target = current
        .save_path
        .clone()
        .ok_or_else(|| "workspace store has no persistence path".to_string())?;
    let backup = replace_store_file(&target, json)?;

    // A transfer is metadata-only. Stop every process known to this app
    // before swapping the in-memory store, including sessions absent from the
    // old persisted file after a previous interrupted operation.
    kill_all(&app.state::<Mutex<PtyManager>>());

    imported.save_path = Some(target);
    bump_imported_ids(&imported);
    *current = imported;
    Ok(backup)
}

fn bump_imported_ids(imported: &WorkspaceStore) {
    for workspace in &imported.workspaces {
        bump_next_id(&workspace.id);
        for terminal in &workspace.terminals {
            bump_next_terminal_id(&terminal.id);
        }
    }
    for group in &imported.groups {
        bump_next_group_id(&group.id);
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::pty::{
        running_terminals, spawn_terminal_inner, Registries, SpawnOptions, SpawnRequest,
    };
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tauri::test::{mock_app, MockRuntime};
    use tauri::{App, Listener};

    const WORKSPACES_CHANGED: &str = "workspaces-changed";
    const IMPORTED_ID_NUMBER: u64 = 9000;
    const TERMINAL_COLS: u16 = 80;
    const TERMINAL_ROWS: u16 = 24;

    static TEST_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

    fn test_directory(label: &str) -> PathBuf {
        let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir()
            .canonicalize()
            .expect("temp directory")
            .join(format!(
                "terra-orchestration-{label}-{}-{sequence}",
                std::process::id()
            ));
        std::fs::create_dir_all(&directory).expect("test directory");
        directory
    }

    fn app_with_store(save_path: Option<PathBuf>) -> App<MockRuntime> {
        let app = mock_app();
        assert!(app.manage(Mutex::new(PtyManager::default())));
        assert!(app.manage(Mutex::new(WorkspaceStore {
            save_path,
            ..WorkspaceStore::default()
        })));
        app
    }

    fn count_changes(app: &App<MockRuntime>) -> Arc<AtomicUsize> {
        let changes = Arc::new(AtomicUsize::new(0));
        let sink = Arc::clone(&changes);
        app.listen_any(WORKSPACES_CHANGED, move |_| {
            sink.fetch_add(1, Ordering::SeqCst);
        });
        changes
    }

    fn create_workspace(app: &App<MockRuntime>, name: &str) -> String {
        app.state::<Mutex<WorkspaceStore>>()
            .lock_or_recover()
            .create(
                name.to_string(),
                std::env::temp_dir().to_string_lossy().into_owned(),
            )
            .id
    }

    fn spawn_sleeper(app: &App<MockRuntime>, workspace_id: &str) -> String {
        spawn_terminal_inner(
            app.handle(),
            Registries {
                manager: app.state::<Mutex<PtyManager>>().inner(),
                store: app.state::<Mutex<WorkspaceStore>>().inner(),
            },
            SpawnRequest {
                workspace_id,
                command: "sleep 30",
                cols: TERMINAL_COLS,
                rows: TERMINAL_ROWS,
                terminal_id: None,
                options: &SpawnOptions::default(),
            },
        )
        .expect("spawn sleeper")
        .meta
        .id
    }

    fn is_running(app: &App<MockRuntime>, terminal_id: &str) -> bool {
        running_terminals(app.state())
            .expect("running terminals")
            .iter()
            .any(|terminal| terminal.id == terminal_id)
    }

    fn stop(app: &App<MockRuntime>, terminal_id: &str) {
        kill_terminal_inner(&app.state::<Mutex<PtyManager>>(), terminal_id);
    }

    fn id_number(id: &str, prefix: &str) -> u64 {
        id.strip_prefix(prefix)
            .and_then(|number| number.parse().ok())
            .expect("numbered id")
    }

    fn high_id_snapshot() -> String {
        serde_json::json!({
            "version": 2,
            "workspaces": [{
                "id": format!("ws-{IMPORTED_ID_NUMBER}"),
                "name": "imported",
                "cwd": "/tmp",
                "terminals": [{"id": format!("t-{IMPORTED_ID_NUMBER}"), "command": "claude"}],
            }],
            "groups": [{
                "id": format!("group-{IMPORTED_ID_NUMBER}"),
                "name": "imported",
                "projectIds": [format!("ws-{IMPORTED_ID_NUMBER}")],
            }],
        })
        .to_string()
    }

    #[test]
    fn given_a_group_with_a_running_terminal_when_suspending_it_then_the_terminal_stops_and_the_change_is_announced(
    ) {
        let app = app_with_store(None);
        let workspace_id = create_workspace(&app, "grouped");
        let group_id = {
            let state = app.state::<Mutex<WorkspaceStore>>();
            let mut store = state.lock_or_recover();
            let group = store.create_group("group".to_string());
            store
                .set_workspace_group(&workspace_id, Some(group.id.clone()))
                .expect("assign group");
            group.id
        };
        let terminal_id = spawn_sleeper(&app, &workspace_id);
        let changes = count_changes(&app);

        suspend_and_stop(app.handle(), &group_id).expect("suspend group");

        assert!(!is_running(&app, &terminal_id));
        assert_eq!(changes.load(Ordering::SeqCst), 1);
        let state = app.state::<Mutex<WorkspaceStore>>();
        let store = state.lock_or_recover();
        let terminal = store
            .workspace(&workspace_id)
            .expect("workspace")
            .terminals
            .iter()
            .find(|terminal| terminal.id == terminal_id)
            .expect("terminal metadata");
        assert!(terminal.suspended);
    }

    #[test]
    fn given_an_unknown_group_when_suspending_it_then_it_fails_without_stopping_or_announcing_anything(
    ) {
        let app = app_with_store(None);
        let workspace_id = create_workspace(&app, "ungrouped");
        let terminal_id = spawn_sleeper(&app, &workspace_id);
        let changes = count_changes(&app);

        let result = suspend_and_stop(app.handle(), "group-missing");

        assert!(result.is_err());
        assert!(is_running(&app, &terminal_id));
        assert_eq!(changes.load(Ordering::SeqCst), 0);
        stop(&app, &terminal_id);
    }

    #[test]
    fn given_a_workspace_with_a_running_terminal_when_closing_it_then_it_is_removed_its_terminal_stops_and_the_change_is_announced(
    ) {
        let app = app_with_store(None);
        let workspace_id = create_workspace(&app, "closing");
        let terminal_id = spawn_sleeper(&app, &workspace_id);
        let changes = count_changes(&app);

        close_and_stop(app.handle(), &workspace_id);

        assert!(!is_running(&app, &terminal_id));
        assert_eq!(changes.load(Ordering::SeqCst), 1);
        let state = app.state::<Mutex<WorkspaceStore>>();
        let store = state.lock_or_recover();
        assert!(store.workspace(&workspace_id).is_err());
    }

    #[test]
    fn given_an_unknown_workspace_when_closing_it_then_other_terminals_keep_running_and_the_change_is_announced(
    ) {
        let app = app_with_store(None);
        let workspace_id = create_workspace(&app, "kept");
        let terminal_id = spawn_sleeper(&app, &workspace_id);
        let changes = count_changes(&app);

        close_and_stop(app.handle(), "ws-missing");

        assert!(is_running(&app, &terminal_id));
        assert_eq!(changes.load(Ordering::SeqCst), 1);
        stop(&app, &terminal_id);
    }

    #[test]
    fn given_a_snapshot_with_high_ids_when_importing_it_then_running_terminals_stop_and_new_ids_follow_the_imported_ones(
    ) {
        let directory = test_directory("import");
        let app = app_with_store(Some(directory.join("workspaces.json")));
        let workspace_id = create_workspace(&app, "current");
        let terminal_id = spawn_sleeper(&app, &workspace_id);
        app.state::<Mutex<WorkspaceStore>>()
            .lock_or_recover()
            .save_now();
        let source = directory.join("snapshot.json");
        std::fs::write(&source, high_id_snapshot()).expect("write snapshot");
        let changes = count_changes(&app);

        let transfer = import_snapshot(app.handle(), &source.to_string_lossy()).expect("import");

        assert!(!is_running(&app, &terminal_id));
        assert_eq!(changes.load(Ordering::SeqCst), 1);
        assert_eq!(transfer.workspace_count, 1);
        assert_eq!(transfer.group_count, 1);
        assert_eq!(transfer.suspended_terminal_count, 1);
        assert!(transfer
            .backup_path
            .is_some_and(|backup| Path::new(&backup).exists()));
        let next_workspace_id = {
            let state = app.state::<Mutex<WorkspaceStore>>();
            let mut store = state.lock_or_recover();
            assert_eq!(store.workspaces.len(), 1);
            assert!(store.workspaces[0].terminals[0].suspended);
            let next_group = store.create_group("next".to_string());
            assert!(id_number(&next_group.id, "group-") > IMPORTED_ID_NUMBER);
            store.save_path = None;
            store.create("next".to_string(), String::new()).id
        };
        assert!(id_number(&next_workspace_id, "ws-") > IMPORTED_ID_NUMBER);
        let next_terminal_id = spawn_sleeper(&app, &next_workspace_id);
        assert!(id_number(&next_terminal_id, "t-") > IMPORTED_ID_NUMBER);
        stop(&app, &next_terminal_id);
        let _ = std::fs::remove_dir_all(&directory);
    }
}
