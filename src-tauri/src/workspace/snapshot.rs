//! Explicit import and export of the whole workspace store.

use super::*;
use crate::sync::LockExt;
use serde::{Deserialize, Serialize};
use std::path::{Component, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use tauri::State;

/// Result returned by the explicit snapshot import/export IPC commands.
/// `path` is the user-selected source (import) or destination (export), while
/// `backup_path` points to the recoverable pre-import store backup when one
/// was created.  PTYs are deliberately not represented by this result: a
/// snapshot only transfers metadata and imported sessions start suspended.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshotTransfer {
    pub version: u32,
    pub path: String,
    pub backup_path: Option<String>,
    pub workspace_count: usize,
    pub group_count: usize,
    pub terminal_count: usize,
    pub suspended_terminal_count: usize,
}

/// Explicit paths originate at the UI's file picker, but the IPC boundary is
/// also callable by untrusted local input. Require an absolute path, reject
/// traversal components and NUL bytes, and refuse existing symlink components
/// so a snapshot cannot escape the selected location through a link.
pub(crate) fn validate_explicit_path(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("snapshot path cannot be empty".to_string());
    }
    if trimmed.contains('\0') {
        return Err("snapshot path contains a NUL byte".to_string());
    }

    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err("snapshot path must be absolute".to_string());
    }
    if path.file_name().is_none() {
        return Err("snapshot path must name a file".to_string());
    }
    for component in path.components() {
        if matches!(component, Component::ParentDir | Component::CurDir) {
            return Err("snapshot path cannot contain traversal components".to_string());
        }
    }

    // Walk only the existing prefix. Once a component does not exist, a
    // later component cannot be an existing symlink under that missing path.
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("snapshot path cannot traverse a symlink".to_string());
            }
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) if current != path => {
                return Err("snapshot path contains a non-directory component".to_string());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => {
                return Err(format!("cannot inspect snapshot path: {}", error));
            }
        }
    }

    if path.is_dir() {
        return Err("snapshot path must be a file, not a directory".to_string());
    }
    Ok(path)
}

/// Parse an explicitly imported snapshot strictly.  Startup loading remains
/// intentionally forgiving and recovers valid entries from a damaged local
/// store; replacing the active store is different, so a malformed entry must
/// fail before any process or file state is changed.
pub(crate) fn parse_import_snapshot(raw: &str) -> Result<WorkspaceStore, String> {
    let decoded = decode_workspace_file(raw)?;
    if decoded.dropped_entries {
        return Err("snapshot contains malformed workspace or group entries".to_string());
    }
    let mut candidate = WorkspaceStore {
        workspaces: decoded.workspaces,
        groups: decoded.groups,
        save_path: None,
    };
    if candidate.validate() {
        return Err("snapshot failed workspace metadata validation".to_string());
    }

    // Terminal ids are the durable identity used by the resume queue and by
    // scrollback filenames.  Duplicates across projects would make the
    // imported state ambiguous even though each project is locally valid.
    let mut terminal_ids = std::collections::HashSet::new();
    for workspace in &candidate.workspaces {
        for terminal in &workspace.terminals {
            if !terminal_ids.insert(terminal.id.as_str()) {
                return Err(format!(
                    "snapshot contains duplicate terminal id {}",
                    terminal.id
                ));
            }
        }
    }
    Ok(candidate)
}

/// Import carries logical terminal identities and layout metadata, but never
/// carries a live process.  Keep ids/placements so resume can recreate the
/// same tabs, while marking every session explicitly suspended for the first
/// frontend refresh.
pub(crate) fn mark_imported_sessions_suspended(store: &mut WorkspaceStore) {
    for workspace in &mut store.workspaces {
        for terminal in &mut workspace.terminals {
            terminal.suspended = true;
        }
        for pane in &mut workspace.panes {
            for tab in &mut pane.tabs {
                tab.suspended = true;
            }
        }
    }
}

pub(crate) fn transfer_counts(store: &WorkspaceStore) -> (usize, usize, usize, usize) {
    let terminal_count = store
        .workspaces
        .iter()
        .map(|workspace| workspace.terminals.len())
        .sum();
    let suspended_terminal_count = store
        .workspaces
        .iter()
        .flat_map(|workspace| workspace.terminals.iter())
        .filter(|terminal| terminal.suspended)
        .count();
    (
        store.workspaces.len(),
        store.groups.len(),
        terminal_count,
        suspended_terminal_count,
    )
}

/// Last time the store file was written, in milliseconds since the Unix
/// epoch. The store is flushed synchronously on exit, so this is when the
/// previous session ended; the startup resume dialog shows it as "X ago".
#[tauri::command(async)]
pub fn store_saved_at(store: State<'_, Mutex<WorkspaceStore>>) -> Result<Option<u64>, String> {
    let store = store.lock_or_recover();
    let Some(path) = &store.save_path else {
        return Ok(None);
    };
    Ok(modified_millis(path))
}

/// Export the current metadata snapshot to an explicit, absolute local path.
/// The destination is written atomically and is never treated as a PTY
/// registry; only the versioned workspace envelope is transferred.
#[tauri::command(async)]
pub fn export_workspace_snapshot(
    store: State<'_, Mutex<WorkspaceStore>>,
    path: String,
) -> Result<WorkspaceSnapshotTransfer, String> {
    let target = validate_explicit_path(&path)?;
    let (json, counts) = {
        let store = store.lock_or_recover();
        (
            store
                .serialized_snapshot()
                .map_err(|error| format!("failed to serialize workspace snapshot: {}", error))?,
            transfer_counts(&store),
        )
    };
    let seq = SAVE_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    write_guarded_result(&target, &json, seq).map_err(|error| {
        format!(
            "failed to export workspace snapshot to {}: {}",
            target.display(),
            error
        )
    })?;
    Ok(WorkspaceSnapshotTransfer {
        version: WORKSPACE_FILE_VERSION,
        path: target.to_string_lossy().into_owned(),
        backup_path: None,
        workspace_count: counts.0,
        group_count: counts.1,
        terminal_count: counts.2,
        suspended_terminal_count: counts.3,
    })
}
