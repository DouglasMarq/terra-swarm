//! The Tauri side of [`McpHost`]: window events and the workspace store.

use std::sync::{Arc, Mutex};

use super::{McpHost, McpHub, WorkspaceInfo};
use crate::sync::LockExt;

/// Called by `close_workspace`: workspaces live in `workspaces.json`, so
/// their MCP data has no foreign key to cascade from.
pub fn purge_workspace<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str) {
    use tauri::Manager;
    if let Some(hub) = app.try_state::<Arc<McpHub>>() {
        hub.purge_workspace(workspace_id);
    }
}

/// Tauri side of [`McpHost`].
pub struct TauriHost<R: tauri::Runtime> {
    pub app: tauri::AppHandle<R>,
}

impl<R: tauri::Runtime> TauriHost<R> {
    fn with_workspace<T>(
        &self,
        workspace_id: &str,
        read: impl FnOnce(&crate::workspace::Workspace) -> T,
    ) -> Option<T> {
        use tauri::Manager;
        let store = self
            .app
            .try_state::<Mutex<crate::workspace::WorkspaceStore>>()?;
        let store = store.lock_or_recover();
        store.get(workspace_id).map(read)
    }
}

impl<R: tauri::Runtime> McpHost for TauriHost<R> {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        use tauri::Emitter;
        let _ = self.app.emit(event, payload);
    }

    fn workspace(&self, workspace_id: &str) -> Option<WorkspaceInfo> {
        self.with_workspace(workspace_id, |workspace| WorkspaceInfo {
            name: workspace.name.clone(),
            cwd: workspace.cwd.clone(),
        })
    }

    fn terminals(&self, workspace_id: &str) -> Vec<String> {
        self.with_workspace(workspace_id, |workspace| {
            workspace
                .terminals
                .iter()
                .map(|terminal| terminal.id.clone())
                .collect()
        })
        .unwrap_or_default()
    }
}
