use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

static NEXT_WS_ID: AtomicU64 = AtomicU64::new(1);

struct SaveRequest {
    path: PathBuf,
    json: String,
    seq: u64,
}

static SAVE_TX: OnceLock<Sender<SaveRequest>> = OnceLock::new();
static SAVE_SEQ: AtomicU64 = AtomicU64::new(0);
static LAST_WRITTEN: OnceLock<Mutex<HashMap<PathBuf, u64>>> = OnceLock::new();
static WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static NEXT_GROUP_ID: AtomicU64 = AtomicU64::new(1);
static ATOMIC_TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Version of the on-disk workspace envelope.  The contents of the envelope
/// are intentionally kept separate from `WorkspaceStore`: the latter also
/// carries runtime-only state such as the save path.
const WORKSPACE_FILE_VERSION: u32 = 2;
const LEGACY_WORKSPACE_FILE_VERSION: u32 = 1;
const MIN_TERMINAL_WIDTH: f64 = 15.0;
const MAX_TERMINAL_WIDTH: f64 = 100.0;
const DEFAULT_FILE_LIST_LIMIT: usize = 200;
const MAX_FILE_LIST_LIMIT: usize = 400;

/// Broadcast durable workspace metadata changes to every Tauri window. The
/// frontend already coalesces/refreshes this event; keeping emission at the
/// command boundary also covers secondary windows that did not initiate the
/// mutation.
fn emit_workspaces_changed(app: &AppHandle) {
    let _ = app.emit("workspaces-changed", ());
}

#[derive(Serialize, Deserialize)]
struct WorkspaceFile {
    version: u32,
    #[serde(default)]
    workspaces: Vec<Workspace>,
    #[serde(default)]
    groups: Vec<Group>,
}

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

/// Metadata-only directory entry used by the lazy Files activity. The
/// command never reads file contents and paths are always workspace-relative.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: Option<u64>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileListing {
    pub path: String,
    pub entries: Vec<WorkspaceFileEntry>,
    pub truncated: bool,
    pub limit: usize,
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitStatus {
    pub branch: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub staged: Vec<String>,
    pub modified: Vec<String>,
    pub untracked: Vec<String>,
    pub conflicted: Vec<String>,
}

struct DecodedWorkspaceFile {
    workspaces: Vec<Workspace>,
    groups: Vec<Group>,
    /// A JSON array is the format used before the versioned envelope existed.
    legacy: bool,
    /// Entries which could not be deserialized are dropped individually so a
    /// single damaged workspace cannot make all the other workspaces vanish.
    dropped_entries: bool,
}

/// Decode both the current envelope and the pre-envelope array format.
///
/// Parsing through `serde_json::Value` here is deliberate.  Deserializing a
/// `Vec<Workspace>` directly would reject the whole file when one entry is
/// malformed, which is needlessly destructive for a local preferences file.
/// Valid entries are recovered and the caller can retain a backup before
/// writing the normalized result.
fn decode_workspace_file(raw: &str) -> Result<DecodedWorkspaceFile, String> {
    let value: Value = serde_json::from_str(raw).map_err(|error| error.to_string())?;

    match value {
        Value::Array(entries) => {
            let (workspaces, dropped_entries) = decode_workspace_entries(entries);
            Ok(DecodedWorkspaceFile {
                workspaces,
                groups: Vec::new(),
                legacy: true,
                dropped_entries,
            })
        }
        Value::Object(mut object) => {
            let version = object
                .remove("version")
                .and_then(|value| value.as_u64())
                .ok_or_else(|| "workspace store is missing a numeric version".to_string())?;
            if version != u64::from(LEGACY_WORKSPACE_FILE_VERSION)
                && version != u64::from(WORKSPACE_FILE_VERSION)
            {
                return Err(format!("unsupported workspace store version: {}", version));
            }

            let entries = match object.remove("workspaces") {
                Some(Value::Array(entries)) => entries,
                // An omitted collection is equivalent to an empty collection;
                // this keeps adding fields to the envelope backwards-friendly.
                None => Vec::new(),
                Some(_) => {
                    return Err("workspace store workspaces must be an array".to_string());
                }
            };
            let (workspaces, dropped_entries) = decode_workspace_entries(entries);
            let (groups, dropped_groups) = match object.remove("groups") {
                Some(Value::Array(entries)) => decode_group_entries(entries),
                // v1 did not have groups. A missing collection is the
                // canonical default for both versions.
                None => (Vec::new(), false),
                Some(_) => {
                    return Err("workspace store groups must be an array".to_string());
                }
            };
            Ok(DecodedWorkspaceFile {
                workspaces,
                groups,
                legacy: version == u64::from(LEGACY_WORKSPACE_FILE_VERSION),
                dropped_entries: dropped_entries || dropped_groups,
            })
        }
        _ => Err("workspace store must be an object or array".to_string()),
    }
}

fn decode_workspace_entries(entries: Vec<Value>) -> (Vec<Workspace>, bool) {
    let mut dropped_entries = false;
    let mut workspaces = Vec::with_capacity(entries.len());
    for (index, value) in entries.into_iter().enumerate() {
        match serde_json::from_value::<Workspace>(value) {
            Ok(workspace) => workspaces.push(workspace),
            Err(error) => {
                dropped_entries = true;
                eprintln!(
                    "skipping malformed workspace entry {} while loading: {}",
                    index, error
                );
            }
        }
    }
    (workspaces, dropped_entries)
}

fn decode_group_entries(entries: Vec<Value>) -> (Vec<Group>, bool) {
    let mut dropped_entries = false;
    let mut groups = Vec::with_capacity(entries.len());
    for (index, value) in entries.into_iter().enumerate() {
        match serde_json::from_value::<Group>(value) {
            Ok(group) => groups.push(group),
            Err(error) => {
                dropped_entries = true;
                eprintln!(
                    "skipping malformed group entry {} while loading: {}",
                    index, error
                );
            }
        }
    }
    (groups, dropped_entries)
}

/// Serialized write that never lets an older snapshot overwrite a newer one:
/// every save gets a monotonic seq, and a request is skipped when a newer
/// save has already landed (e.g. save_now at exit vs a stale debounced write).
fn write_guarded(path: &std::path::Path, json: &str, seq: u64) {
    if let Err(e) = write_guarded_result(path, json, seq) {
        eprintln!("failed to save workspaces: {}", e);
    }
}

/// Synchronous variant used by portability commands.  The regular debounced
/// writer intentionally logs failures because it runs off-thread; explicit
/// import/export must return the failure to the caller instead.
fn write_guarded_result(path: &Path, json: &str, seq: u64) -> std::io::Result<()> {
    let lock = WRITE_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    let last_written = LAST_WRITTEN.get_or_init(|| Mutex::new(HashMap::new()));
    let mut last_written = last_written.lock().unwrap_or_else(|e| e.into_inner());
    if last_written
        .get(path)
        .is_some_and(|last_seq| seq < *last_seq)
    {
        return Ok(());
    }
    write_atomic(path, json)?;
    last_written.insert(path.to_path_buf(), seq);
    Ok(())
}

/// Writes `json` to `path` atomically (temp file + rename) so a crash
/// mid-write can never leave a truncated/corrupt store behind.
fn write_atomic(path: &std::path::Path, json: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("workspace-snapshot");
    let temp_id = ATOMIC_TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_file_name(format!(
        ".{}.tmp-{}-{}",
        file_name,
        std::process::id(),
        temp_id
    ));
    let result = (|| {
        std::fs::write(&tmp, json)?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Explicit paths originate at the UI's file picker, but the IPC boundary is
/// also callable by untrusted local input. Require an absolute path, reject
/// traversal components and NUL bytes, and refuse existing symlink components
/// so a snapshot cannot escape the selected location through a link.
fn validate_explicit_path(raw: &str) -> Result<PathBuf, String> {
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

/// Move an existing store out of the way before normalizing it.  The first
/// backup keeps the historical `workspaces.json.bak` name; subsequent
/// recoveries get a numbered suffix instead of replacing an earlier backup.
fn backup_store(path: &std::path::Path) -> std::io::Result<Option<PathBuf>> {
    if !path.exists() {
        return Ok(None);
    }

    let backup = path.with_extension("json.bak");
    let target = if !backup.exists() {
        backup
    } else {
        let mut index = 1u64;
        loop {
            let candidate = path.with_file_name(format!(
                "{}.bak-{}",
                path.file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("workspaces.json"),
                index
            ));
            if !candidate.exists() {
                break candidate;
            }
            index = index.saturating_add(1);
        }
    };

    std::fs::rename(path, &target).map(|()| Some(target))
}

/// Parse an explicitly imported snapshot strictly.  Startup loading remains
/// intentionally forgiving and recovers valid entries from a damaged local
/// store; replacing the active store is different, so a malformed entry must
/// fail before any process or file state is changed.
fn parse_import_snapshot(raw: &str) -> Result<WorkspaceStore, String> {
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
fn mark_imported_sessions_suspended(store: &mut WorkspaceStore) {
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

fn transfer_counts(store: &WorkspaceStore) -> (usize, usize, usize, usize) {
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

/// Replace the active on-disk store while preserving a recoverable copy of
/// the previous file.  The lock also fences out an older debounced save, and
/// the rollback path restores the backup if the atomic write fails.
fn replace_store_file(path: &Path, json: &str) -> Result<Option<PathBuf>, String> {
    let lock = WRITE_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    let backup = backup_store(path).map_err(|error| {
        format!(
            "failed to back up the current workspace store {}: {}",
            path.display(),
            error
        )
    })?;
    if let Err(error) = write_atomic(path, json) {
        if let Some(backup_path) = backup.as_deref() {
            if let Err(restore_error) = std::fs::rename(backup_path, path) {
                return Err(format!(
                    "failed to write imported workspace store ({}); backup restore also failed ({}): {}",
                    error, restore_error, backup_path.display()
                ));
            }
        }
        return Err(format!(
            "failed to write imported workspace store: {}",
            error
        ));
    }

    let seq = SAVE_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    LAST_WRITTEN
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(path.to_path_buf(), seq);
    Ok(backup)
}

/// Background writer: coalesces save requests and flushes to disk 150ms after
/// the last change, so mutations never do blocking disk I/O on a caller thread.
fn save_channel() -> &'static Sender<SaveRequest> {
    SAVE_TX.get_or_init(|| {
        let (tx, rx) = channel::<SaveRequest>();
        std::thread::spawn(move || {
            while let Ok(mut req) = rx.recv() {
                loop {
                    match rx.recv_timeout(Duration::from_millis(150)) {
                        Ok(newer) => req = newer,
                        Err(_) => break,
                    }
                }
                write_guarded(&req.path, &req.json, req.seq);
            }
        });
        tx
    })
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
        "auto" | "grid" | "horizontal" | "vertical" | "stack" | "spotlight" => {
            normalized_mode
        }
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
    layout.sizes.retain(|key, value| {
        !key.trim().is_empty() && value.is_finite() && *value > 0.0
    });
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

impl WorkspaceStore {
    fn default_container_id(workspace_id: &str) -> String {
        format!("container-{}", workspace_id)
    }

    fn new_container(workspace_id: &str, id: String) -> WorkspaceContainer {
        WorkspaceContainer {
            id,
            project_id: workspace_id.to_string(),
            pane_ids: Vec::new(),
            last_used_at: Some(unix_millis()),
            size: 0.0,
            internal_layout: default_layout_mode(),
            collapsed: false,
            active_pane_id: None,
            visible: true,
            closed: false,
            fullscreen: false,
            layout: Some(WorkspaceLayout::default()),
        }
    }

    fn container_index(workspace: &Workspace, container_id: &str) -> Option<usize> {
        workspace
            .containers
            .iter()
            .position(|container| container.id == container_id)
    }

    fn ensure_container<'a>(
        workspace: &'a mut Workspace,
        container_id: &str,
    ) -> Result<usize, String> {
        let container_id = container_id.trim();
        if container_id.is_empty() {
            return Err("container id cannot be empty".to_string());
        }
        if let Some(index) = Self::container_index(workspace, container_id) {
            return Ok(index);
        }
        // A legacy workspace has no container records. Creating the first
        // deterministic record is safe and keeps existing PTYs untouched.
        if workspace.containers.is_empty() {
            workspace
                .containers
                .push(Self::new_container(workspace.id.as_str(), container_id.to_string()));
            return Ok(0);
        }
        Err(format!(
            "container {} not found in workspace {}",
            container_id, workspace.id
        ))
    }

    pub fn load(path: PathBuf) -> Self {
        let mut needs_migration = false;
        let mut needs_backup = false;
        let (workspaces, groups) = match std::fs::read_to_string(&path) {
            Ok(s) => match decode_workspace_file(&s) {
                Ok(decoded) => {
                    needs_migration = decoded.legacy;
                    needs_backup = decoded.dropped_entries;
                    (decoded.workspaces, decoded.groups)
                }
                Err(e) => {
                    // Never silently wipe the user's data: keep the corrupt
                    // file around for inspection instead of overwriting it.
                    eprintln!(
                        "workspaces store is corrupt ({}); backing up to .bak and starting fresh",
                        e
                    );
                    if let Err(backup_error) = backup_store(&path) {
                        eprintln!(
                            "failed to back up corrupt workspaces store: {}",
                            backup_error
                        );
                    }
                    (Vec::new(), Vec::new())
                }
            },
            Err(_) => (Vec::new(), Vec::new()),
        };
        let mut store = Self {
            workspaces,
            groups,
            save_path: Some(path),
        };

        // Normalize loaded data before it can reach the UI or PTY layer.  If
        // normalization discarded anything, retain the original file before
        // writing the canonical representation.  A legacy array is migrated
        // on load so future app versions only need to understand the envelope.
        if store.validate() {
            needs_backup = true;
        }
        for group in &store.groups {
            bump_next_group_id(&group.id);
        }
        if needs_migration || needs_backup {
            if needs_backup {
                if let Some(path) = &store.save_path {
                    if let Err(error) = backup_store(path) {
                        eprintln!("failed to back up normalized workspaces store: {}", error);
                    }
                }
            }
            store.save_now();
        }
        store
    }

    /// Drops malformed entries and clamps out-of-range values, so a
    /// hand-edited or corrupted store can never panic or break the layout.
    fn validate(&mut self) -> bool {
        let before_workspaces = self.workspaces.clone();
        let before_groups = self.groups.clone();
        let mut seen_ws = std::collections::HashSet::new();
        self.workspaces.retain_mut(|w| {
            let id = w.id.trim();
            if id.is_empty() {
                return false;
            }
            if id.len() != w.id.len() {
                w.id = id.to_string();
            }
            seen_ws.insert(w.id.clone())
        });
        // Terminal ids are the durable PTY/scrollback identity.  They must be
        // unique across the whole store, not merely inside one workspace:
        // every PTY command addresses an id without a workspace qualifier.
        // Keep the first occurrence in deterministic workspace/terminal order
        // and quarantine later occurrences from the normalized metadata.
        let mut seen_terminal_ids = std::collections::HashSet::new();
        for w in &mut self.workspaces {
            let mut duplicate_terminal_ids = std::collections::HashSet::new();
            w.terminals.retain_mut(|t| {
                let id = t.id.trim();
                if id.is_empty() {
                    return false;
                }
                if id.len() != t.id.len() {
                    t.id = id.to_string();
                }
                if seen_terminal_ids.insert(t.id.clone()) {
                    true
                } else {
                    duplicate_terminal_ids.insert(t.id.clone());
                    false
                }
            });
            for t in &mut w.terminals {
                t.width = t
                    .width
                    .filter(|v| v.is_finite())
                    .map(|v| v.clamp(MIN_TERMINAL_WIDTH, MAX_TERMINAL_WIDTH));
            }
            let workspace_terminal_ids = w
                .terminals
                .iter()
                .map(|terminal| terminal.id.as_str())
                .collect::<std::collections::HashSet<_>>();
            w.panes.retain_mut(|pane| {
                let id = pane.id.trim();
                if id.is_empty() {
                    return false;
                }
                if id.len() != pane.id.len() {
                    pane.id = id.to_string();
                }
                pane.tabs.retain_mut(|tab| {
                    let tab_id = tab.id.trim();
                    if tab_id.is_empty() {
                        return false;
                    }
                    if tab_id.len() != tab.id.len() {
                        tab.id = tab_id.to_string();
                    }
                    // A pane tab that points at a duplicate or at a terminal
                    // removed during recovery would otherwise make a later
                    // PTY operation ambiguous. Tabs without a PTY are kept as
                    // visual/orphan metadata for the frontend to reconcile.
                    if let Some(pty_id) = tab.pty_id.as_deref() {
                        if duplicate_terminal_ids.contains(pty_id)
                            || !workspace_terminal_ids.contains(pty_id)
                        {
                            return false;
                        }
                    }
                    true
                });
                if pane
                    .active_tab_id
                    .as_deref()
                    .is_some_and(|id| !pane.tabs.iter().any(|tab| tab.id == id))
                {
                    pane.active_tab_id = pane.tabs.first().map(|tab| tab.id.clone());
                }
                pane.width = pane.width.filter(|v| v.is_finite() && *v >= 0.0);
                pane.height = pane.height.filter(|v| v.is_finite() && *v >= 0.0);
                if let Some(layout) = &mut pane.layout {
                    normalize_layout_state(layout);
                    let valid_tabs = pane
                        .tabs
                        .iter()
                        .map(|tab| tab.id.as_str())
                        .collect::<std::collections::HashSet<_>>();
                    layout.item_ids.retain(|id| valid_tabs.contains(id.as_str()));
                }
                true
            });
            w.containers.retain_mut(|container| {
                let id = container.project_id.trim();
                if id.is_empty() {
                    return false;
                }
                if id.len() != container.project_id.len() {
                    container.project_id = id.to_string();
                }
                container.size = if container.size.is_finite() {
                    container.size.max(0.0)
                } else {
                    0.0
                };
                container
                    .pane_ids
                    .retain(|pane_id| !pane_id.trim().is_empty());
                if let Some(layout) = &mut container.layout {
                    normalize_layout_state(layout);
                }
                true
            });
            let mut seen_container_ids = std::collections::HashSet::new();
            let workspace_id_for_containers = w.id.clone();
            for (index, container) in w.containers.iter_mut().enumerate() {
                let base = if container.id.trim().is_empty() {
                    if index == 0 {
                        format!("container-{}", workspace_id_for_containers)
                    } else {
                        format!(
                            "container-{}-{}",
                            workspace_id_for_containers,
                            index + 1
                        )
                    }
                } else {
                    container.id.trim().to_string()
                };
                let mut candidate = base.clone();
                let mut suffix = 2;
                while !seen_container_ids.insert(candidate.clone()) {
                    candidate = format!("{}-{}", base, suffix);
                    suffix += 1;
                }
                container.id = candidate;
                container.size = container.size.clamp(0.0, 100.0);
                let valid_panes = container
                    .pane_ids
                    .iter()
                    .map(String::as_str)
                    .collect::<std::collections::HashSet<_>>();
                if let Some(active) = container.active_pane_id.as_deref() {
                    if !valid_panes.contains(active) {
                        container.active_pane_id = None;
                    }
                }
                if let Some(layout) = &mut container.layout {
                    layout.item_ids.retain(|id| valid_panes.contains(id.as_str()));
                }
            }
            let container_ids = w
                .containers
                .iter()
                .map(|container| container.id.as_str())
                .collect::<std::collections::HashSet<_>>();
            for pane in &mut w.panes {
                if pane
                    .container_id
                    .as_deref()
                    .is_some_and(|container_id| !container_ids.contains(container_id))
                {
                    pane.container_id = None;
                }
            }
            if let Some(layout) = &mut w.layout {
                normalize_layout_state(layout);
                layout.item_ids.retain(|id| {
                    container_ids.contains(id.as_str())
                        || w.panes.iter().any(|pane| pane.id == *id)
                });
            }
            if w
                .active_container_id
                .as_deref()
                .is_some_and(|id| !container_ids.contains(id))
            {
                w.active_container_id = None;
            }
            let pane_ids = w
                .panes
                .iter()
                .map(|pane| pane.id.as_str())
                .collect::<std::collections::HashSet<_>>();
            if w
                .active_pane_id
                .as_deref()
                .is_some_and(|id| !pane_ids.contains(id))
            {
                w.active_pane_id = None;
            }
            if let Some(layout) = &mut w.layout {
                layout.item_ids.retain(|id| {
                    container_ids.contains(id.as_str()) || pane_ids.contains(id.as_str())
                });
            }
        }
        let mut seen_groups = std::collections::HashSet::new();
        self.groups.retain_mut(|group| {
            let id = group.id.trim();
            let name = group.name.trim();
            if id.is_empty() || name.is_empty() || !seen_groups.insert(id.to_string()) {
                return false;
            }
            if id.len() != group.id.len() {
                group.id = id.to_string();
            }
            if name.len() != group.name.len() {
                group.name = name.to_string();
            }
            let mut seen_projects = std::collections::HashSet::new();
            group.project_ids.retain_mut(|project_id| {
                let project_id_trimmed = project_id.trim();
                if project_id_trimmed.is_empty()
                    || !seen_projects.insert(project_id_trimmed.to_string())
                {
                    return false;
                }
                if project_id_trimmed.len() != project_id.len() {
                    *project_id = project_id_trimmed.to_string();
                }
                true
            });
            true
        });
        self.workspaces != before_workspaces || self.groups != before_groups
    }

    fn serialized_snapshot(&self) -> Result<String, serde_json::Error> {
        // Keep serialization resilient even if a caller has modified the
        // public `workspaces` field directly.  The store itself is left
        // untouched; only the persisted snapshot is normalized.
        let mut snapshot = Self {
            workspaces: self.workspaces.clone(),
            groups: self.groups.clone(),
            save_path: None,
        };
        snapshot.validate();
        serde_json::to_string_pretty(&WorkspaceFile {
            version: WORKSPACE_FILE_VERSION,
            workspaces: snapshot.workspaces,
            groups: snapshot.groups,
        })
    }

    pub fn save(&self) {
        let Some(path) = &self.save_path else { return };
        if let Ok(json) = self.serialized_snapshot() {
            let _ = save_channel().send(SaveRequest {
                path: path.clone(),
                json,
                seq: SAVE_SEQ.fetch_add(1, Ordering::SeqCst) + 1,
            });
        }
    }

    /// Synchronous, un-debounced save for shutdown, so the final state is
    /// never lost when the app exits within the 150ms debounce window.
    pub fn save_now(&self) {
        let Some(path) = &self.save_path else { return };
        match self.serialized_snapshot() {
            Ok(json) => {
                let seq = SAVE_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
                write_guarded(path, &json, seq);
            }
            Err(e) => eprintln!("failed to serialize workspaces on exit: {}", e),
        }
    }

    pub fn create(&mut self, name: String, cwd: String) -> Workspace {
        let cwd = if cwd.trim().is_empty() {
            home_dir()
        } else {
            cwd
        };
        let id = format!("ws-{}", NEXT_WS_ID.fetch_add(1, Ordering::SeqCst));
        let ws = Workspace {
            id: id.clone(),
            name: if name.trim().is_empty() {
                "workspace".into()
            } else {
                name
            },
            cwd,
            terminals: Vec::new(),
            group_id: None,
            panes: Vec::new(),
            containers: vec![Self::new_container(
                &id,
                Self::default_container_id(&id),
            )],
            active_pane_id: None,
            active_container_id: None,
            collapsed: false,
            archived: false,
            created_at: Some(unix_millis()),
            layout_mode: Some(default_layout_mode()),
            layout: Some(WorkspaceLayout::default()),
        };
        self.workspaces.push(ws.clone());
        self.save();
        ws
    }

    pub fn remove(&mut self, id: &str) -> Option<Workspace> {
        let idx = self.workspaces.iter().position(|w| w.id == id)?;
        let ws = self.workspaces.remove(idx);
        for group in &mut self.groups {
            group.project_ids.retain(|project_id| project_id != id);
        }
        self.save();
        Some(ws)
    }

    pub fn get(&self, id: &str) -> Option<&Workspace> {
        self.workspaces.iter().find(|w| w.id == id)
    }

    /// Return the workspace that owns a terminal identity, if any. Terminal
    /// ids are global PTY keys, so callers must use this instead of searching
    /// only the target workspace when validating a forced/resume spawn.
    pub fn terminal_owner(&self, terminal_id: &str) -> Option<&str> {
        self.workspaces.iter().find_map(|workspace| {
            workspace
                .terminals
                .iter()
                .any(|terminal| terminal.id == terminal_id)
                .then_some(workspace.id.as_str())
        })
    }

    /// Returns false when the workspace no longer exists (e.g. it was closed
    /// while a terminal was being spawned), so the caller can roll back.
    pub fn add_terminal(&mut self, ws_id: &str, meta: TerminalMeta) -> bool {
        if self
            .terminal_owner(&meta.id)
            .is_some_and(|owner| owner != ws_id)
        {
            return false;
        }
        let Some(ws) = self.workspaces.iter_mut().find(|w| w.id == ws_id) else {
            return false;
        };
        if let Some(existing) = ws.terminals.iter_mut().find(|t| t.id == meta.id) {
            existing.command = meta.command.clone();
            existing.suspended = false;
        } else {
            ws.terminals.push(meta);
        }
        self.save();
        true
    }

    pub fn remove_terminal(&mut self, terminal_id: &str) {
        for ws in self.workspaces.iter_mut() {
            ws.terminals.retain(|t| t.id != terminal_id);
            for pane in &mut ws.panes {
                pane.tabs.retain(|tab| {
                    tab.pty_id.as_deref() != Some(terminal_id) && tab.id.as_str() != terminal_id
                });
                if pane
                    .active_tab_id
                    .as_deref()
                    .is_some_and(|id| !pane.tabs.iter().any(|tab| tab.id == id))
                {
                    pane.active_tab_id = pane.tabs.first().map(|tab| tab.id.clone());
                }
            }
        }
        self.save();
    }

    pub fn rename(&mut self, id: &str, name: String) {
        let name = name.trim().to_string();
        if name.is_empty() {
            return;
        }
        if let Some(ws) = self.workspaces.iter_mut().find(|w| w.id == id) {
            ws.name = name;
        }
        self.save();
    }

    pub fn reorder_workspaces(&mut self, order: &[String]) {
        let mut remaining = std::mem::take(&mut self.workspaces);
        let mut sorted = Vec::with_capacity(remaining.len());
        for id in order {
            if let Some(pos) = remaining.iter().position(|w| &w.id == id) {
                sorted.push(remaining.remove(pos));
            }
        }
        sorted.extend(remaining);
        self.workspaces = sorted;
        self.save();
    }

    pub fn set_width(&mut self, ws_id: &str, terminal_id: &str, width: f64) {
        if let Some(ws) = self.workspaces.iter_mut().find(|w| w.id == ws_id) {
            if let Some(t) = ws.terminals.iter_mut().find(|t| t.id == terminal_id) {
                t.width = width
                    .is_finite()
                    .then_some(width.clamp(MIN_TERMINAL_WIDTH, MAX_TERMINAL_WIDTH));
            }
        }
        self.save();
    }

    /// Keep the workspace's group pointer and the group's project list as a
    /// bidirectional relationship. Passing `None` unassigns the workspace.
    pub fn set_workspace_group(
        &mut self,
        workspace_id: &str,
        group_id: Option<String>,
    ) -> Result<(), String> {
        let workspace_id = workspace_id.trim();
        if workspace_id.is_empty() {
            return Err("workspace id cannot be empty".to_string());
        }
        let group_id = group_id.and_then(|id| {
            let trimmed = id.trim().to_string();
            (!trimmed.is_empty()).then_some(trimmed)
        });
        if !self
            .workspaces
            .iter()
            .any(|workspace| workspace.id == workspace_id)
        {
            return Err(format!("workspace {} not found", workspace_id));
        }
        if let Some(group_id) = group_id.as_deref() {
            if !self.groups.iter().any(|group| group.id == group_id) {
                return Err(format!("group {} not found", group_id));
            }
        }

        for group in &mut self.groups {
            group
                .project_ids
                .retain(|project_id| project_id != workspace_id);
        }
        if let Some(group_id) = group_id.as_deref() {
            let group = self
                .groups
                .iter_mut()
                .find(|group| group.id == group_id)
                .expect("group was checked above");
            if !group
                .project_ids
                .iter()
                .any(|project_id| project_id == workspace_id)
            {
                group.project_ids.push(workspace_id.to_string());
            }
        }
        self.workspaces
            .iter_mut()
            .find(|workspace| workspace.id == workspace_id)
            .expect("workspace was checked above")
            .group_id = group_id.clone();
        if let Some(workspace) = self
            .workspaces
            .iter_mut()
            .find(|workspace| workspace.id == workspace_id)
        {
            for terminal in &mut workspace.terminals {
                terminal.group_id = group_id.clone();
            }
        }
        self.save();
        Ok(())
    }

    /// Place a terminal in a visual pane and sub-tab without touching the
    /// PTY manager. Existing duplicate references are removed first, then a
    /// normalized pane/tab pair is created or updated.
    pub fn set_terminal_placement(
        &mut self,
        workspace_id: &str,
        terminal_id: &str,
        pane_id: String,
        tab_id: String,
    ) -> Result<(), String> {
        let pane_id = pane_id.trim().to_string();
        let tab_id = tab_id.trim().to_string();
        if pane_id.is_empty() || tab_id.is_empty() {
            return Err("pane id and tab id cannot be empty".to_string());
        }
        let workspace = self
            .workspaces
            .iter_mut()
            .find(|workspace| workspace.id == workspace_id)
            .ok_or_else(|| format!("workspace {} not found", workspace_id))?;
        let terminal = workspace
            .terminals
            .iter_mut()
            .find(|terminal| terminal.id == terminal_id)
            .ok_or_else(|| {
                format!(
                    "terminal {} not found in workspace {}",
                    terminal_id, workspace_id
                )
            })?;
        let command = terminal.command.clone();
        let suspended = terminal.suspended;
        terminal.pane_id = Some(pane_id.clone());
        terminal.tab_id = Some(tab_id.clone());

        // One terminal/tab identity can have only one visual location. This
        // also cleans stale references left by interrupted UI reorders.
        let mut displaced_tabs: Vec<(Option<String>, String)> = Vec::new();
        for pane in &mut workspace.panes {
            pane.tabs.retain(|tab| {
                let displaced = tab.pty_id.as_deref() != Some(terminal_id)
                    && tab.id.as_str() == tab_id.as_str();
                let remove = tab.pty_id.as_deref() == Some(terminal_id) || displaced;
                if remove {
                    displaced_tabs.push((tab.pty_id.clone(), tab.id.clone()));
                }
                !remove
            });
            if pane.active_tab_id.as_deref() == Some(tab_id.as_str()) {
                pane.active_tab_id = pane.tabs.first().map(|tab| tab.id.clone());
            }
        }
        for other_terminal in &mut workspace.terminals {
            if other_terminal.id == terminal_id {
                continue;
            }
            if displaced_tabs.iter().any(|(pty_id, displaced_tab_id)| {
                pty_id.as_deref() == Some(other_terminal.id.as_str())
                    || other_terminal.tab_id.as_deref() == Some(displaced_tab_id.as_str())
            }) {
                other_terminal.pane_id = None;
                other_terminal.tab_id = None;
            }
        }

        let pane_index =
            if let Some(index) = workspace.panes.iter().position(|pane| pane.id == pane_id) {
                index
            } else {
                workspace.panes.push(Pane {
                    id: pane_id.clone(),
                    name: if command.trim().is_empty() {
                        "Terminal".to_string()
                    } else {
                        command.clone()
                    },
                    cwd: workspace.cwd.clone(),
                    tabs: Vec::new(),
                    active_tab_id: None,
                    kind: Some("terminal".to_string()),
                    disabled: false,
                    collapsed: false,
                    width: None,
                    height: None,
                    container_id: None,
                    layout: None,
                });
                workspace.panes.len() - 1
            };
        let container_id = workspace.panes[pane_index]
            .container_id
            .clone()
            .or_else(|| workspace.containers.first().map(|container| container.id.clone()))
            .unwrap_or_else(|| Self::default_container_id(workspace_id));
        let container_index = Self::ensure_container(workspace, &container_id)?;
        if workspace.panes[pane_index].container_id.is_none() {
            workspace.panes[pane_index].container_id = Some(container_id.clone());
        }
        if !workspace.containers[container_index]
            .pane_ids
            .iter()
            .any(|id| id == &pane_id)
        {
            workspace.containers[container_index]
                .pane_ids
                .push(pane_id.clone());
        }
        let pane = &mut workspace.panes[pane_index];
        if let Some(tab) = pane.tabs.iter_mut().find(|tab| tab.id == tab_id) {
            tab.kind = if tab.kind.trim().is_empty() {
                default_tab_kind()
            } else {
                tab.kind.clone()
            };
            tab.name = if tab.name.trim().is_empty() {
                command.clone()
            } else {
                tab.name.clone()
            };
            tab.cwd = workspace.cwd.clone();
            tab.pty_id = Some(terminal_id.to_string());
            tab.suspended = suspended;
        } else {
            pane.tabs.push(TerminalTab {
                id: tab_id.clone(),
                kind: default_tab_kind(),
                name: if command.trim().is_empty() {
                    "Terminal".to_string()
                } else {
                    command.clone()
                },
                cwd: workspace.cwd.clone(),
                pty_id: Some(terminal_id.to_string()),
                session_id: None,
                last_used_at: Some(unix_millis()),
                completion_unread: false,
                extra_args: Vec::new(),
                suspended,
            });
        }
        pane.active_tab_id = Some(tab_id);
        self.save();
        Ok(())
    }

    pub fn set_active_pane(
        &mut self,
        workspace_id: &str,
        pane_id: Option<String>,
    ) -> Result<(), String> {
        let workspace = self
            .workspaces
            .iter_mut()
            .find(|workspace| workspace.id == workspace_id)
            .ok_or_else(|| format!("workspace {} not found", workspace_id))?;
        let pane_id = pane_id.and_then(|id| {
            let trimmed = id.trim().to_string();
            (!trimmed.is_empty()).then_some(trimmed)
        });
        if let Some(pane_id) = pane_id.as_deref() {
            if !workspace.panes.iter().any(|pane| pane.id == pane_id) {
                return Err(format!(
                    "pane {} not found in workspace {}",
                    pane_id, workspace_id
                ));
            }
        }
        workspace.active_pane_id = pane_id;
        workspace.active_container_id = workspace
            .active_pane_id
            .as_deref()
            .and_then(|active_id| {
                workspace.containers.iter().find_map(|container| {
                    container
                        .pane_ids
                        .iter()
                        .any(|pane_id| pane_id == active_id)
                        .then(|| container.id.clone())
                })
            });
        for container in &mut workspace.containers {
            if workspace.active_pane_id.is_none() {
                container.active_pane_id = None;
            } else if container
                .pane_ids
                .iter()
                .any(|id| Some(id.as_str()) == workspace.active_pane_id.as_deref())
            {
                container.active_pane_id = workspace.active_pane_id.clone();
            }
        }
        self.save();
        Ok(())
    }

    /// Reorder visual containers without touching panes or PTYs. Unknown and
    /// duplicate ids are ignored, and omitted existing containers retain their
    /// relative order for forward-compatible clients.
    pub fn reorder_containers(
        &mut self,
        workspace_id: &str,
        order: &[String],
    ) -> Result<(), String> {
        let workspace = self
            .workspaces
            .iter_mut()
            .find(|workspace| workspace.id == workspace_id)
            .ok_or_else(|| format!("workspace {} not found", workspace_id))?;
        let mut remaining = std::mem::take(&mut workspace.containers);
        let mut sorted = Vec::with_capacity(remaining.len());
        for id in order {
            if let Some(index) = remaining.iter().position(|container| &container.id == id) {
                sorted.push(remaining.remove(index));
            }
        }
        sorted.extend(remaining);
        workspace.containers = sorted;
        self.save();
        Ok(())
    }

    /// Reorder pane ids inside one container. The pane records themselves are
    /// not deleted or recreated, preserving tab and PTY identity.
    pub fn reorder_panes(
        &mut self,
        workspace_id: &str,
        container_id: &str,
        order: &[String],
    ) -> Result<(), String> {
        let workspace = self
            .workspaces
            .iter_mut()
            .find(|workspace| workspace.id == workspace_id)
            .ok_or_else(|| format!("workspace {} not found", workspace_id))?;
        let container_index = match Self::container_index(workspace, container_id) {
            Some(index) => index,
            None if workspace.containers.is_empty() => Self::ensure_container(workspace, container_id)?,
            None => {
                return Err(format!(
                    "container {} not found in workspace {}",
                    container_id, workspace_id
                ));
            }
        };
        let container = &mut workspace.containers[container_index];
        let mut remaining = std::mem::take(&mut container.pane_ids);
        let mut sorted = Vec::with_capacity(remaining.len());
        for id in order {
            if let Some(index) = remaining.iter().position(|pane_id| pane_id == id) {
                sorted.push(remaining.remove(index));
            }
        }
        sorted.extend(remaining);
        container.pane_ids = sorted;
        if let Some(layout) = &mut container.layout {
            layout.item_ids = container.pane_ids.clone();
        }
        self.save();
        Ok(())
    }

    /// Move an existing pane between visual containers. A pane move is pure
    /// metadata: every terminal tab and its PTY remain untouched.
    pub fn move_pane(
        &mut self,
        workspace_id: &str,
        pane_id: &str,
        to_container_id: &str,
        index: Option<usize>,
    ) -> Result<(), String> {
        let workspace = self
            .workspaces
            .iter_mut()
            .find(|workspace| workspace.id == workspace_id)
            .ok_or_else(|| format!("workspace {} not found", workspace_id))?;
        if !workspace.panes.iter().any(|pane| pane.id == pane_id) {
            return Err(format!("pane {} not found in workspace {}", pane_id, workspace_id));
        }
        let target_index = Self::container_index(workspace, to_container_id).ok_or_else(|| {
            format!(
                "container {} not found in workspace {}",
                to_container_id, workspace_id
            )
        })?;
        for container in &mut workspace.containers {
            container.pane_ids.retain(|id| id != pane_id);
            if container.active_pane_id.as_deref() == Some(pane_id)
                && container.id != to_container_id
            {
                container.active_pane_id = container.pane_ids.first().cloned();
            }
        }
        let target = &mut workspace.containers[target_index];
        let insertion = index.unwrap_or(target.pane_ids.len()).min(target.pane_ids.len());
        target.pane_ids.insert(insertion, pane_id.to_string());
        target.active_pane_id.get_or_insert_with(|| pane_id.to_string());
        if let Some(layout) = &mut target.layout {
            layout.item_ids = target.pane_ids.clone();
        }
        if let Some(pane) = workspace.panes.iter_mut().find(|pane| pane.id == pane_id) {
            pane.container_id = Some(to_container_id.to_string());
        }
        self.save();
        Ok(())
    }

    /// Apply a partial container state update. Visible/closed are kept
    /// complementary when only one side is supplied, and invalid active pane
    /// ids are rejected rather than persisted as dangling selections.
    pub fn set_container_state(
        &mut self,
        workspace_id: &str,
        container_id: &str,
        patch: WorkspaceContainerPatch,
    ) -> Result<(), String> {
        let workspace = self
            .workspaces
            .iter_mut()
            .find(|workspace| workspace.id == workspace_id)
            .ok_or_else(|| format!("workspace {} not found", workspace_id))?;
        let container_index = match Self::container_index(workspace, container_id) {
            Some(index) => index,
            None if workspace.containers.is_empty() => Self::ensure_container(workspace, container_id)?,
            None => {
                return Err(format!(
                    "container {} not found in workspace {}",
                    container_id, workspace_id
                ));
            }
        };
        let valid_panes = workspace.containers[container_index]
            .pane_ids
            .iter()
            .cloned()
            .collect::<std::collections::HashSet<_>>();
        if let Some(active_pane_id) = patch.active_pane_id.as_deref() {
            if !valid_panes.contains(active_pane_id) {
                return Err(format!(
                    "pane {} is not in container {}",
                    active_pane_id, container_id
                ));
            }
        }
        let container = &mut workspace.containers[container_index];
        if let Some(visible) = patch.visible {
            container.visible = visible;
            if patch.closed.is_none() {
                container.closed = !visible;
            }
        }
        if let Some(closed) = patch.closed {
            container.closed = closed;
            if patch.visible.is_none() {
                container.visible = !closed;
            }
        }
        if let Some(collapsed) = patch.collapsed {
            container.collapsed = collapsed;
        }
        if let Some(fullscreen) = patch.fullscreen {
            container.fullscreen = fullscreen;
        }
        if patch.clear_active_pane {
            container.active_pane_id = None;
        } else if let Some(active_pane_id) = patch.active_pane_id {
            container.active_pane_id = Some(active_pane_id);
        }
        if let Some(internal_layout) = patch.internal_layout {
            let internal_layout = internal_layout.trim();
            if !internal_layout.is_empty() {
                container.internal_layout = internal_layout.to_string();
            }
        }
        if let Some(size) = patch.size.filter(|size| size.is_finite()) {
            container.size = size.clamp(0.0, 100.0);
        }
        if let Some(mut layout) = patch.layout {
            normalize_layout_state(&mut layout);
            layout.item_ids.retain(|id| valid_panes.contains(id));
            container.layout = Some(layout);
        }
        self.save();
        Ok(())
    }

    pub fn set_layout(
        &mut self,
        workspace_id: &str,
        mut layout: WorkspaceLayout,
    ) -> Result<(), String> {
        let workspace = self
            .workspaces
            .iter_mut()
            .find(|workspace| workspace.id == workspace_id)
            .ok_or_else(|| format!("workspace {} not found", workspace_id))?;
        normalize_layout_state(&mut layout);
        workspace.layout_mode = Some(layout.mode.clone());
        workspace.layout = Some(layout);
        self.save();
        Ok(())
    }

    pub fn set_collapsed(&mut self, workspace_id: &str, collapsed: bool) -> Result<(), String> {
        let workspace = self
            .workspaces
            .iter_mut()
            .find(|workspace| workspace.id == workspace_id)
            .ok_or_else(|| format!("workspace {} not found", workspace_id))?;
        workspace.collapsed = collapsed;
        self.save();
        Ok(())
    }

    pub fn list_groups(&self) -> Vec<Group> {
        self.groups.clone()
    }

    pub fn create_group(&mut self, name: String) -> Group {
        let group = Group {
            id: format!("group-{}", NEXT_GROUP_ID.fetch_add(1, Ordering::SeqCst)),
            name: if name.trim().is_empty() {
                "group".to_string()
            } else {
                name.trim().to_string()
            },
            color: None,
            icon_url: None,
            collapsed: false,
            project_ids: Vec::new(),
            parent_group_id: None,
            layout_mode: Some(default_layout_mode()),
            suspended: false,
            archived: false,
            created_at: Some(unix_millis()),
        };
        self.groups.push(group.clone());
        self.save();
        group
    }

    pub fn rename_group(&mut self, id: &str, name: String) -> Result<(), String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("group name cannot be empty".to_string());
        }
        let Some(group) = self.groups.iter_mut().find(|group| group.id == id) else {
            return Err(format!("group {} not found", id));
        };
        group.name = name.to_string();
        self.save();
        Ok(())
    }

    /// Remove the group metadata but leave projects and terminals untouched.
    pub fn remove_group(&mut self, id: &str) -> Result<(), String> {
        let Some(index) = self.groups.iter().position(|group| group.id == id) else {
            return Err(format!("group {} not found", id));
        };
        self.groups.remove(index);
        for workspace in &mut self.workspaces {
            if workspace.group_id.as_deref() == Some(id) {
                workspace.group_id = None;
            }
            for terminal in &mut workspace.terminals {
                if terminal.group_id.as_deref() == Some(id) {
                    terminal.group_id = None;
                }
            }
        }
        self.save();
        Ok(())
    }

    /// Mark a group and its terminal metadata suspended, returning the PTY
    /// ids that the caller must stop. This method never touches processes.
    pub fn suspend_group(&mut self, id: &str) -> Result<Vec<String>, String> {
        let Some(group) = self.groups.iter_mut().find(|group| group.id == id) else {
            return Err(format!("group {} not found", id));
        };
        group.suspended = true;
        let project_ids: std::collections::HashSet<String> =
            group.project_ids.iter().cloned().collect();
        let mut terminal_ids = Vec::new();
        for workspace in &mut self.workspaces {
            if workspace.group_id.as_deref() != Some(id) && !project_ids.contains(&workspace.id) {
                continue;
            }
            for terminal in &mut workspace.terminals {
                terminal.suspended = true;
                if !terminal_ids.iter().any(|id| id == &terminal.id) {
                    terminal_ids.push(terminal.id.clone());
                }
            }
            let suspended_ids: std::collections::HashSet<&str> =
                terminal_ids.iter().map(String::as_str).collect();
            for pane in &mut workspace.panes {
                for tab in &mut pane.tabs {
                    if tab
                        .pty_id
                        .as_deref()
                        .is_some_and(|pty_id| suspended_ids.contains(pty_id))
                    {
                        tab.suspended = true;
                    }
                }
            }
        }
        self.save();
        Ok(terminal_ids)
    }

    pub fn resume_group(&mut self, id: &str) -> Result<(), String> {
        let Some(group) = self.groups.iter_mut().find(|group| group.id == id) else {
            return Err(format!("group {} not found", id));
        };
        group.suspended = false;
        self.save();
        Ok(())
    }
}

/// Last time the store file was written, in milliseconds since the Unix
/// epoch. The store is flushed synchronously on exit, so this is when the
/// previous session ended; the startup resume dialog shows it as "X ago".
#[tauri::command(async)]
pub fn store_saved_at(store: State<'_, Mutex<WorkspaceStore>>) -> Result<Option<u64>, String> {
    let store = store.lock().map_err(|e| e.to_string())?;
    let Some(path) = &store.save_path else {
        return Ok(None);
    };
    let millis = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    Ok(millis)
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
        let store = store.lock().map_err(|e| e.to_string())?;
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

/// Import a validated legacy/v1/v2 snapshot.  The current store is backed up
/// and replaced atomically; all currently tracked PTYs are stopped so the
/// imported metadata cannot accidentally describe an inherited live process.
#[tauri::command(async)]
pub fn import_workspace_snapshot(
    app: AppHandle,
    path: String,
) -> Result<WorkspaceSnapshotTransfer, String> {
    let source = validate_explicit_path(&path)?;
    let raw = std::fs::read_to_string(&source).map_err(|error| {
        format!(
            "failed to read workspace snapshot {}: {}",
            source.display(),
            error
        )
    })?;
    let mut imported = parse_import_snapshot(&raw)?;
    mark_imported_sessions_suspended(&mut imported);
    let counts = transfer_counts(&imported);
    let json = imported
        .serialized_snapshot()
        .map_err(|error| format!("failed to serialize imported workspace snapshot: {}", error))?;

    let state = app.state::<Mutex<WorkspaceStore>>();
    let mut current = state.lock().map_err(|e| e.to_string())?;
    let target = current
        .save_path
        .clone()
        .ok_or_else(|| "workspace store has no persistence path".to_string())?;
    let backup = replace_store_file(&target, &json)?;

    // A transfer is metadata-only. Stop every process known to this app
    // before swapping the in-memory store, including sessions absent from the
    // old persisted file after a previous interrupted operation.
    let manager = app.state::<Mutex<crate::pty::PtyManager>>();
    crate::pty::kill_all(&manager);

    imported.save_path = Some(target);
    for workspace in &imported.workspaces {
        bump_next_id(&workspace.id);
        for terminal in &workspace.terminals {
            crate::pty::bump_next_terminal_id(&terminal.id);
        }
    }
    for group in &imported.groups {
        bump_next_group_id(&group.id);
    }
    *current = imported;
    drop(current);
    emit_workspaces_changed(&app);

    Ok(WorkspaceSnapshotTransfer {
        version: WORKSPACE_FILE_VERSION,
        path: source.to_string_lossy().into_owned(),
        backup_path: backup.map(|path| path.to_string_lossy().into_owned()),
        workspace_count: counts.0,
        group_count: counts.1,
        terminal_count: counts.2,
        suspended_terminal_count: counts.3,
    })
}

#[tauri::command(async)]
pub fn create_workspace(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    name: String,
    cwd: String,
) -> Result<Workspace, String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    let workspace = store.create(name, cwd);
    drop(store);
    emit_workspaces_changed(&app);
    Ok(workspace)
}

#[tauri::command(async)]
pub fn list_workspaces(store: State<'_, Mutex<WorkspaceStore>>) -> Result<Vec<Workspace>, String> {
    let store = store.lock().map_err(|e| e.to_string())?;
    Ok(store.workspaces.clone())
}

#[tauri::command(async)]
pub fn list_groups(store: State<'_, Mutex<WorkspaceStore>>) -> Result<Vec<Group>, String> {
    let store = store.lock().map_err(|e| e.to_string())?;
    Ok(store.list_groups())
}

#[tauri::command(async)]
pub fn set_workspace_group(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    group_id: Option<String>,
) -> Result<(), String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
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
    let mut store = store.lock().map_err(|e| e.to_string())?;
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
    let mut store = store.lock().map_err(|e| e.to_string())?;
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
    let mut store = store.lock().map_err(|e| e.to_string())?;
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
    let mut store = store.lock().map_err(|e| e.to_string())?;
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
    let mut store = store.lock().map_err(|e| e.to_string())?;
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
    let mut store = store.lock().map_err(|e| e.to_string())?;
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
    let mut store = store.lock().map_err(|e| e.to_string())?;
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
    let mut store = store.lock().map_err(|e| e.to_string())?;
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
    let mut store = store.lock().map_err(|e| e.to_string())?;
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
    let mut store = store.lock().map_err(|e| e.to_string())?;
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
    let mut store = store.lock().map_err(|e| e.to_string())?;
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
        let mut store = store.lock().map_err(|e| e.to_string())?;
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
    let mut store = store.lock().map_err(|e| e.to_string())?;
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
    let mut store = store.lock().map_err(|e| e.to_string())?;
    store.rename(&id, name);
    drop(store);
    emit_workspaces_changed(&app);
    Ok(())
}

#[tauri::command(async)]
pub fn reorder_workspaces(
    app: AppHandle,
    store: State<'_, Mutex<WorkspaceStore>>,
    order: Vec<String>,
) -> Result<(), String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
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
    let mut store = store.lock().map_err(|e| e.to_string())?;
    store.set_width(&ws_id, &terminal_id, width);
    drop(store);
    emit_workspaces_changed(&app);
    Ok(())
}

#[tauri::command(async)]
pub fn close_workspace(app: AppHandle, id: String) -> Result<(), String> {
    let store = app.state::<Mutex<WorkspaceStore>>();
    let terminals = {
        let mut store = store.lock().map_err(|e| e.to_string())?;
        store.remove(&id).map(|ws| ws.terminals)
    };
    if let Some(terminals) = terminals {
        let manager = app.state::<Mutex<crate::pty::PtyManager>>();
        for t in terminals {
            crate::pty::kill_terminal_inner(&manager, &t.id);
        }
    }
    emit_workspaces_changed(&app);
    Ok(())
}

fn safe_relative_path(value: Option<&str>) -> Result<PathBuf, String> {
    let raw = value.unwrap_or("").trim();
    if raw.is_empty() {
        return Ok(PathBuf::new());
    }
    if raw.contains('\0') {
        return Err("file path contains a NUL byte".to_string());
    }
    let path = Path::new(raw);
    if path.is_absolute() {
        return Err("file path must be relative to the workspace".to_string());
    }
    let mut relative = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(segment) => relative.push(segment),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err("file path cannot escape the workspace".to_string());
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err("file path must be relative to the workspace".to_string());
            }
        }
    }
    Ok(relative)
}

fn relative_path_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn list_directory_entries(
    workspace_root: &Path,
    relative_path: Option<&str>,
    requested_limit: Option<usize>,
) -> Result<WorkspaceFileListing, String> {
    let limit = requested_limit.unwrap_or(DEFAULT_FILE_LIST_LIMIT);
    if limit == 0 {
        return Err("file listing limit must be greater than zero".to_string());
    }
    let limit = limit.min(MAX_FILE_LIST_LIMIT);
    let root = workspace_root
        .canonicalize()
        .map_err(|error| format!("workspace directory is unavailable: {}", error))?;
    if !root.is_dir() {
        return Err("workspace cwd is not a directory".to_string());
    }
    let relative = safe_relative_path(relative_path)?;
    let target = root
        .join(&relative)
        .canonicalize()
        .map_err(|error| format!("directory is unavailable: {}", error))?;
    if !target.starts_with(&root) {
        return Err("file path cannot escape the workspace".to_string());
    }
    if !target.is_dir() {
        return Err("requested file path is not a directory".to_string());
    }

    let mut entries = std::fs::read_dir(&target)
        .map_err(|error| format!("cannot list directory: {}", error))?
        .map(|entry| {
            let entry = entry.map_err(|error| format!("cannot read directory entry: {}", error))?;
            let metadata = std::fs::symlink_metadata(entry.path())
                .map_err(|error| format!("cannot inspect {}: {}", entry.path().display(), error))?;
            let file_type = metadata.file_type();
            let kind = if file_type.is_symlink() {
                "symlink"
            } else if file_type.is_dir() {
                "directory"
            } else if file_type.is_file() {
                "file"
            } else {
                "other"
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            let child_path = if relative.as_os_str().is_empty() {
                PathBuf::from(&name)
            } else {
                relative.join(&name)
            };
            Ok(WorkspaceFileEntry {
                name,
                path: relative_path_string(&child_path),
                kind: kind.to_string(),
                size: file_type.is_file().then_some(metadata.len()),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    entries.sort_by(|left, right| {
        let left_directory = left.kind == "directory";
        let right_directory = right.kind == "directory";
        right_directory
            .cmp(&left_directory)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.name.cmp(&right.name))
    });
    let truncated = entries.len() > limit;
    entries.truncate(limit);
    Ok(WorkspaceFileListing {
        path: relative_path_string(&relative),
        entries,
        truncated,
        limit,
    })
}

#[tauri::command(async)]
pub fn list_workspace_files(
    store: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    relative_path: Option<String>,
    limit: Option<usize>,
) -> Result<WorkspaceFileListing, String> {
    let cwd = {
        let store = store.lock().map_err(|error| error.to_string())?;
        store
            .workspaces
            .iter()
            .find(|workspace| workspace.id == workspace_id)
            .map(|workspace| workspace.cwd.clone())
            .ok_or_else(|| format!("workspace {} not found", workspace_id))?
    };
    list_directory_entries(Path::new(&cwd), relative_path.as_deref(), limit)
}

fn add_unique(values: &mut Vec<String>, value: String) {
    if !values.iter().any(|existing| existing == &value) {
        values.push(value);
    }
}

fn parse_git_status(output: &[u8]) -> Result<WorkspaceGitStatus, String> {
    let mut records = output.split(|byte| *byte == 0);
    let header = records
        .next()
        .ok_or_else(|| "git status returned no branch header".to_string())?;
    let header = String::from_utf8_lossy(header);
    let details = header
        .strip_prefix("## ")
        .ok_or_else(|| "git status returned an invalid branch header".to_string())?;
    let branch_details = details.split(" [").next().unwrap_or(details);
    let branch = if branch_details == "HEAD (no branch)" {
        None
    } else if let Some(name) = branch_details.strip_prefix("No commits yet on ") {
        Some(name.to_string())
    } else if let Some(name) = branch_details.strip_prefix("Initial commit on ") {
        Some(name.to_string())
    } else {
        let name = branch_details.split("...").next().unwrap_or(branch_details).trim();
        (!name.is_empty()).then_some(name.to_string())
    };
    let mut status = WorkspaceGitStatus {
        branch,
        ..WorkspaceGitStatus::default()
    };
    if let Some(summary) = details.split_once(" [").and_then(|(_, value)| value.strip_suffix(']')) {
        for item in summary.split(',').map(str::trim) {
            if let Some(value) = item.strip_prefix("ahead ") {
                status.ahead = value.parse().unwrap_or(0);
            } else if let Some(value) = item.strip_prefix("behind ") {
                status.behind = value.parse().unwrap_or(0);
            }
        }
    }

    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        if record.len() < 4 || record[2] != b' ' {
            return Err("git status returned a malformed file record".to_string());
        }
        let index = record[0] as char;
        let worktree = record[1] as char;
        let path = String::from_utf8_lossy(&record[3..]).into_owned();
        if index == '?' && worktree == '?' {
            add_unique(&mut status.untracked, path);
            continue;
        }
        if matches!((index, worktree), ('D', 'D') | ('A', 'U') | ('U', 'D') | ('U', 'A') | ('D', 'U') | ('A', 'A') | ('U', 'U')) {
            add_unique(&mut status.conflicted, path.clone());
            // Unmerged entries form their own category. Keeping them out of
            // staged/modified avoids double-counting a conflict in the UI.
            continue;
        }
        if index != ' ' && index != '?' {
            add_unique(&mut status.staged, path.clone());
        }
        if worktree != ' ' && worktree != '?' {
            add_unique(&mut status.modified, path.clone());
        }
        if matches!(index, 'R' | 'C') || matches!(worktree, 'R' | 'C') {
            // `-z` emits the original rename/copy path as the following
            // record. Consume it so it cannot be mistaken for a new status.
            let _ = records.next();
        }
    }
    status.staged.sort_unstable();
    status.modified.sort_unstable();
    status.untracked.sort_unstable();
    status.conflicted.sort_unstable();
    Ok(status)
}

fn git_status_for_directory(cwd: &Path) -> Result<WorkspaceGitStatus, String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(["status", "--porcelain=v1", "-z", "-b", "--untracked-files=all"])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .map_err(|error| format!("failed to start git: {}", error))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            "directory is not a git repository".to_string()
        } else {
            format!("git status failed: {}", detail)
        });
    }
    parse_git_status(&output.stdout)
}

#[tauri::command(async)]
pub fn git_status(
    store: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
) -> Result<WorkspaceGitStatus, String> {
    let cwd = {
        let store = store.lock().map_err(|error| error.to_string())?;
        store
            .workspaces
            .iter()
            .find(|workspace| workspace.id == workspace_id)
            .map(|workspace| workspace.cwd.clone())
            .ok_or_else(|| format!("workspace {} not found", workspace_id))?
    };
    git_status_for_directory(Path::new(&cwd))
}

/// Current git branch for a workspace directory, or the short commit hash
/// when HEAD is detached. None when the directory is not a git work tree.
#[tauri::command(async)]
pub fn git_branch(cwd: String) -> Option<String> {
    fn git(cwd: &str, args: &[&str]) -> Option<String> {
        let mut cmd = std::process::Command::new("git");
        cmd.arg("-C")
            .arg(cwd)
            .args(args)
            .env("GIT_OPTIONAL_LOCKS", "0")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let out = cmd.output().ok()?;
        if !out.status.success() {
            return None;
        }
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    }
    git(&cwd, &["branch", "--show-current"])
        .or_else(|| git(&cwd, &["rev-parse", "--short", "HEAD"]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::AtomicU64;

    static TEST_PATH_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn test_path(label: &str) -> PathBuf {
        let id = TEST_PATH_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "terra-swarm-workspace-{label}-{}-{id}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("test directory");
        directory.join("workspaces.json")
    }

    fn cleanup(path: &std::path::Path) {
        if let Some(parent) = path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }

    #[test]
    fn lists_workspace_relative_metadata_with_a_bound_and_rejects_escape() {
        let path = test_path("files");
        let root = path.parent().expect("test root");
        fs::create_dir_all(root.join("src")).expect("src directory");
        fs::write(root.join("README.md"), "contents stay unread by the command").expect("file");
        fs::write(root.join("src/main.rs"), "fn main() {}").expect("nested file");

        let listing = list_directory_entries(root, None, Some(1)).expect("listing");
        assert_eq!(listing.path, "");
        assert_eq!(listing.entries.len(), 1);
        assert!(listing.truncated);
        assert_eq!(listing.entries[0].kind, "directory");
        assert_eq!(listing.entries[0].path, "src");
        assert!(safe_relative_path(Some("../outside")).is_err());
        assert!(list_directory_entries(root, Some("src/../../"), None).is_err());
        cleanup(&path);
    }

    #[test]
    fn parses_structured_git_status_categories() {
        let raw = b"## main...origin/main [ahead 2, behind 1]\0M  src/main.rs\0 M README.md\0?? new.txt\0UU conflict.txt\0";
        let status = parse_git_status(raw).expect("git status");
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.ahead, 2);
        assert_eq!(status.behind, 1);
        assert_eq!(status.staged, vec!["src/main.rs"]);
        assert_eq!(status.modified, vec!["README.md"]);
        assert_eq!(status.untracked, vec!["new.txt"]);
        assert_eq!(status.conflicted, vec!["conflict.txt"]);
    }

    fn workspace(id: &str) -> Workspace {
        Workspace {
            id: id.to_string(),
            name: format!("Workspace {id}"),
            cwd: "/tmp".to_string(),
            terminals: vec![TerminalMeta {
                id: format!("{id}-terminal"),
                command: "shell".to_string(),
                width: None,
                pane_id: None,
                tab_id: None,
                group_id: None,
                suspended: false,
            }],
            group_id: None,
            panes: Vec::new(),
            containers: Vec::new(),
            active_pane_id: None,
            active_container_id: None,
            collapsed: false,
            archived: false,
            created_at: None,
            layout_mode: None,
            layout: None,
        }
    }

    #[test]
    fn saves_the_current_versioned_envelope() {
        let path = test_path("current");
        let store = WorkspaceStore {
            workspaces: vec![workspace("ws-current")],
            groups: Vec::new(),
            save_path: Some(path.clone()),
        };

        store.save_now();

        let value: Value = serde_json::from_str(&fs::read_to_string(&path).expect("store"))
            .expect("versioned store JSON");
        assert_eq!(value["version"], Value::from(WORKSPACE_FILE_VERSION));
        assert_eq!(value["workspaces"].as_array().map(Vec::len), Some(1));
        cleanup(&path);
    }

    #[test]
    fn loads_legacy_array_and_migrates_it_on_startup() {
        let path = test_path("legacy");
        let expected = workspace("ws-legacy");
        fs::write(
            &path,
            serde_json::to_string(&vec![expected.clone()]).expect("legacy JSON"),
        )
        .expect("legacy store");

        let store = WorkspaceStore::load(path.clone());

        assert_eq!(store.workspaces, vec![expected]);
        let value: Value =
            serde_json::from_str(&fs::read_to_string(&path).expect("migrated store"))
                .expect("migrated JSON");
        assert_eq!(value["version"], Value::from(WORKSPACE_FILE_VERSION));
        assert!(value["workspaces"].is_array());
        cleanup(&path);
    }

    #[test]
    fn loads_v1_envelope_and_migrates_to_v2_without_losing_terminal_metadata() {
        let path = test_path("v1");
        let expected = workspace("ws-v1");
        let raw = serde_json::json!({
            "version": LEGACY_WORKSPACE_FILE_VERSION,
            "workspaces": [{
                "id": expected.id,
                "name": expected.name,
                "cwd": expected.cwd,
                "terminals": [{
                    "id": "t-v1",
                    "command": "shell",
                    "width": 42.0
                }]
            }]
        });
        fs::write(&path, serde_json::to_string(&raw).expect("v1 JSON")).expect("v1 store");

        let store = WorkspaceStore::load(path.clone());

        assert_eq!(store.workspaces.len(), 1);
        assert_eq!(store.workspaces[0].id, "ws-v1");
        assert_eq!(store.workspaces[0].terminals[0].id, "t-v1");
        assert_eq!(store.workspaces[0].terminals[0].width, Some(42.0));
        assert!(store.groups.is_empty());
        let persisted: Value =
            serde_json::from_str(&fs::read_to_string(&path).expect("migrated v2 store"))
                .expect("migrated v2 JSON");
        assert_eq!(persisted["version"], Value::from(WORKSPACE_FILE_VERSION));
        assert!(persisted["groups"].is_array());
        cleanup(&path);
    }

    #[test]
    fn group_lifecycle_preserves_projects_and_terminal_metadata() {
        let mut store = WorkspaceStore {
            workspaces: vec![workspace("ws-group")],
            groups: Vec::new(),
            save_path: None,
        };
        let group = store.create_group(" Agents ".to_string());
        let serialized = serde_json::to_value(&group).expect("group JSON");
        assert_eq!(serialized["projectIds"], Value::Array(Vec::new()));
        let snake_group: Group = serde_json::from_value(serde_json::json!({
            "id": "group-snake",
            "name": "Snake",
            "project_ids": ["ws-group"]
        }))
        .expect("snake group aliases");
        assert_eq!(snake_group.project_ids, vec!["ws-group"]);
        store.workspaces[0].group_id = Some(group.id.clone());
        store.groups[0].project_ids.push("ws-group".to_string());
        store
            .set_terminal_placement(
                "ws-group",
                "ws-group-terminal",
                "pane-group".to_string(),
                "tab-group".to_string(),
            )
            .expect("placement");

        store
            .rename_group(&group.id, "Workers".to_string())
            .expect("rename");
        let suspended = store.suspend_group(&group.id).expect("suspend");
        assert_eq!(suspended, vec!["ws-group-terminal"]);
        assert_eq!(store.groups[0].name, "Workers");
        assert!(store.groups[0].suspended);
        assert!(store.workspaces[0].terminals[0].suspended);
        assert!(store.workspaces[0].panes[0].tabs[0].suspended);
        assert_eq!(
            store.workspaces[0].group_id.as_deref(),
            Some(group.id.as_str())
        );
        assert_eq!(store.workspaces[0].terminals.len(), 1);

        store.resume_group(&group.id).expect("resume");
        assert!(!store.groups[0].suspended);
        store.remove_group(&group.id).expect("remove");
        assert!(store.groups.is_empty());
        assert!(store.workspaces[0].group_id.is_none());
        assert_eq!(store.workspaces[0].terminals.len(), 1);
    }

    #[test]
    fn workspace_group_assignment_keeps_both_sides_consistent() {
        let mut store = WorkspaceStore {
            workspaces: vec![workspace("ws-assign")],
            groups: vec![
                Group {
                    id: "group-a".to_string(),
                    name: "A".to_string(),
                    color: None,
                    icon_url: None,
                    collapsed: false,
                    project_ids: vec!["ws-assign".to_string(), "ws-assign".to_string()],
                    parent_group_id: None,
                    layout_mode: None,
                    suspended: false,
                    archived: false,
                    created_at: None,
                },
                Group {
                    id: "group-b".to_string(),
                    name: "B".to_string(),
                    color: None,
                    icon_url: None,
                    collapsed: false,
                    project_ids: vec!["ws-assign".to_string()],
                    parent_group_id: None,
                    layout_mode: None,
                    suspended: false,
                    archived: false,
                    created_at: None,
                },
            ],
            save_path: None,
        };

        store
            .set_workspace_group("ws-assign", Some("group-a".to_string()))
            .expect("assign");
        assert_eq!(store.workspaces[0].group_id.as_deref(), Some("group-a"));
        assert_eq!(
            store.workspaces[0].terminals[0].group_id.as_deref(),
            Some("group-a")
        );
        assert_eq!(store.groups[0].project_ids, vec!["ws-assign"]);
        assert!(store.groups[1].project_ids.is_empty());

        store
            .set_workspace_group("ws-assign", None)
            .expect("unassign");
        assert!(store.workspaces[0].group_id.is_none());
        assert!(store.workspaces[0].terminals[0].group_id.is_none());
        assert!(store
            .groups
            .iter()
            .all(|group| group.project_ids.is_empty()));
    }

    #[test]
    fn terminal_placement_creates_and_normalizes_pane_and_tab_metadata() {
        let mut store = WorkspaceStore {
            workspaces: vec![workspace("ws-place")],
            groups: Vec::new(),
            save_path: None,
        };

        store
            .set_terminal_placement(
                "ws-place",
                "ws-place-terminal",
                "pane-one".to_string(),
                "tab-one".to_string(),
            )
            .expect("first placement");
        assert_eq!(
            store.workspaces[0].terminals[0].pane_id.as_deref(),
            Some("pane-one")
        );
        assert_eq!(
            store.workspaces[0].terminals[0].tab_id.as_deref(),
            Some("tab-one")
        );
        assert_eq!(store.workspaces[0].panes.len(), 1);
        assert_eq!(
            store.workspaces[0].panes[0].active_tab_id.as_deref(),
            Some("tab-one")
        );
        assert_eq!(
            store.workspaces[0].panes[0].tabs[0].pty_id.as_deref(),
            Some("ws-place-terminal")
        );

        store
            .set_terminal_placement(
                "ws-place",
                "ws-place-terminal",
                "pane-two".to_string(),
                "tab-two".to_string(),
            )
            .expect("second placement");
        assert_eq!(store.workspaces[0].panes[0].tabs.len(), 0);
        assert_eq!(store.workspaces[0].panes[1].id, "pane-two");
        assert_eq!(store.workspaces[0].panes[1].tabs.len(), 1);
        assert_eq!(store.workspaces[0].panes[1].tabs[0].id, "tab-two");

        store
            .set_active_pane("ws-place", Some("pane-two".to_string()))
            .expect("active pane");
        assert_eq!(
            store.workspaces[0].active_pane_id.as_deref(),
            Some("pane-two")
        );
        store
            .set_active_pane("ws-place", None)
            .expect("clear active pane");
        assert!(store.workspaces[0].active_pane_id.is_none());
    }

    #[test]
    fn recovers_valid_entries_and_preserves_a_backup_for_invalid_data() {
        let path = test_path("invalid");
        let mut first = workspace("ws-one");
        first.terminals[0].width = Some(1000.0);
        first.terminals.push(TerminalMeta {
            id: first.terminals[0].id.clone(),
            command: "duplicate".to_string(),
            width: Some(-5.0),
            pane_id: None,
            tab_id: None,
            group_id: None,
            suspended: false,
        });
        let mut duplicate_workspace = workspace("ws-one");
        duplicate_workspace.name = "duplicate workspace".to_string();
        let empty_id = Workspace {
            id: "   ".to_string(),
            name: "invalid".to_string(),
            cwd: "/tmp".to_string(),
            terminals: Vec::new(),
            group_id: None,
            panes: Vec::new(),
            containers: Vec::new(),
            active_pane_id: None,
            active_container_id: None,
            collapsed: false,
            archived: false,
            created_at: None,
            layout_mode: None,
            layout: None,
        };
        let malformed = serde_json::json!({"id": "missing required fields"});
        let content = serde_json::json!({
            "version": WORKSPACE_FILE_VERSION,
            "workspaces": [first, duplicate_workspace, empty_id, malformed],
        });
        fs::write(&path, serde_json::to_string(&content).expect("store JSON"))
            .expect("invalid store");

        let store = WorkspaceStore::load(path.clone());

        assert_eq!(store.workspaces.len(), 1);
        assert_eq!(store.workspaces[0].id, "ws-one");
        assert_eq!(store.workspaces[0].terminals.len(), 1);
        assert_eq!(store.workspaces[0].terminals[0].width, Some(100.0));
        assert!(path.with_extension("json.bak").exists());
        let persisted: Value =
            serde_json::from_str(&fs::read_to_string(&path).expect("normalized store"))
                .expect("normalized JSON");
        assert_eq!(persisted["version"], Value::from(WORKSPACE_FILE_VERSION));
        cleanup(&path);
    }

    #[test]
    fn deduplicates_terminal_ids_across_workspaces_without_touching_scrollback() {
        let path = test_path("cross-workspace-terminal-ids");
        let scrollback_dir = path
            .parent()
            .expect("workspace directory")
            .join("scrollback");
        fs::create_dir_all(&scrollback_dir).expect("scrollback directory");
        let scrollback_path = scrollback_dir.join("shared-terminal.scrollback");
        fs::write(&scrollback_path, b"valid durable output").expect("scrollback");

        let mut first = workspace("ws-first");
        first.terminals[0].id = "shared-terminal".to_string();
        let mut second = workspace("ws-second");
        second.terminals[0].id = "shared-terminal".to_string();
        let content = serde_json::json!({
            "version": WORKSPACE_FILE_VERSION,
            "workspaces": [first, second],
        });
        fs::write(&path, serde_json::to_string(&content).expect("store JSON"))
            .expect("workspace store");

        let mut store = WorkspaceStore::load(path.clone());

        assert_eq!(store.workspaces.len(), 2);
        assert_eq!(store.workspaces[0].terminals.len(), 1);
        assert_eq!(store.workspaces[1].terminals.len(), 0);
        assert_eq!(store.terminal_owner("shared-terminal"), Some("ws-first"));
        assert!(path.with_extension("json.bak").exists());
        assert_eq!(
            fs::read(&scrollback_path).expect("preserved scrollback"),
            b"valid durable output"
        );

        // A destructive terminal removal now has exactly one owner to act
        // on; the quarantined duplicate cannot make a second workspace match.
        store.remove_terminal("shared-terminal");
        assert!(store
            .workspaces
            .iter()
            .all(|workspace| workspace.terminals.is_empty()));
        assert_eq!(
            fs::read(&scrollback_path).expect("scrollback remains"),
            b"valid durable output"
        );

        cleanup(&path);
    }

    #[test]
    fn corrupt_json_is_backed_up_without_being_overwritten() {
        let path = test_path("corrupt");
        fs::write(&path, "not valid JSON").expect("corrupt store");

        let store = WorkspaceStore::load(path.clone());

        assert!(store.workspaces.is_empty());
        assert!(!path.exists());
        assert!(path.with_extension("json.bak").exists());
        cleanup(&path);
    }

    #[test]
    fn reorder_workspaces_is_stable_and_ignores_unknown_or_duplicate_ids() {
        let first = workspace("ws-one");
        let second = workspace("ws-two");
        let mut store = WorkspaceStore {
            workspaces: vec![first, second],
            groups: Vec::new(),
            save_path: None,
        };

        store.reorder_workspaces(&[
            "ws-two".to_string(),
            "unknown".to_string(),
            "ws-two".to_string(),
        ]);
        assert_eq!(
            store
                .workspaces
                .iter()
                .map(|workspace| workspace.id.as_str())
                .collect::<Vec<_>>(),
            vec!["ws-two", "ws-one"]
        );
    }

    #[test]
    fn visual_layout_operations_are_durable_and_never_remove_ptys() {
        let mut first = workspace("ws-layout");
        first.terminals.push(TerminalMeta {
            id: "ws-layout-terminal-two".to_string(),
            command: "worker".to_string(),
            width: None,
            pane_id: None,
            tab_id: None,
            group_id: None,
            suspended: false,
        });
        let mut store = WorkspaceStore {
            workspaces: vec![first],
            groups: Vec::new(),
            save_path: None,
        };
        store
            .set_terminal_placement(
                "ws-layout",
                "ws-layout-terminal",
                "pane-one".to_string(),
                "tab-one".to_string(),
            )
            .expect("first pane placement");
        store
            .set_terminal_placement(
                "ws-layout",
                "ws-layout-terminal-two",
                "pane-two".to_string(),
                "tab-two".to_string(),
            )
            .expect("second pane placement");
        let first_container_id = store.workspaces[0].containers[0].id.clone();
        store.workspaces[0].containers.push(WorkspaceStore::new_container(
            "ws-layout",
            "container-secondary".to_string(),
        ));
        store
            .reorder_panes(
                "ws-layout",
                &first_container_id,
                &["pane-two".to_string(), "pane-one".to_string()],
            )
            .expect("pane reorder");
        store
            .move_pane(
                "ws-layout",
                "pane-two",
                "container-secondary",
                Some(0),
            )
            .expect("pane move");
        store
            .set_container_state(
                "ws-layout",
                "container-secondary",
                WorkspaceContainerPatch {
                    collapsed: Some(true),
                    fullscreen: Some(true),
                    active_pane_id: Some("pane-two".to_string()),
                    internal_layout: Some("vertical".to_string()),
                    size: Some(42.0),
                    ..WorkspaceContainerPatch::default()
                },
            )
            .expect("container state");
        store
            .set_layout(
                "ws-layout",
                WorkspaceLayout {
                    mode: "spotlight".to_string(),
                    item_ids: vec![
                        first_container_id.clone(),
                        "container-secondary".to_string(),
                    ],
                    sizes: HashMap::from([
                        (first_container_id.clone(), 60.0),
                        ("container-secondary".to_string(), 40.0),
                    ]),
                    ..WorkspaceLayout::default()
                },
            )
            .expect("workspace layout");
        store
            .set_collapsed("ws-layout", true)
            .expect("workspace collapse");

        let workspace = &store.workspaces[0];
        assert_eq!(workspace.terminals.len(), 2);
        assert_eq!(workspace.layout_mode.as_deref(), Some("spotlight"));
        assert!(workspace.collapsed);
        assert_eq!(workspace.containers[1].pane_ids, vec!["pane-two"]);
        assert!(workspace.containers[1].collapsed);
        assert!(workspace.containers[1].fullscreen);
        assert_eq!(workspace.containers[1].active_pane_id.as_deref(), Some("pane-two"));
        assert_eq!(workspace.containers[1].internal_layout, "vertical");
        assert_eq!(workspace.panes[1].container_id.as_deref(), Some("container-secondary"));
        let serialized = store.serialized_snapshot().expect("layout JSON");
        let value: Value = serde_json::from_str(&serialized).expect("serialized JSON");
        assert_eq!(value["workspaces"][0]["layout"]["mode"], "spotlight");
        assert_eq!(
            value["workspaces"][0]["containers"][1]["activePaneId"],
            "pane-two"
        );
    }

    #[test]
    fn set_width_rejects_non_finite_values_and_clamps_finite_values() {
        let mut store = WorkspaceStore {
            workspaces: vec![workspace("ws-width")],
            groups: Vec::new(),
            save_path: None,
        };
        let terminal_id = store.workspaces[0].terminals[0].id.clone();

        store.set_width("ws-width", &terminal_id, f64::NAN);
        assert_eq!(store.workspaces[0].terminals[0].width, None);
        store.set_width("ws-width", &terminal_id, f64::INFINITY);
        assert_eq!(store.workspaces[0].terminals[0].width, None);
        store.set_width("ws-width", &terminal_id, 1.0);
        assert_eq!(
            store.workspaces[0].terminals[0].width,
            Some(MIN_TERMINAL_WIDTH)
        );
    }

    #[test]
    fn snapshot_roundtrip_preserves_layout_but_suspends_imported_sessions() {
        let source = test_path("transfer-roundtrip-source");
        let mut original = WorkspaceStore {
            workspaces: vec![workspace("ws-transfer")],
            groups: Vec::new(),
            save_path: None,
        };
        let group = original.create_group("Imported agents".to_string());
        original
            .set_workspace_group("ws-transfer", Some(group.id.clone()))
            .expect("group assignment");
        original
            .set_terminal_placement(
                "ws-transfer",
                "ws-transfer-terminal",
                "pane-transfer".to_string(),
                "tab-transfer".to_string(),
            )
            .expect("terminal placement");
        let json = original.serialized_snapshot().expect("snapshot JSON");
        write_atomic(&source, &json).expect("write source snapshot");

        let raw = fs::read_to_string(&source).expect("source snapshot");
        let mut imported = parse_import_snapshot(&raw).expect("strict roundtrip parse");
        assert_eq!(imported.workspaces, original.workspaces);
        assert_eq!(imported.groups, original.groups);
        mark_imported_sessions_suspended(&mut imported);
        assert!(imported.workspaces[0].terminals[0].suspended);
        assert!(imported.workspaces[0].panes[0].tabs[0].suspended);
        assert_eq!(
            imported.workspaces[0].panes[0].tabs[0].pty_id.as_deref(),
            Some("ws-transfer-terminal")
        );
        assert_eq!(transfer_counts(&imported).3, 1);
        cleanup(&source);
    }

    #[test]
    fn import_rejects_unknown_versions_before_replacing_state() {
        let raw = serde_json::json!({
            "version": WORKSPACE_FILE_VERSION + 1,
            "workspaces": [],
            "groups": []
        });
        assert!(
            parse_import_snapshot(&serde_json::to_string(&raw).expect("version JSON")).is_err()
        );
    }

    #[test]
    fn import_rejects_malformed_json_and_entries() {
        assert!(parse_import_snapshot("{not json").is_err());
        let malformed_entry = serde_json::json!({
            "version": WORKSPACE_FILE_VERSION,
            "workspaces": [{"id": "missing required metadata"}],
            "groups": []
        });
        assert!(parse_import_snapshot(
            &serde_json::to_string(&malformed_entry).expect("malformed entry JSON")
        )
        .is_err());
    }

    #[test]
    fn replacing_store_keeps_a_recoverable_backup_and_current_file_atomic() {
        let current = test_path("transfer-backup");
        fs::write(&current, "previous workspace file").expect("current store");
        let replacement = WorkspaceStore {
            workspaces: vec![workspace("ws-imported")],
            groups: Vec::new(),
            save_path: None,
        };
        let json = replacement.serialized_snapshot().expect("replacement JSON");

        let backup = replace_store_file(&current, &json)
            .expect("replace store")
            .expect("backup path");
        assert_eq!(
            fs::read_to_string(&backup).expect("backup content"),
            "previous workspace file"
        );
        let loaded: Value =
            serde_json::from_str(&fs::read_to_string(&current).expect("new current store"))
                .expect("new current JSON");
        assert_eq!(loaded["version"], Value::from(WORKSPACE_FILE_VERSION));
        assert_eq!(loaded["workspaces"][0]["id"], Value::from("ws-imported"));
        let temp_prefix = format!(
            ".{}.tmp-{}-",
            current
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(""),
            std::process::id()
        );
        let leftover_temp = fs::read_dir(current.parent().expect("current parent"))
            .expect("current directory")
            .filter_map(Result::ok)
            .any(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(&temp_prefix)
            });
        assert!(!leftover_temp);
        cleanup(&current);
    }

    #[test]
    fn explicit_snapshot_paths_reject_relative_and_traversal_input() {
        assert!(validate_explicit_path("snapshot.json").is_err());
        assert!(validate_explicit_path("/tmp/../snapshot.json").is_err());
        assert!(validate_explicit_path("\0snapshot.json").is_err());
    }
}
