use serde::Deserialize;
use std::sync::Mutex;
use tauri::State;

use crate::sync::LockExt;
use crate::workspace::WorkspaceStore;
use crate::worktree::{self, review, WorktreeInfo, WorktreeStatus};

fn recorded(
    store: &Mutex<WorkspaceStore>,
    workspace_id: &str,
    terminal_id: &str,
) -> Result<WorktreeInfo, String> {
    let store = store.lock_or_recover();
    store
        .workspace(workspace_id)?
        .terminals
        .iter()
        .find(|terminal| terminal.id == terminal_id)
        .and_then(|terminal| terminal.worktree.clone())
        .ok_or_else(|| format!("terminal {} has no worktree", terminal_id))
}

#[tauri::command(async)]
pub fn worktree_status(
    store: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    terminal_id: String,
) -> Result<Option<WorktreeStatus>, String> {
    match recorded(&store, &workspace_id, &terminal_id) {
        Ok(info) => worktree::status(&info).map(Some),
        Err(error) => {
            eprintln!("no worktree status for terminal {}: {}", terminal_id, error);
            Ok(None)
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRemoveRequest {
    pub workspace_id: String,
    pub terminal_id: String,
    pub should_delete_branch: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCommitRequest {
    pub workspace_id: String,
    pub terminal_id: String,
    pub message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreePullRequestRequest {
    pub workspace_id: String,
    pub terminal_id: String,
    pub title: String,
    pub body: String,
}

#[tauri::command(async)]
pub fn worktree_remove(
    store: State<'_, Mutex<WorkspaceStore>>,
    request: WorktreeRemoveRequest,
) -> Result<(), String> {
    let info = recorded(&store, &request.workspace_id, &request.terminal_id)?;
    worktree::remove(&info, request.should_delete_branch)
}

#[tauri::command(async)]
pub fn worktree_diff(
    store: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    terminal_id: String,
) -> Result<review::WorktreeDiff, String> {
    review::diff(&recorded(&store, &workspace_id, &terminal_id)?)
}

#[tauri::command(async)]
pub fn worktree_commit(
    store: State<'_, Mutex<WorkspaceStore>>,
    request: WorktreeCommitRequest,
) -> Result<WorktreeStatus, String> {
    let info = recorded(&store, &request.workspace_id, &request.terminal_id)?;
    review::commit(&info, &request.message)
}

#[tauri::command(async)]
pub fn worktree_merge(
    store: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    terminal_id: String,
) -> Result<WorktreeStatus, String> {
    review::merge(&recorded(&store, &workspace_id, &terminal_id)?)
}

#[tauri::command(async)]
pub fn worktree_open_pr(
    store: State<'_, Mutex<WorkspaceStore>>,
    request: WorktreePullRequestRequest,
) -> Result<String, String> {
    let info = recorded(&store, &request.workspace_id, &request.terminal_id)?;
    review::open_pull_request(&info, &request.title, &request.body)
}
