//! Projects (workspaces), their terminals, layout and groups.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter};

mod commands;
mod files;
mod git;
mod groups;
mod layout;
mod normalize;
mod persistence;
mod snapshot;
mod store;
#[cfg(test)]
mod tests;

pub use commands::*;
pub use files::list_workspace_files;
pub(crate) use files::*;
pub(crate) use git::*;
pub use git::{git_branch, git_status};
pub(crate) use persistence::*;
pub(crate) use snapshot::*;
pub use snapshot::{export_workspace_snapshot, import_workspace_snapshot, store_saved_at};

static NEXT_WS_ID: AtomicU64 = AtomicU64::new(1);

static NEXT_GROUP_ID: AtomicU64 = AtomicU64::new(1);

const MIN_TERMINAL_WIDTH: f64 = 15.0;

const MAX_TERMINAL_WIDTH: f64 = 100.0;

/// Broadcast durable workspace metadata changes to every Tauri window. The
/// frontend already coalesces/refreshes this event; keeping emission at the
/// command boundary also covers secondary windows that did not initiate the
/// mutation.
fn emit_workspaces_changed(app: &AppHandle) {
    let _ = app.emit("workspaces-changed", ());
}

pub fn bump_next_id(id: &str) {
    if let Some(n) = id.strip_prefix("ws-").and_then(|s| s.parse::<u64>().ok()) {
        NEXT_WS_ID.fetch_max(n.saturating_add(1), Ordering::SeqCst);
    }
}

pub fn bump_next_group_id(id: &str) {
    if let Some(n) = id
        .strip_prefix("group-")
        .and_then(|s| s.parse::<u64>().ok())
    {
        NEXT_GROUP_ID.fetch_max(n.saturating_add(1), Ordering::SeqCst);
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalMeta {
    pub id: String,
    pub command: String,
    #[serde(default)]
    pub width: Option<f64>,
    /// Optional v2 metadata. Existing terminals keep working when these
    /// fields are absent in a v1/legacy file.
    #[serde(default, alias = "pane_id")]
    pub pane_id: Option<String>,
    #[serde(default, alias = "tab_id")]
    pub tab_id: Option<String>,
    #[serde(default, alias = "group_id")]
    pub group_id: Option<String>,
    #[serde(default)]
    pub suspended: bool,
    /// The git worktree the agent is isolated in, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<crate::worktree::WorktreeInfo>,
    /// The agent's team role, if it was started with one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<crate::mcp::roles::Role>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub cwd: String,
    #[serde(default)]
    pub terminals: Vec<TerminalMeta>,
    /// A workspace is the compatibility name for the conceptual Project.
    #[serde(default, alias = "group_id")]
    pub group_id: Option<String>,
    #[serde(default)]
    pub panes: Vec<Pane>,
    #[serde(default)]
    pub containers: Vec<WorkspaceContainer>,
    #[serde(default, alias = "active_pane_id")]
    pub active_pane_id: Option<String>,
    #[serde(default, alias = "active_container_id")]
    pub active_container_id: Option<String>,
    #[serde(default)]
    pub collapsed: bool,
    #[serde(default)]
    pub archived: bool,
    #[serde(default, alias = "created_at")]
    pub created_at: Option<u64>,
    #[serde(default, alias = "layout_mode")]
    pub layout_mode: Option<String>,
    /// Durable workspace-level layout details. `layout_mode` remains as a
    /// compatibility scalar for older clients and stores.
    #[serde(default)]
    pub layout: Option<WorkspaceLayout>,
}

/// Compatibility alias used by the domain layer while the public IPC name
/// remains `Workspace` for existing clients.
#[allow(dead_code)]
pub type Project = Workspace;

/// A durable group of projects. Suspending a group only changes this
/// metadata; process lifecycle is intentionally handled by PTY commands.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default, alias = "icon_url")]
    pub icon_url: Option<String>,
    #[serde(default)]
    pub collapsed: bool,
    #[serde(default, alias = "project_ids")]
    pub project_ids: Vec<String>,
    #[serde(default, alias = "parent_group_id")]
    pub parent_group_id: Option<String>,
    #[serde(default)]
    pub layout_mode: Option<String>,
    #[serde(default)]
    pub suspended: bool,
    #[serde(default)]
    pub archived: bool,
    #[serde(default, alias = "created_at")]
    pub created_at: Option<u64>,
}

/// A visual pane/container metadata record. PTY ownership remains with the
/// terminal manager, so removing this record cannot accidentally kill a
/// running process.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pane {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub tabs: Vec<TerminalTab>,
    #[serde(default, alias = "active_tab_id")]
    pub active_tab_id: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub disabled: bool,
    #[serde(default)]
    pub collapsed: bool,
    #[serde(default)]
    pub width: Option<f64>,
    #[serde(default)]
    pub height: Option<f64>,
    #[serde(default, alias = "container_id")]
    pub container_id: Option<String>,
    #[serde(default)]
    pub layout: Option<WorkspaceLayout>,
}

/// Metadata for one sub-tab/session inside a pane. The `type` JSON spelling
/// matches the conceptual Project/Group/Pane/TerminalTab contract, while the
/// Rust field is named `kind` because `type` is reserved.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalTab {
    #[serde(default)]
    pub id: String,
    #[serde(rename = "type", alias = "kind", default = "default_tab_kind")]
    pub kind: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default, alias = "pty_id")]
    pub pty_id: Option<String>,
    #[serde(default, alias = "session_id")]
    pub session_id: Option<String>,
    #[serde(default, alias = "last_used_at")]
    pub last_used_at: Option<u64>,
    #[serde(default, alias = "completion_unread")]
    pub completion_unread: bool,
    #[serde(default, alias = "extra_args")]
    pub extra_args: Vec<String>,
    #[serde(default)]
    pub suspended: bool,
}

fn default_tab_kind() -> String {
    "shell".to_string()
}

#[allow(dead_code)]
pub type SubTab = TerminalTab;

#[allow(dead_code)]
pub type PaneMeta = Pane;

#[allow(dead_code)]
pub type SubtabMeta = TerminalTab;

/// Persisted project container metadata, based on the reference model's
/// projectId/paneIds relationship. It is safe to close/remove visually while
/// PTYs continue to run until an explicit kill command is issued.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContainer {
    /// Stable visual identity. Legacy records omitted this field; load-time
    /// validation derives a deterministic id from the workspace and index.
    #[serde(default)]
    pub id: String,
    #[serde(default, alias = "project_id")]
    pub project_id: String,
    #[serde(default, alias = "pane_ids")]
    pub pane_ids: Vec<String>,
    #[serde(default, alias = "last_used_at")]
    pub last_used_at: Option<u64>,
    #[serde(default)]
    pub size: f64,
    #[serde(default = "default_layout_mode", alias = "internal_layout")]
    pub internal_layout: String,
    #[serde(default)]
    pub collapsed: bool,
    #[serde(default, alias = "active_pane_id")]
    pub active_pane_id: Option<String>,
    #[serde(default = "default_visible")]
    pub visible: bool,
    #[serde(default)]
    pub closed: bool,
    #[serde(default)]
    pub fullscreen: bool,
    #[serde(default)]
    pub layout: Option<WorkspaceLayout>,
}

fn default_layout_mode() -> String {
    "auto".to_string()
}

fn default_visible() -> bool {
    true
}

fn normalize_layout_state(layout: &mut WorkspaceLayout) {
    let normalized_mode = layout.mode.trim().to_ascii_lowercase();
    layout.mode = match normalized_mode.as_str() {
        "auto" | "grid" | "horizontal" | "vertical" | "stack" | "spotlight" => normalized_mode,
        _ => default_layout_mode(),
    };
    layout.columns = layout.columns.map(|value| value.clamp(1, 128));
    layout.rows = layout.rows.map(|value| value.clamp(1, 128));
    let mut seen = std::collections::HashSet::new();
    layout.item_ids.retain_mut(|id| {
        let trimmed = id.trim();
        if trimmed.is_empty() || !seen.insert(trimmed.to_string()) {
            return false;
        }
        if trimmed.len() != id.len() {
            *id = trimmed.to_string();
        }
        true
    });
    layout
        .sizes
        .retain(|key, value| !key.trim().is_empty() && value.is_finite() && *value > 0.0);
}

/// Serializable layout state shared by workspace, container and pane
/// persistence. The frontend can add metadata without requiring a Rust
/// release; unknown values are retained by serde_json.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceLayout {
    #[serde(default = "default_layout_mode")]
    pub mode: String,
    #[serde(default)]
    pub columns: Option<u32>,
    #[serde(default)]
    pub rows: Option<u32>,
    #[serde(default, alias = "item_ids")]
    pub item_ids: Vec<String>,
    #[serde(default)]
    pub sizes: HashMap<String, f64>,
    #[serde(default)]
    pub metadata: HashMap<String, Value>,
}

impl Default for WorkspaceLayout {
    fn default() -> Self {
        Self {
            mode: default_layout_mode(),
            columns: None,
            rows: None,
            item_ids: Vec::new(),
            sizes: HashMap::new(),
            metadata: HashMap::new(),
        }
    }
}

/// Partial visual state update for a container. `None` leaves a field as-is;
/// `clear_active_pane` is explicit so callers can clear an existing selection
/// without conflating that operation with an omitted patch field.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContainerPatch {
    pub visible: Option<bool>,
    pub closed: Option<bool>,
    pub collapsed: Option<bool>,
    pub fullscreen: Option<bool>,
    pub active_pane_id: Option<String>,
    #[serde(default)]
    pub clear_active_pane: bool,
    pub internal_layout: Option<String>,
    pub size: Option<f64>,
    pub layout: Option<WorkspaceLayout>,
}

#[derive(Default)]
pub struct WorkspaceStore {
    pub workspaces: Vec<Workspace>,
    pub groups: Vec<Group>,
    pub save_path: Option<PathBuf>,
}

fn home_dir() -> String {
    #[cfg(windows)]
    {
        if let Ok(p) = std::env::var("USERPROFILE") {
            if !p.trim().is_empty() {
                return p;
            }
        }
        if let (Ok(drive), Ok(path)) = (std::env::var("HOMEDRIVE"), std::env::var("HOMEPATH")) {
            return format!("{}{}", drive, path);
        }
        "C:\\".to_string()
    }
    #[cfg(not(windows))]
    {
        std::env::var("HOME").unwrap_or_else(|_| "/".to_string())
    }
}

fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
