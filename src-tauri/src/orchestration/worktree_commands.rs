use std::sync::Mutex;
use tauri::State;

use crate::sync::LockExt;
use crate::workspace::WorkspaceStore;
use crate::worktree::{self, review, WorktreeInfo, WorktreeStatus};

/// The worktree recorded for a terminal of a workspace.
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

/// Delete an agent's worktree, discarding uncommitted changes; the branch
/// (with its commits) goes too when `delete_branch` is set. Stop the agent
/// first: its shell must not be running inside the folder.
#[tauri::command(async)]
pub fn worktree_remove(
    store: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    terminal_id: String,
    delete_branch: bool,
) -> Result<(), String> {
    let info = recorded(&store, &workspace_id, &terminal_id)?;
    worktree::remove(&info, delete_branch)
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
    workspace_id: String,
    terminal_id: String,
    message: String,
) -> Result<WorktreeStatus, String> {
    review::commit(&recorded(&store, &workspace_id, &terminal_id)?, &message)
}

#[tauri::command(async)]
pub fn worktree_merge(
    store: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    terminal_id: String,
) -> Result<WorktreeStatus, String> {
    review::merge(&recorded(&store, &workspace_id, &terminal_id)?)
}

/// Pushes the agent's branch and opens a pull request; the user asks for
/// this explicitly from the review dialog.
#[tauri::command(async)]
pub fn worktree_open_pr(
    store: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    terminal_id: String,
    title: String,
    body: String,
) -> Result<String, String> {
    review::open_pull_request(
        &recorded(&store, &workspace_id, &terminal_id)?,
        &title,
        &body,
    )
}
