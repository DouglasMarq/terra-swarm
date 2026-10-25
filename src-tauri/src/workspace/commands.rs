use super::*;
use crate::sync::LockExt;
use serde::Deserialize;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime, State};

#[derive(Deserialize)]
pub struct NewWorkspaceRequest {
    pub name: String,
    pub cwd: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGroupRequest {
    pub workspace_id: String,
    pub group_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalPlacementRequest {
    pub workspace_id: String,
    pub terminal_id: String,
    pub pane_id: String,
    pub tab_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivePaneRequest {
    pub workspace_id: String,
    pub pane_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerOrderRequest {
    pub workspace_id: String,
    pub order: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneOrderRequest {
    pub workspace_id: String,
    pub container_id: String,
    pub order: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneMoveRequest {
    pub workspace_id: String,
    pub pane_id: String,
    pub to_container_id: String,
    pub index: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerStateRequest {
    pub workspace_id: String,
    pub container_id: String,
    pub patch: WorkspaceContainerPatch,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceLayoutRequest {
    pub workspace_id: String,
    pub layout: WorkspaceLayout,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCollapsedRequest {
    pub workspace_id: String,
    pub is_collapsed: bool,
}

#[derive(Deserialize)]
pub struct RenameRequest {
    pub id: String,
    pub name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalWidthRequest {
    pub ws_id: String,
    pub terminal_id: String,
    pub width: f64,
}

fn update_and_notify<R: Runtime, T>(
    app: &AppHandle<R>,
    store: &Mutex<WorkspaceStore>,
    change: impl FnOnce(&mut WorkspaceStore) -> Result<T, String>,
) -> Result<T, String> {
    let result = change_and_save(store, change);
    if result.is_ok() {
        emit_workspaces_changed(app);
    }
    result
}

#[tauri::command(async)]
pub fn create_workspace(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    request: NewWorkspaceRequest,
) -> Result<Workspace, String> {
    update_and_notify(&app, &store, |store| {
        Ok(store.create(request.name, request.cwd))
    })
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
    request: WorkspaceGroupRequest,
) -> Result<(), String> {
    update_and_notify(&app, &store, |store| {
        store.set_workspace_group(&request.workspace_id, request.group_id)
    })
}

#[tauri::command(async)]
pub fn set_terminal_placement(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    request: TerminalPlacementRequest,
) -> Result<(), String> {
    update_and_notify(&app, &store, |store| {
        let placement = TerminalPlacement {
            terminal_id: request.terminal_id,
            pane_id: request.pane_id,
            tab_id: request.tab_id,
        };
        store.set_terminal_placement(&request.workspace_id, placement)
    })
}

#[tauri::command(async)]
pub fn set_active_pane(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    request: ActivePaneRequest,
) -> Result<(), String> {
    update_and_notify(&app, &store, |store| {
        store.set_active_pane(&request.workspace_id, request.pane_id)
    })
}

#[tauri::command(async)]
pub fn reorder_workspace_containers(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    request: ContainerOrderRequest,
) -> Result<(), String> {
    update_and_notify(&app, &store, |store| {
        store.reorder_containers(&request.workspace_id, &request.order)
    })
}

#[tauri::command(async)]
pub fn reorder_workspace_panes(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    request: PaneOrderRequest,
) -> Result<(), String> {
    update_and_notify(&app, &store, |store| {
        let reorder = PaneReorder {
            container_id: &request.container_id,
            order: &request.order,
        };
        store.reorder_panes(&request.workspace_id, reorder)
    })
}

#[tauri::command(async)]
pub fn move_workspace_pane(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    request: PaneMoveRequest,
) -> Result<(), String> {
    update_and_notify(&app, &store, |store| {
        let pane_move = PaneMove {
            pane_id: request.pane_id,
            to_container_id: request.to_container_id,
            index: request.index,
        };
        store.move_pane(&request.workspace_id, pane_move)
    })
}

#[tauri::command(async)]
pub fn set_workspace_container_state(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    request: ContainerStateRequest,
) -> Result<(), String> {
    update_and_notify(&app, &store, |store| {
        let change = ContainerStateChange {
            container_id: &request.container_id,
            patch: request.patch,
        };
        store.set_container_state(&request.workspace_id, change)
    })
}

#[tauri::command(async)]
pub fn set_workspace_layout(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    request: WorkspaceLayoutRequest,
) -> Result<(), String> {
    update_and_notify(&app, &store, |store| {
        store.set_layout(&request.workspace_id, request.layout)
    })
}

#[tauri::command(async)]
pub fn set_workspace_collapsed(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    request: WorkspaceCollapsedRequest,
) -> Result<(), String> {
    update_and_notify(&app, &store, |store| {
        store.set_collapsed(&request.workspace_id, request.is_collapsed)
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
    request: RenameRequest,
) -> Result<(), String> {
    update_and_notify(&app, &store, |store| {
        store.rename_group(&request.id, request.name)
    })
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
    request: RenameRequest,
) -> Result<(), String> {
    update_and_notify(&app, &store, |store| {
        store.rename(&request.id, request.name)
    })
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
    request: TerminalWidthRequest,
) -> Result<(), String> {
    update_and_notify(&app, &store, |store| {
        let terminal_width = TerminalWidth {
            terminal_id: &request.terminal_id,
            width: request.width,
        };
        store.set_width(&request.ws_id, terminal_width)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tauri::test::{mock_app, MockRuntime};
    use tauri::{App, Listener};

    fn app_with_store() -> App<MockRuntime> {
        let app = mock_app();
        assert!(app.manage(Mutex::new(WorkspaceStore::default())));
        app
    }

    fn count_changes(app: &App<MockRuntime>) -> Arc<AtomicUsize> {
        let changes = Arc::new(AtomicUsize::new(0));
        let sink = Arc::clone(&changes);
        app.listen_any("workspaces-changed", move |_| {
            sink.fetch_add(1, Ordering::SeqCst);
        });
        changes
    }

    #[test]
    fn given_a_change_that_succeeds_when_updating_then_it_is_kept_and_announced_once() {
        let app = app_with_store();
        let changes = count_changes(&app);
        let state = app.state::<Mutex<WorkspaceStore>>();

        let created = update_and_notify(app.handle(), &state, |store| {
            Ok(store.create("announced".to_string(), String::new()))
        })
        .expect("create workspace");

        assert_eq!(changes.load(Ordering::SeqCst), 1);
        assert!(state.lock_or_recover().workspace(&created.id).is_ok());
    }

    #[test]
    fn given_a_camel_case_pane_move_when_parsing_the_request_then_every_field_is_read() {
        let request: PaneMoveRequest = serde_json::from_value(serde_json::json!({
            "workspaceId": "ws-1",
            "paneId": "pane-1",
            "toContainerId": "container-2",
            "index": 0,
        }))
        .unwrap();

        assert_eq!(request.workspace_id, "ws-1");
        assert_eq!(request.pane_id, "pane-1");
        assert_eq!(request.to_container_id, "container-2");
        assert_eq!(request.index, Some(0));
    }

    #[test]
    fn given_a_change_that_fails_when_updating_then_nothing_is_announced() {
        let app = app_with_store();
        let changes = count_changes(&app);
        let state = app.state::<Mutex<WorkspaceStore>>();

        let result = update_and_notify(app.handle(), &state, |store| {
            store.rename("ws-missing", "renamed".to_string())
        });

        assert!(result.is_err());
        assert_eq!(changes.load(Ordering::SeqCst), 0);
    }
}
