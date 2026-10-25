use super::{safe_relative_path, write_atomic, WorkspaceStore};
use crate::ipc_error::{IpcError, IpcErrorCode};
use crate::sync::LockExt;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

pub(crate) const MAX_EDIT_BYTES: u64 = 2 * 1024 * 1024;

const BINARY_SNIFF_BYTES: usize = 8192;

const BYTES_PER_KB: u64 = 1024;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileContent {
    pub path: String,
    pub content: String,
    pub binary: bool,
    pub size: u64,
    pub modified: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileSaved {
    pub size: u64,
    pub modified: u64,
}

pub(crate) struct FileSave<'a> {
    pub(crate) relative: &'a str,
    pub(crate) content: &'a str,
    pub(crate) expected_modified: Option<u64>,
}

fn modified_millis(path: &Path) -> Result<u64, String> {
    let modified = std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .map_err(|error| format!("cannot read the file's time: {}", error))?;
    Ok(crate::clock::epoch_millis(modified).unwrap_or(0))
}

fn resolve_file(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("workspace directory is unavailable: {}", error))?;
    let relative = safe_relative_path(Some(relative))?;
    if relative.as_os_str().is_empty() {
        return Err("choose a file".into());
    }
    let target = root
        .join(&relative)
        .canonicalize()
        .map_err(|error| format!("file is unavailable: {}", error))?;
    let is_inside_workspace = target.starts_with(&root);
    if !is_inside_workspace {
        return Err("file path cannot escape the workspace".into());
    }
    if !target.is_file() {
        return Err("not a regular file".into());
    }
    Ok(target)
}

pub(crate) fn read_file(root: &Path, relative: &str) -> Result<WorkspaceFileContent, String> {
    let target = resolve_file(root, relative)?;
    let size = std::fs::metadata(&target)
        .map_err(|error| error.to_string())?
        .len();
    if size > MAX_EDIT_BYTES {
        return Err(format!(
            "the file is too large to edit here ({} KB)",
            size / BYTES_PER_KB
        ));
    }
    let bytes =
        std::fs::read(&target).map_err(|error| format!("cannot read the file: {}", error))?;
    let text = if bytes.iter().take(BINARY_SNIFF_BYTES).any(|byte| *byte == 0) {
        None
    } else {
        String::from_utf8(bytes).ok()
    };
    Ok(WorkspaceFileContent {
        path: relative.trim().replace('\\', "/"),
        binary: text.is_none(),
        content: text.unwrap_or_default(),
        size,
        modified: modified_millis(&target)?,
    })
}

fn replace_file(target: &Path, content: &str) -> Result<(), String> {
    let permissions = std::fs::metadata(target)
        .map_err(|error| format!("cannot read the file's permissions: {}", error))?
        .permissions();
    write_atomic(target, content).map_err(|error| format!("cannot save the file: {}", error))?;
    std::fs::set_permissions(target, permissions)
        .map_err(|error| format!("cannot restore the file's permissions: {}", error))
}

pub(crate) fn write_file(root: &Path, save: FileSave) -> Result<WorkspaceFileSaved, IpcError> {
    let target = resolve_file(root, save.relative)?;
    let size = u64::try_from(save.content.len()).unwrap_or(u64::MAX);
    if size > MAX_EDIT_BYTES {
        return Err(IpcError::new(
            IpcErrorCode::Other,
            "the text is too large to save here",
        ));
    }
    ensure_unchanged(&target, save.expected_modified)?;
    replace_file(&target, save.content)?;
    Ok(WorkspaceFileSaved {
        size,
        modified: modified_millis(&target)?,
    })
}

fn ensure_unchanged(target: &Path, expected_modified: Option<u64>) -> Result<(), IpcError> {
    let Some(expected) = expected_modified else {
        return Ok(());
    };
    if modified_millis(target)? == expected {
        return Ok(());
    }
    Err(IpcError::new(
        IpcErrorCode::ChangedOnDisk,
        "the file changed on disk since it was opened; reload it, or save again to overwrite",
    ))
}

fn workspace_cwd(store: &Mutex<WorkspaceStore>, workspace_id: &str) -> Result<String, String> {
    let store = store.lock_or_recover();
    Ok(store.workspace(workspace_id)?.cwd.clone())
}

#[tauri::command(async)]
pub fn read_workspace_file(
    store: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    relative_path: String,
) -> Result<WorkspaceFileContent, String> {
    read_file(
        Path::new(&workspace_cwd(&store, &workspace_id)?),
        &relative_path,
    )
}

#[tauri::command(async)]
pub fn write_workspace_file(
    store: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    relative_path: String,
    content: String,
    expected_modified: Option<u64>,
) -> Result<WorkspaceFileSaved, IpcError> {
    write_file(
        Path::new(&workspace_cwd(&store, &workspace_id)?),
        FileSave {
            relative: &relative_path,
            content: &content,
            expected_modified,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "terra-editor-{}-{}-{}",
            name,
            std::process::id(),
            crate::clock::now_millis()
        ));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        dir
    }

    #[test]
    fn reads_and_saves_text_inside_the_workspace() {
        let root = temp_root("rw");
        std::fs::write(root.join("src/main.ts"), "let a = 1;\n").unwrap();
        let file = read_file(&root, "src/main.ts").unwrap();
        assert_eq!(file.content, "let a = 1;\n");
        assert!(!file.binary);
        let saved = write_file(
            &root,
            FileSave {
                relative: "src/main.ts",
                content: "let a = 2;\n",
                expected_modified: Some(file.modified),
            },
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("src/main.ts")).unwrap(),
            "let a = 2;\n"
        );
        assert_eq!(saved.size, 11);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn refuses_to_overwrite_a_file_an_agent_changed() {
        let root = temp_root("conflict");
        let path = root.join("notes.md");
        std::fs::write(&path, "one").unwrap();
        let file = read_file(&root, "notes.md").unwrap();
        std::fs::write(&path, "agent wrote this").unwrap();
        let stale = file.modified.saturating_sub(5_000);
        let file_time = std::fs::File::options().write(true).open(&path).unwrap();
        file_time
            .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_millis(stale))
            .unwrap();
        assert_eq!(
            write_file(
                &root,
                FileSave {
                    relative: "notes.md",
                    content: "mine",
                    expected_modified: Some(file.modified)
                }
            )
            .unwrap_err()
            .code,
            IpcErrorCode::ChangedOnDisk
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "agent wrote this");
        write_file(
            &root,
            FileSave {
                relative: "notes.md",
                content: "mine",
                expected_modified: None,
            },
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "mine");
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn given_a_reader_with_the_file_open_when_saving_then_it_still_reads_the_whole_previous_text() {
        use std::io::Read;
        use std::os::unix::fs::PermissionsExt;
        let root = temp_root("atomic");
        let path = root.join("run.sh");
        std::fs::write(&path, "echo before\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut reader = std::fs::File::open(&path).unwrap();

        write_file(
            &root,
            FileSave {
                relative: "run.sh",
                content: "echo after\n",
                expected_modified: None,
            },
        )
        .unwrap();

        let mut seen = String::new();
        reader.read_to_string(&mut seen).unwrap();
        assert_eq!(seen, "echo before\n");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "echo after\n");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o755);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn given_text_over_the_size_limit_save_fails_with_the_other_code() {
        let root = temp_root("too-large");
        std::fs::write(root.join("big.txt"), "x").unwrap();
        let text =
            "x".repeat(usize::try_from(MAX_EDIT_BYTES).expect("edit limit fits in memory") + 1);
        let error = write_file(
            &root,
            FileSave {
                relative: "big.txt",
                content: &text,
                expected_modified: None,
            },
        )
        .unwrap_err();
        assert_eq!(error.code, IpcErrorCode::Other);
        assert!(error.message.contains("too large"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn stays_inside_the_workspace_and_skips_binaries() {
        let root = temp_root("guard");
        let outside = root.with_extension("outside");
        std::fs::write(&outside, "secret").unwrap();
        assert!(read_file(&root, "../x").is_err());
        assert!(read_file(&root, "/etc/hosts").is_err());
        assert!(read_file(&root, "src")
            .unwrap_err()
            .contains("not a regular file"));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
            assert!(read_file(&root, "link").unwrap_err().contains("escape"));
            assert!(write_file(
                &root,
                FileSave {
                    relative: "link",
                    content: "x",
                    expected_modified: None
                }
            )
            .is_err());
        }
        std::fs::write(root.join("logo.png"), [0x89, b'P', b'N', b'G', 0, 1, 2]).unwrap();
        let binary = read_file(&root, "logo.png").unwrap();
        assert!(binary.binary);
        assert!(binary.content.is_empty());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_file(outside);
    }
}
