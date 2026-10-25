//! Tauri commands for workspaces, layout and groups.

use super::*;
use crate::sync::LockExt;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime, State};

fn update_and_notify<R: Runtime, T>(
    app: &AppHandle<R>,
    store: &Mutex<WorkspaceStore>,
    change: impl FnOnce(&mut WorkspaceStore) -> Result<T, String>,
) -> Result<T, String> {
    let result = change(&mut store.lock_or_recover());
    if result.is_ok() {
        emit_workspaces_changed(app);
    }
    result
}

#[tauri::command(async)]
pub fn create_workspace(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    name: String,
    cwd: String,
) -> Result<Workspace, String> {
    update_and_notify(&app, &store, |store| Ok(store.create(name, cwd)))
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
    update_and_notify(&app, &store, |store| {
        store.set_workspace_group(&workspace_id, group_id)
    })
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
    update_and_notify(&app, &store, |store| {
        store.set_terminal_placement(&workspace_id, &terminal_id, pane_id, tab_id)
    })
}

#[tauri::command(async)]
pub fn set_active_pane(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    pane_id: Option<String>,
) -> Result<(), String> {
    update_and_notify(&app, &store, |store| {
        store.set_active_pane(&workspace_id, pane_id)
    })
}

#[tauri::command(async)]
pub fn reorder_workspace_containers(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    order: Vec<String>,
) -> Result<(), String> {
    update_and_notify(&app, &store, |store| {
        store.reorder_containers(&workspace_id, &order)
    })
}

#[tauri::command(async)]
pub fn reorder_workspace_panes(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    container_id: String,
    order: Vec<String>,
) -> Result<(), String> {
    update_and_notify(&app, &store, |store| {
        store.reorder_panes(&workspace_id, &container_id, &order)
    })
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
    update_and_notify(&app, &store, |store| {
        store.move_pane(&workspace_id, &pane_id, &to_container_id, index)
    })
}

#[tauri::command(async)]
pub fn set_workspace_container_state(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    container_id: String,
    patch: WorkspaceContainerPatch,
) -> Result<(), String> {
    update_and_notify(&app, &store, |store| {
        store.set_container_state(&workspace_id, &container_id, patch)
    })
}

#[tauri::command(async)]
pub fn set_workspace_layout(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    layout: WorkspaceLayout,
) -> Result<(), String> {
    update_and_notify(&app, &store, |store| {
        store.set_layout(&workspace_id, layout)
    })
}

#[tauri::command(async)]
pub fn set_workspace_collapsed(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    collapsed: bool,
) -> Result<(), String> {
    update_and_notify(&app, &store, |store| {
        store.set_collapsed(&workspace_id, collapsed)
    })
}

#[tauri::command(async)]
pub fn create_group(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    name: String,
) -> Result<Group, String> {
    update_and_notify(&app, &store, |store| Ok(store.create_group(name)))
}

#[tauri::command(async)]
pub fn rename_group(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    id: String,
    name: String,
) -> Result<(), String> {
    update_and_notify(&app, &store, |store| store.rename_group(&id, name))
}

#[tauri::command(async)]
pub fn remove_group(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    id: String,
) -> Result<(), String> {
    update_and_notify(&app, &store, |store| store.remove_group(&id))
}

#[tauri::command(async)]
pub fn resume_group(app: AppHandle, id: String) -> Result<(), String> {
    let store = app.state::<Mutex<WorkspaceStore>>();
    update_and_notify(&app, &store, |store| store.resume_group(&id))
}

#[tauri::command(async)]
pub fn rename_workspace(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    id: String,
    name: String,
) -> Result<(), String> {
    update_and_notify(&app, &store, |store| store.rename(&id, name))
}

#[tauri::command(async)]
pub fn reorder_workspaces(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    order: Vec<String>,
) -> Result<(), String> {
    update_and_notify(&app, &store, |store| {
        store.reorder_workspaces(&order);
        Ok(())
    })
}

#[tauri::command(async)]
pub fn set_terminal_width(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    ws_id: String,
    terminal_id: String,
    width: f64,
) -> Result<(), String> {
    update_and_notify(&app, &store, |store| {
        store.set_width(&ws_id, &terminal_id, width)
    })
}
