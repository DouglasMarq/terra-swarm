use super::*;
use crate::sync::LockExt;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

pub(crate) const DEFAULT_FILE_LIST_LIMIT: usize = 200;

pub(crate) const MAX_FILE_LIST_LIMIT: usize = 400;

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
    pub is_truncated: bool,
    pub limit: usize,
}

pub(crate) fn safe_relative_path(value: Option<&str>) -> Result<PathBuf, String> {
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

pub(crate) fn relative_path_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

pub(crate) fn list_directory_entries(
    workspace_root: &Path,
    relative_path: Option<&str>,
    requested_limit: Option<usize>,
) -> Result<WorkspaceFileListing, String> {
    let limit = listing_limit(requested_limit)?;
    let root = workspace_root_directory(workspace_root)?;
    let relative = safe_relative_path(relative_path)?;
    let target = directory_inside(&root, &relative)?;
    let mut entries = read_entries(&target, &relative)?;
    entries.sort_by(compare_entries);
    let is_truncated = entries.len() > limit;
    entries.truncate(limit);
    Ok(WorkspaceFileListing {
        path: relative_path_string(&relative),
        entries,
        is_truncated,
        limit,
    })
}

const DIRECTORY_KIND: &str = "directory";

fn listing_limit(requested_limit: Option<usize>) -> Result<usize, String> {
    let limit = requested_limit.unwrap_or(DEFAULT_FILE_LIST_LIMIT);
    if limit == 0 {
        return Err("file listing limit must be greater than zero".to_string());
    }
    Ok(limit.min(MAX_FILE_LIST_LIMIT))
}

fn workspace_root_directory(workspace_root: &Path) -> Result<PathBuf, String> {
    let root = workspace_root
        .canonicalize()
        .map_err(|error| format!("workspace directory is unavailable: {}", error))?;
    if !root.is_dir() {
        return Err("workspace cwd is not a directory".to_string());
    }
    Ok(root)
}

fn directory_inside(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    let target = root
        .join(relative)
        .canonicalize()
        .map_err(|error| format!("directory is unavailable: {}", error))?;
    if !target.starts_with(root) {
        return Err("file path cannot escape the workspace".to_string());
    }
    if !target.is_dir() {
        return Err("requested file path is not a directory".to_string());
    }
    Ok(target)
}

fn read_entries(target: &Path, relative: &Path) -> Result<Vec<WorkspaceFileEntry>, String> {
    std::fs::read_dir(target)
        .map_err(|error| format!("cannot list directory: {}", error))?
        .map(|entry| {
            let entry = entry.map_err(|error| format!("cannot read directory entry: {}", error))?;
            file_entry(&entry, relative)
        })
        .collect()
}

fn file_entry(entry: &std::fs::DirEntry, relative: &Path) -> Result<WorkspaceFileEntry, String> {
    let metadata = std::fs::symlink_metadata(entry.path())
        .map_err(|error| format!("cannot inspect {}: {}", entry.path().display(), error))?;
    let file_type = metadata.file_type();
    let name = entry.file_name().to_string_lossy().into_owned();
    let child_path = if relative.as_os_str().is_empty() {
        PathBuf::from(&name)
    } else {
        relative.join(&name)
    };
    Ok(WorkspaceFileEntry {
        name,
        path: relative_path_string(&child_path),
        kind: entry_kind(&file_type).to_string(),
        size: file_type.is_file().then_some(metadata.len()),
    })
}

fn entry_kind(file_type: &std::fs::FileType) -> &'static str {
    if file_type.is_symlink() {
        return "symlink";
    }
    if file_type.is_dir() {
        return DIRECTORY_KIND;
    }
    if file_type.is_file() {
        return "file";
    }
    "other"
}

fn compare_entries(left: &WorkspaceFileEntry, right: &WorkspaceFileEntry) -> std::cmp::Ordering {
    let is_left_directory = left.kind == DIRECTORY_KIND;
    let is_right_directory = right.kind == DIRECTORY_KIND;
    is_right_directory
        .cmp(&is_left_directory)
        .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        .then_with(|| left.name.cmp(&right.name))
}

#[tauri::command(async)]
pub fn list_workspace_files(
    store: State<'_, Mutex<WorkspaceStore>>,
    request: WorkspaceFileListRequest,
) -> Result<WorkspaceFileListing, String> {
    let cwd = {
        let store = store.lock_or_recover();
        store.workspace(&request.workspace_id)?.cwd.clone()
    };
    list_directory_entries(
        Path::new(&cwd),
        request.relative_path.as_deref(),
        request.limit,
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileListRequest {
    pub workspace_id: String,
    pub relative_path: Option<String>,
    pub limit: Option<usize>,
}
