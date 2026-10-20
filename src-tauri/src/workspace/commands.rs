//! Tauri commands for workspaces, layout and groups.

use super::*;
use crate::sync::LockExt;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

#[tauri::command(async)]
pub fn create_workspace(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    name: String,
    cwd: String,
) -> Result<Workspace, String> {
    let mut store = store.lock_or_recover();
    let workspace = store.create(name, cwd);
    drop(store);
    emit_workspaces_changed(&app);
    Ok(workspace)
}

#[tauri::command(async)]
pub fn list_workspaces(store: State<'_, Mutex<WorkspaceStore>>) -> Result<Vec<Workspace>, String> {
    let store = store.lock_or_recover();
    Ok(store.workspaces.clone())
}

#[tauri::command(async)]
pub fn list_groups(store: State<'_, Mutex<WorkspaceStore>>) -> Result<Vec<Group>, String> {
    let store = store.lock_or_recover();
    Ok(store.list_groups())
}

#[tauri::command(async)]
pub fn set_workspace_group(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    group_id: Option<String>,
) -> Result<(), String> {
    let mut store = store.lock_or_recover();
    let result = store.set_workspace_group(&workspace_id, group_id);
    drop(store);
    if result.is_ok() {
        emit_workspaces_changed(&app);
    }
    result
}

#[tauri::command(async)]
pub fn set_terminal_placement(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    terminal_id: String,
    pane_id: String,
    tab_id: String,
) -> Result<(), String> {
    let mut store = store.lock_or_recover();
    let result = store.set_terminal_placement(&workspace_id, &terminal_id, pane_id, tab_id);
    drop(store);
    if result.is_ok() {
        emit_workspaces_changed(&app);
    }
    result
}

#[tauri::command(async)]
pub fn set_active_pane(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    pane_id: Option<String>,
) -> Result<(), String> {
    let mut store = store.lock_or_recover();
    let result = store.set_active_pane(&workspace_id, pane_id);
    drop(store);
    if result.is_ok() {
        emit_workspaces_changed(&app);
    }
    result
}

#[tauri::command(async)]
pub fn reorder_workspace_containers(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    order: Vec<String>,
) -> Result<(), String> {
    let mut store = store.lock_or_recover();
    let result = store.reorder_containers(&workspace_id, &order);
    drop(store);
    if result.is_ok() {
        emit_workspaces_changed(&app);
    }
    result
}

#[tauri::command(async)]
pub fn reorder_workspace_panes(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    container_id: String,
    order: Vec<String>,
) -> Result<(), String> {
    let mut store = store.lock_or_recover();
    let result = store.reorder_panes(&workspace_id, &container_id, &order);
    drop(store);
    if result.is_ok() {
        emit_workspaces_changed(&app);
    }
    result
}

#[tauri::command(async)]
pub fn move_workspace_pane(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    pane_id: String,
    to_container_id: String,
    index: Option<usize>,
) -> Result<(), String> {
    let mut store = store.lock_or_recover();
    let result = store.move_pane(&workspace_id, &pane_id, &to_container_id, index);
    drop(store);
    if result.is_ok() {
        emit_workspaces_changed(&app);
    }
    result
}

#[tauri::command(async)]
pub fn set_workspace_container_state(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    container_id: String,
    patch: WorkspaceContainerPatch,
) -> Result<(), String> {
    let mut store = store.lock_or_recover();
    let result = store.set_container_state(&workspace_id, &container_id, patch);
    drop(store);
    if result.is_ok() {
        emit_workspaces_changed(&app);
    }
    result
}

#[tauri::command(async)]
pub fn set_workspace_layout(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    layout: WorkspaceLayout,
) -> Result<(), String> {
    let mut store = store.lock_or_recover();
    let result = store.set_layout(&workspace_id, layout);
    drop(store);
    if result.is_ok() {
        emit_workspaces_changed(&app);
    }
    result
}

#[tauri::command(async)]
pub fn set_workspace_collapsed(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    collapsed: bool,
) -> Result<(), String> {
    let mut store = store.lock_or_recover();
    let result = store.set_collapsed(&workspace_id, collapsed);
    drop(store);
    if result.is_ok() {
        emit_workspaces_changed(&app);
    }
    result
}

#[tauri::command(async)]
pub fn create_group(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    name: String,
) -> Result<Group, String> {
    let mut store = store.lock_or_recover();
    let group = store.create_group(name);
    drop(store);
    emit_workspaces_changed(&app);
    Ok(group)
}

#[tauri::command(async)]
pub fn rename_group(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    id: String,
    name: String,
) -> Result<(), String> {
    let mut store = store.lock_or_recover();
    let result = store.rename_group(&id, name);
    drop(store);
    if result.is_ok() {
        emit_workspaces_changed(&app);
    }
    result
}

#[tauri::command(async)]
pub fn remove_group(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    id: String,
) -> Result<(), String> {
    let mut store = store.lock_or_recover();
    let result = store.remove_group(&id);
    drop(store);
    if result.is_ok() {
        emit_workspaces_changed(&app);
    }
    result
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
    let manager = app.state::<Mutex<crate::pty::PtyManager>>();
    for terminal_id in terminal_ids {
        crate::pty::kill_terminal_inner(&manager, &terminal_id);
    }
    emit_workspaces_changed(&app);
    Ok(())
}

#[tauri::command(async)]
pub fn resume_group(app: AppHandle, id: String) -> Result<(), String> {
    let store = app.state::<Mutex<WorkspaceStore>>();
    let mut store = store.lock_or_recover();
    let result = store.resume_group(&id);
    drop(store);
    if result.is_ok() {
        emit_workspaces_changed(&app);
    }
    result
}

#[tauri::command(async)]
pub fn rename_workspace(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    id: String,
    name: String,
) -> Result<(), String> {
    let mut store = store.lock_or_recover();
    let result = store.rename(&id, name);
    drop(store);
    if result.is_ok() {
        emit_workspaces_changed(&app);
    }
    result
}

#[tauri::command(async)]
pub fn reorder_workspaces(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    order: Vec<String>,
) -> Result<(), String> {
    let mut store = store.lock_or_recover();
    store.reorder_workspaces(&order);
    drop(store);
    emit_workspaces_changed(&app);
    Ok(())
}

#[tauri::command(async)]
pub fn set_terminal_width(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    ws_id: String,
    terminal_id: String,
    width: f64,
) -> Result<(), String> {
    let mut store = store.lock_or_recover();
    let result = store.set_width(&ws_id, &terminal_id, width);
    drop(store);
    if result.is_ok() {
        emit_workspaces_changed(&app);
    }
    result
}

#[tauri::command(async)]
pub fn close_workspace(app: AppHandle, id: String) -> Result<(), String> {
    let store = app.state::<Mutex<WorkspaceStore>>();
    let terminals = {
        let mut store = store.lock_or_recover();
        store.remove(&id).map(|ws| ws.terminals)
    };
    crate::mcp::purge_workspace(&app, &id);
    if let Some(terminals) = terminals {
        let manager = app.state::<Mutex<crate::pty::PtyManager>>();
        for t in terminals {
            crate::pty::kill_terminal_inner(&manager, &t.id);
        }
    }
    emit_workspaces_changed(&app);
    Ok(())
}
