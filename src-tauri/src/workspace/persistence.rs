//! `workspaces.json` on disk: versioned envelope, forgiving decode,
//! debounced atomic writes and `.bak` copies of anything it had to drop.

use super::*;
use crate::sync::LockExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

pub(crate) struct SaveRequest {
    path: PathBuf,
    json: String,
    seq: u64,
}

pub(crate) static SAVE_TX: OnceLock<Sender<SaveRequest>> = OnceLock::new();

pub(crate) static SAVE_SEQ: AtomicU64 = AtomicU64::new(0);

pub(crate) static LAST_WRITTEN: OnceLock<Mutex<HashMap<PathBuf, u64>>> = OnceLock::new();

pub(crate) static WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub(crate) static ATOMIC_TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Quiet time after the last change before the debounced save writes.
const SAVE_DEBOUNCE: Duration = Duration::from_millis(150);

/// Version of the on-disk workspace envelope.  The contents of the envelope
/// are intentionally kept separate from `WorkspaceStore`: the latter also
/// carries runtime-only state such as the save path.
pub(crate) const WORKSPACE_FILE_VERSION: u32 = 2;

pub(crate) const LEGACY_WORKSPACE_FILE_VERSION: u32 = 1;

const DEFAULT_STORE_FILE_NAME: &str = "workspaces.json";

const DEFAULT_SNAPSHOT_FILE_NAME: &str = "workspace-snapshot";

const FIRST_NUMBERED_BACKUP: u64 = 1;

#[derive(Serialize, Deserialize)]
pub(crate) struct WorkspaceFile {
    version: u32,
    #[serde(default)]
    workspaces: Vec<Workspace>,
    #[serde(default)]
    groups: Vec<Group>,
}

pub(crate) struct DecodedWorkspaceFile {
    pub(crate) workspaces: Vec<Workspace>,
    pub(crate) groups: Vec<Group>,
    /// A JSON array is the format used before the versioned envelope existed.
    pub(crate) legacy: bool,
    /// Entries which could not be deserialized are dropped individually so a
    /// single damaged workspace cannot make all the other workspaces vanish.
    pub(crate) dropped_entries: bool,
}

/// Decode both the current envelope and the pre-envelope array format.
///
/// Parsing through `serde_json::Value` here is deliberate.  Deserializing a
/// `Vec<Workspace>` directly would reject the whole file when one entry is
/// malformed, which is needlessly destructive for a local preferences file.
/// Valid entries are recovered and the caller can retain a backup before
/// writing the normalized result.
pub(crate) fn decode_workspace_file(raw: &str) -> Result<DecodedWorkspaceFile, String> {
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

pub(crate) fn decode_workspace_entries(entries: Vec<Value>) -> (Vec<Workspace>, bool) {
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

pub(crate) fn decode_group_entries(entries: Vec<Value>) -> (Vec<Group>, bool) {
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
pub(crate) fn write_guarded(path: &std::path::Path, json: &str, seq: u64) {
    if let Err(e) = write_guarded_result(path, json, seq) {
        eprintln!("failed to save workspaces: {}", e);
    }
}

/// Synchronous variant used by portability commands.  The regular debounced
/// writer intentionally logs failures because it runs off-thread; explicit
/// import/export must return the failure to the caller instead.
pub(crate) fn write_guarded_result(path: &Path, json: &str, seq: u64) -> std::io::Result<()> {
    let lock = WRITE_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock_or_recover();
    let last_written = LAST_WRITTEN.get_or_init(|| Mutex::new(HashMap::new()));
    let mut last_written = last_written.lock_or_recover();
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
pub(crate) fn write_atomic(path: &std::path::Path, json: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(DEFAULT_SNAPSHOT_FILE_NAME);
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
        match std::fs::remove_file(&tmp) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                eprintln!("failed to remove {}: {}", tmp.display(), error);
            }
            _ => {}
        }
    }
    result
}

pub(crate) fn modified_millis(path: &Path) -> Option<u64> {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(crate::clock::epoch_millis)
}

pub(crate) fn read_snapshot_file(path: &Path) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|error| {
        format!(
            "failed to read workspace snapshot {}: {}",
            path.display(),
            error
        )
    })
}

/// Move an existing store out of the way before normalizing it.  The first
/// backup keeps the historical `workspaces.json.bak` name; subsequent
/// recoveries get a numbered suffix instead of replacing an earlier backup.
pub(crate) fn backup_store(path: &std::path::Path) -> std::io::Result<Option<PathBuf>> {
    if !path.exists() {
        return Ok(None);
    }

    let target = free_backup_path(path);
    std::fs::rename(path, &target).map(|()| Some(target))
}

fn free_backup_path(path: &Path) -> PathBuf {
    let backup = path.with_extension("json.bak");
    if !backup.exists() {
        return backup;
    }
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(DEFAULT_STORE_FILE_NAME);
    let mut index = FIRST_NUMBERED_BACKUP;
    loop {
        let candidate = path.with_file_name(format!("{}.bak-{}", file_name, index));
        if !candidate.exists() {
            return candidate;
        }
        index = index.saturating_add(1);
    }
}

/// Replace the active on-disk store while preserving a recoverable copy of
/// the previous file.  The lock also fences out an older debounced save, and
/// the rollback path restores the backup if the atomic write fails.
pub(crate) fn replace_store_file(path: &Path, json: &str) -> Result<Option<PathBuf>, String> {
    let lock = WRITE_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock_or_recover();
    let backup = backup_store(path).map_err(|error| {
        format!(
            "failed to back up the current workspace store {}: {}",
            path.display(),
            error
        )
    })?;
    if let Err(error) = write_atomic(path, json) {
        return Err(match restore_backup(backup.as_deref(), path) {
            Ok(()) => format!("failed to write imported workspace store: {}", error),
            Err(restore_error) => format!(
                "failed to write imported workspace store ({}); {}",
                error, restore_error
            ),
        });
    }

    let seq = next_save_seq();
    LAST_WRITTEN
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock_or_recover()
        .insert(path.to_path_buf(), seq);
    Ok(backup)
}

fn restore_backup(backup: Option<&Path>, path: &Path) -> Result<(), String> {
    let Some(backup_path) = backup else {
        return Ok(());
    };
    std::fs::rename(backup_path, path).map_err(|restore_error| {
        format!(
            "backup restore also failed ({}): {}",
            restore_error,
            backup_path.display()
        )
    })
}

fn next_save_seq() -> u64 {
    SAVE_SEQ.fetch_add(1, Ordering::SeqCst) + 1
}

/// Background writer: coalesces a burst of save requests into the newest one
/// and flushes it to disk `SAVE_DEBOUNCE` after the last change, so mutations
/// never do blocking disk I/O on a caller thread.
pub(crate) fn save_channel() -> &'static Sender<SaveRequest> {
    SAVE_TX.get_or_init(|| {
        let (tx, rx) = channel::<SaveRequest>();
        std::thread::spawn(move || {
            while let Ok(mut req) = rx.recv() {
                while let Ok(newer) = rx.recv_timeout(SAVE_DEBOUNCE) {
                    req = newer;
                }
                write_guarded(&req.path, &req.json, req.seq);
            }
        });
        tx
    })
}

/// Never silently wipe the user's data: keep an unusable store around for
/// inspection instead of overwriting it.
fn back_up_unusable_store(path: &Path) {
    if let Err(error) = backup_store(path) {
        eprintln!("failed to back up unusable workspaces store: {}", error);
    }
}

struct LoadedStore {
    store: WorkspaceStore,
    is_legacy: bool,
    has_dropped_entries: bool,
    is_unusable: bool,
}

impl LoadedStore {
    fn empty(save_path: Option<PathBuf>) -> Self {
        Self {
            store: WorkspaceStore {
                workspaces: Vec::new(),
                groups: Vec::new(),
                save_path,
            },
            is_legacy: false,
            has_dropped_entries: false,
            is_unusable: false,
        }
    }

    fn unusable(path: &Path) -> Self {
        Self {
            is_unusable: true,
            ..Self::empty(Some(path.to_path_buf()))
        }
    }
}

fn read_store(path: &Path) -> LoadedStore {
    match std::fs::read_to_string(path) {
        Ok(raw) => decode_store(path, &raw),
        Err(error) => unreadable_store(path, error),
    }
}

fn decode_store(path: &Path, raw: &str) -> LoadedStore {
    let decoded = match decode_workspace_file(raw) {
        Ok(decoded) => decoded,
        Err(error) => {
            eprintln!(
                "workspaces store is corrupt ({}); backing up to .bak and starting fresh",
                error
            );
            return LoadedStore::unusable(path);
        }
    };
    LoadedStore {
        store: WorkspaceStore {
            workspaces: decoded.workspaces,
            groups: decoded.groups,
            save_path: Some(path.to_path_buf()),
        },
        is_legacy: decoded.legacy,
        has_dropped_entries: decoded.dropped_entries,
        is_unusable: false,
    }
}

fn unreadable_store(path: &Path, error: std::io::Error) -> LoadedStore {
    match error.kind() {
        std::io::ErrorKind::NotFound => LoadedStore::empty(Some(path.to_path_buf())),
        std::io::ErrorKind::InvalidData => {
            eprintln!(
                "workspaces store is not UTF-8 ({}); backing up to .bak and starting fresh",
                error
            );
            LoadedStore::unusable(path)
        }
        _ => {
            eprintln!(
                "cannot read the workspaces store {} ({}); leaving it untouched and not saving this session",
                path.display(),
                error
            );
            LoadedStore::empty(None)
        }
    }
}

impl WorkspaceStore {
    /// Load the store at `path`. A missing file starts empty; a file that
    /// cannot be decoded is backed up and replaced; a file that cannot be
    /// read at all is left untouched and this session never saves over it.
    pub fn load(path: PathBuf) -> Self {
        let loaded = read_store(&path);
        if loaded.is_unusable {
            back_up_unusable_store(&path);
        }
        let mut store = loaded.store;

        // Normalize loaded data before it can reach the UI or PTY layer.  If
        // normalization discarded anything, retain the original file before
        // writing the canonical representation.  A legacy array is migrated
        // on load so future app versions only need to understand the envelope.
        let should_back_up = loaded.has_dropped_entries || !store.is_normalized();
        store.normalize();
        for group in &store.groups {
            bump_next_group_id(&group.id);
        }
        if should_back_up {
            store.back_up_before_rewrite();
        }
        if loaded.is_legacy || should_back_up {
            store.save_now();
        }
        store
    }

    fn back_up_before_rewrite(&self) {
        let Some(path) = &self.save_path else { return };
        if let Err(error) = backup_store(path) {
            eprintln!("failed to back up normalized workspaces store: {}", error);
        }
    }

    pub(crate) fn serialized_snapshot(&self) -> Result<String, serde_json::Error> {
        // Keep serialization resilient even if a caller has modified the
        // public `workspaces` field directly.  The store itself is left
        // untouched; only the persisted snapshot is normalized.
        let mut snapshot = Self {
            workspaces: self.workspaces.clone(),
            groups: self.groups.clone(),
            save_path: None,
        };
        snapshot.normalize();
        serde_json::to_string_pretty(&WorkspaceFile {
            version: WORKSPACE_FILE_VERSION,
            workspaces: snapshot.workspaces,
            groups: snapshot.groups,
        })
    }

    pub fn save(&self) {
        let Some(path) = &self.save_path else { return };
        let json = match self.serialized_snapshot() {
            Ok(json) => json,
            Err(error) => {
                eprintln!("failed to serialize workspaces: {}", error);
                return;
            }
        };
        let request = SaveRequest {
            path: path.clone(),
            json,
            seq: next_save_seq(),
        };
        if let Err(error) = save_channel().send(request) {
            eprintln!("failed to queue a workspaces save: {}", error);
        }
    }

    /// Synchronous, un-debounced save for shutdown, so the final state is
    /// never lost when the app exits within the `SAVE_DEBOUNCE` window.
    pub fn save_now(&self) {
        let Some(path) = &self.save_path else { return };
        match self.serialized_snapshot() {
            Ok(json) => {
                write_guarded(path, &json, next_save_seq());
            }
            Err(e) => eprintln!("failed to serialize workspaces on exit: {}", e),
        }
    }
}
