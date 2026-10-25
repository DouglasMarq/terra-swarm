use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Runtime};

use crate::collections::{add_unique, reorder_by_ids};
use crate::text::trim_in_place;

mod commands;
mod editor;
mod files;
mod git;
mod groups;
mod layout;
mod normalize;
mod persisted;
mod persistence;
mod snapshot;
mod store;
#[cfg(test)]
mod tests;

pub use commands::*;
pub use editor::*;
pub use files::list_workspace_files;
pub(crate) use files::*;
pub(crate) use git::*;
pub use git::{git_branch, git_status};
pub(crate) use persisted::change_and_save;
pub(crate) use persistence::*;
pub(crate) use snapshot::*;
pub use snapshot::{export_workspace_snapshot, store_saved_at};

static NEXT_WS_ID: AtomicU64 = AtomicU64::new(1);

static NEXT_GROUP_ID: AtomicU64 = AtomicU64::new(1);

const MIN_TERMINAL_WIDTH: f64 = 15.0;

const MAX_TERMINAL_WIDTH: f64 = 100.0;

const MIN_CONTAINER_SIZE_PERCENT: f64 = 0.0;

const MAX_CONTAINER_SIZE_PERCENT: f64 = 100.0;

const MIN_LAYOUT_TRACKS: u32 = 1;

const MAX_LAYOUT_TRACKS: u32 = 128;

pub(crate) fn emit_workspaces_changed<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit("workspaces-changed", ());
}

pub fn bump_next_id(id: &str) {
    if let Some(number) = id
        .strip_prefix("ws-")
        .and_then(|digits| digits.parse::<u64>().ok())
    {
        NEXT_WS_ID.fetch_max(number.saturating_add(1), Ordering::SeqCst);
    }
}

pub fn bump_next_group_id(id: &str) {
    if let Some(number) = id
        .strip_prefix("group-")
        .and_then(|digits| digits.parse::<u64>().ok())
    {
        NEXT_GROUP_ID.fetch_max(number.saturating_add(1), Ordering::SeqCst);
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalMeta {
    pub id: String,
    pub command: String,
    #[serde(default)]
    pub width: Option<f64>,
    #[serde(default, alias = "pane_id")]
    pub pane_id: Option<String>,
    #[serde(default, alias = "tab_id")]
    pub tab_id: Option<String>,
    #[serde(default, alias = "group_id")]
    pub group_id: Option<String>,
    #[serde(default)]
    pub suspended: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<crate::worktree::WorktreeInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<crate::roles::Role>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub cwd: String,
    #[serde(default)]
    pub terminals: Vec<TerminalMeta>,
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
    #[serde(default)]
    pub layout: Option<WorkspaceLayout>,
}

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

impl Pane {
    pub(crate) fn repair_active_tab(&mut self) {
        if self
            .active_tab_id
            .as_deref()
            .is_some_and(|id| !self.tabs.iter().any(|tab| tab.id == id))
        {
            self.active_tab_id = self.tabs.first().map(|tab| tab.id.clone());
        }
    }
}

fn default_tab_kind() -> String {
    "shell".to_string()
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContainer {
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
    #[serde(default = "is_visible_by_default")]
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

fn is_visible_by_default() -> bool {
    true
}

fn normalize_layout_state(layout: &mut WorkspaceLayout) {
    let normalized_mode = layout.mode.trim().to_ascii_lowercase();
    layout.mode = match normalized_mode.as_str() {
        "auto" | "grid" | "horizontal" | "vertical" | "stack" | "spotlight" => normalized_mode,
        _ => default_layout_mode(),
    };
    layout.columns = layout
        .columns
        .map(|value| value.clamp(MIN_LAYOUT_TRACKS, MAX_LAYOUT_TRACKS));
    layout.rows = layout
        .rows
        .map(|value| value.clamp(MIN_LAYOUT_TRACKS, MAX_LAYOUT_TRACKS));
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

pub struct TerminalPlacement {
    pub terminal_id: String,
    pub pane_id: String,
    pub tab_id: String,
}

pub struct PaneMove {
    pub pane_id: String,
    pub to_container_id: String,
    pub index: Option<usize>,
}

#[derive(Default)]
pub struct WorkspaceStore {
    pub workspaces: Vec<Workspace>,
    pub groups: Vec<Group>,
    pub save_path: Option<PathBuf>,
}

#[cfg(windows)]
const FALLBACK_HOME_DIR: &str = "C:\\";

#[cfg(not(windows))]
const FALLBACK_HOME_DIR: &str = "/";

fn home_dir() -> String {
    crate::paths::home_dir()
        .map(|home| home.to_string_lossy().into_owned())
        .unwrap_or_else(|| FALLBACK_HOME_DIR.to_string())
}
