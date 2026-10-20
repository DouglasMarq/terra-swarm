//! Reading and saving one text file of a workspace for the built-in editor.
//! Paths are workspace-relative and must stay inside the workspace, and a
//! save refuses to overwrite a file that changed on disk since it was read
//! (agents edit the same files).

use super::{safe_relative_path, WorkspaceStore};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::State;

/// Larger files are not opened in the editor.
pub(crate) const MAX_EDIT_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileContent {
    pub path: String,
    /// Empty when the file is binary.
    pub content: String,
    pub binary: bool,
    pub size: u64,
    /// Modification time in milliseconds, passed back when saving.
    pub modified: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileSaved {
    pub size: u64,
    pub modified: u64,
}

fn modified_millis(path: &Path) -> Result<u64, String> {
    let modified = std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .map_err(|error| format!("cannot read the file's time: {}", error))?;
    Ok(modified
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0))
}

/// The real path of `relative` inside `root`, which must be an existing file.
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
    // A symlink may point anywhere; only what resolves inside the workspace opens.
    if !target.starts_with(&root) {
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
            size / 1024
        ));
    }
    let bytes =
        std::fs::read(&target).map_err(|error| format!("cannot read the file: {}", error))?;
    let text = if bytes.iter().take(8192).any(|byte| *byte == 0) {
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

pub(crate) fn write_file(
    root: &Path,
    relative: &str,
    content: &str,
    expected_modified: Option<u64>,
) -> Result<WorkspaceFileSaved, String> {
    let target = resolve_file(root, relative)?;
    if content.len() as u64 > MAX_EDIT_BYTES {
        return Err("the text is too large to save here".into());
    }
    if let Some(expected) = expected_modified {
        if modified_millis(&target)? != expected {
            return Err("the file changed on disk since it was opened; reload it, or save again to overwrite".into());
        }
    }
    std::fs::write(&target, content).map_err(|error| format!("cannot save the file: {}", error))?;
    Ok(WorkspaceFileSaved {
        size: content.len() as u64,
        modified: modified_millis(&target)?,
    })
}

fn workspace_cwd(store: &Mutex<WorkspaceStore>, workspace_id: &str) -> Result<String, String> {
    let store = store.lock().map_err(|error| error.to_string())?;
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

/// `expected_modified` is the time the editor read; `None` overwrites.
#[tauri::command(async)]
pub fn write_workspace_file(
    store: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    relative_path: String,
    content: String,
    expected_modified: Option<u64>,
) -> Result<WorkspaceFileSaved, String> {
    write_file(
        Path::new(&workspace_cwd(&store, &workspace_id)?),
        &relative_path,
        &content,
        expected_modified,
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
            crate::mcp::repo::now_millis()
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
        let saved = write_file(&root, "src/main.ts", "let a = 2;\n", Some(file.modified)).unwrap();
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
            .set_modified(UNIX_EPOCH + std::time::Duration::from_millis(stale))
            .unwrap();
        assert!(write_file(&root, "notes.md", "mine", Some(file.modified))
            .unwrap_err()
            .contains("changed on disk"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "agent wrote this");
        write_file(&root, "notes.md", "mine", None).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "mine");
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
            assert!(write_file(&root, "link", "x", None).is_err());
        }
        std::fs::write(root.join("logo.png"), [0x89, b'P', b'N', b'G', 0, 1, 2]).unwrap();
        let binary = read_file(&root, "logo.png").unwrap();
        assert!(binary.binary);
        assert!(binary.content.is_empty());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_file(outside);
    }
}
