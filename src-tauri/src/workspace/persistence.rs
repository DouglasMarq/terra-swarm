use super::*;
use crate::sync::LockExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
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

const SAVE_DEBOUNCE: Duration = Duration::from_millis(150);

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
    pub(crate) legacy: bool,
    pub(crate) dropped_entries: bool,
}

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
                None => Vec::new(),
                Some(_) => {
                    return Err("workspace store workspaces must be an array".to_string());
                }
            };
            let (workspaces, dropped_entries) = decode_workspace_entries(entries);
            let (groups, dropped_groups) = match object.remove("groups") {
                Some(Value::Array(entries)) => decode_group_entries(entries),
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

pub(crate) fn write_guarded(path: &std::path::Path, json: &str, seq: u64) {
    if let Err(e) = write_guarded_result(path, json, seq) {
        eprintln!("failed to save workspaces: {}", e);
    }
}

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

pub(crate) fn next_save_seq() -> u64 {
    SAVE_SEQ.fetch_add(1, Ordering::SeqCst) + 1
}

pub(crate) fn save_channel() -> &'static Sender<SaveRequest> {
    SAVE_TX.get_or_init(|| {
        let (tx, rx) = channel::<SaveRequest>();
        std::thread::spawn(move || write_coalesced_saves(rx));
        tx
    })
}

fn write_coalesced_saves(rx: Receiver<SaveRequest>) {
    while let Some(burst) = next_save_burst(&rx) {
        for request in burst.into_values() {
            write_guarded(&request.path, &request.json, request.seq);
        }
    }
}

fn next_save_burst(rx: &Receiver<SaveRequest>) -> Option<HashMap<PathBuf, SaveRequest>> {
    let first = rx.recv().ok()?;
    let mut burst = HashMap::from([(first.path.clone(), first)]);
    while let Ok(newer) = rx.recv_timeout(SAVE_DEBOUNCE) {
        burst.insert(newer.path.clone(), newer);
    }
    Some(burst)
}

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
    pub fn load(path: PathBuf) -> Self {
        let loaded = read_store(&path);
        if loaded.is_unusable {
            back_up_unusable_store(&path);
        }
        let mut store = loaded.store;

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

#[cfg(test)]
mod tests {
    use super::*;

    fn save_request(path: &Path, json: &str) -> SaveRequest {
        SaveRequest {
            path: path.to_path_buf(),
            json: json.to_string(),
            seq: next_save_seq(),
        }
    }

    #[test]
    fn given_saves_for_two_paths_in_one_burst_when_the_writer_flushes_then_each_path_gets_its_latest_save(
    ) {
        let directory =
            std::env::temp_dir().join(format!("terra-swarm-save-burst-{}", std::process::id()));
        let first = directory.join("first.json");
        let second = directory.join("second.json");
        let (sender, receiver) = channel();
        sender.send(save_request(&first, "first-old")).unwrap();
        sender.send(save_request(&second, "second")).unwrap();
        sender.send(save_request(&first, "first-new")).unwrap();
        drop(sender);

        write_coalesced_saves(receiver);

        assert_eq!(std::fs::read_to_string(&first).unwrap(), "first-new");
        assert_eq!(std::fs::read_to_string(&second).unwrap(), "second");
        let _ = std::fs::remove_dir_all(directory);
    }
}
