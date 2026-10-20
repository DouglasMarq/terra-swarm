//! `workspaces.json` on disk: versioned envelope, forgiving decode,
//! debounced atomic writes and `.bak` copies of anything it had to drop.

use super::*;
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

/// Version of the on-disk workspace envelope.  The contents of the envelope
/// are intentionally kept separate from `WorkspaceStore`: the latter also
/// carries runtime-only state such as the save path.
pub(crate) const WORKSPACE_FILE_VERSION: u32 = 2;

pub(crate) const LEGACY_WORKSPACE_FILE_VERSION: u32 = 1;

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
pub(crate) fn write_atomic(path: &std::path::Path, json: &str) -> std::io::Result<()> {
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

/// Move an existing store out of the way before normalizing it.  The first
/// backup keeps the historical `workspaces.json.bak` name; subsequent
/// recoveries get a numbered suffix instead of replacing an earlier backup.
pub(crate) fn backup_store(path: &std::path::Path) -> std::io::Result<Option<PathBuf>> {
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

/// Replace the active on-disk store while preserving a recoverable copy of
/// the previous file.  The lock also fences out an older debounced save, and
/// the rollback path restores the backup if the atomic write fails.
pub(crate) fn replace_store_file(path: &Path, json: &str) -> Result<Option<PathBuf>, String> {
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
pub(crate) fn save_channel() -> &'static Sender<SaveRequest> {
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

impl WorkspaceStore {
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

    pub(crate) fn serialized_snapshot(&self) -> Result<String, serde_json::Error> {
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
}
