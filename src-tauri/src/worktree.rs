//! Git worktrees that isolate one agent from the others. Each isolated agent
//! works on its own branch (`terra/<terminal-id>`) in a checkout kept under
//! the app data directory, so several agents in one repository never edit
//! the same files.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

pub const BRANCH_PREFIX: &str = "terra/";

/// Stored with the terminal record, so a resumed agent returns to it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    /// The checkout the agent works in.
    pub path: String,
    /// Where the agent's shell starts: `path` plus the project's subfolder.
    pub cwd: String,
    pub branch: String,
    /// The branch (or commit) the worktree was created from.
    pub base: String,
    /// The main repository's root.
    pub repo: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatus {
    pub branch: String,
    pub base: String,
    pub path: String,
    /// Files with uncommitted changes (porcelain paths).
    pub dirty: Vec<String>,
    /// Commits on the branch that the base does not have.
    pub ahead: u32,
    /// Commits on the base that the branch does not have.
    pub behind: u32,
    pub exists: bool,
}

pub(crate) fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|error| format!("could not run git: {}", error))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim_end().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("git {} failed", args.join(" "))
        } else {
            stderr
        })
    }
}

/// The repository root containing `dir`, if it is inside a git work tree.
pub fn repo_root(dir: &Path) -> Option<PathBuf> {
    git(dir, &["rev-parse", "--show-toplevel"])
        .ok()
        .filter(|root| !root.is_empty())
        .map(PathBuf::from)
}

fn branch_exists(repo: &Path, branch: &str) -> bool {
    git(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{}", branch)]).is_ok()
}

/// Create a worktree for `terminal_id` of the project at `project_cwd`,
/// under `<root>/<workspace_id>/<terminal_id>`.
pub fn create(project_cwd: &Path, root: &Path, workspace_id: &str, terminal_id: &str) -> Result<WorktreeInfo, String> {
    let repo = repo_root(project_cwd).ok_or("this project is not inside a git repository")?;
    // Keep the agent in the same subfolder the project points at.
    let canonical_cwd = std::fs::canonicalize(project_cwd).unwrap_or_else(|_| project_cwd.to_path_buf());
    let canonical_repo = std::fs::canonicalize(&repo).unwrap_or_else(|_| repo.clone());
    let relative = canonical_cwd
        .strip_prefix(&canonical_repo)
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let base = match git(&repo, &["symbolic-ref", "--quiet", "--short", "HEAD"]) {
        Ok(branch) if !branch.is_empty() => branch,
        _ => git(&repo, &["rev-parse", "--short", "HEAD"]).map_err(|_| "the repository has no commits yet")?,
    };
    let mut branch = format!("{}{}", BRANCH_PREFIX, terminal_id);
    let mut suffix = 2;
    while branch_exists(&repo, &branch) {
        branch = format!("{}{}-{}", BRANCH_PREFIX, terminal_id, suffix);
        suffix += 1;
    }
    let path = root.join(workspace_id).join(terminal_id);
    if path.exists() {
        return Err(format!("{} already exists", path.display()));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let path_text = path.to_string_lossy().to_string();
    git(&repo, &["worktree", "add", "-b", &branch, &path_text, "HEAD"])?;
    let cwd = path.join(relative);
    Ok(WorktreeInfo {
        path: path_text,
        cwd: cwd.to_string_lossy().to_string(),
        branch,
        base,
        repo: repo.to_string_lossy().to_string(),
    })
}

fn count(text: &str) -> u32 {
    text.trim().parse().unwrap_or(0)
}

pub fn status(info: &WorktreeInfo) -> WorktreeStatus {
    let path = Path::new(&info.path);
    let exists = path.is_dir();
    let dirty = if exists {
        git(path, &["status", "--porcelain"])
            .map(|text| {
                text.lines()
                    .filter_map(|line| line.get(3..))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let repo = Path::new(&info.repo);
    let range = format!("{}...{}", info.base, info.branch);
    let (behind, ahead) = git(repo, &["rev-list", "--left-right", "--count", &range])
        .ok()
        .and_then(|text| {
            let mut parts = text.split_whitespace();
            Some((count(parts.next()?), count(parts.next()?)))
        })
        .unwrap_or((0, 0));
    WorktreeStatus {
        branch: info.branch.clone(),
        base: info.base.clone(),
        path: info.path.clone(),
        dirty,
        ahead,
        behind,
        exists,
    }
}

/// Remove the checkout (discarding uncommitted changes) and, when asked,
/// the branch with its commits.
pub fn remove(info: &WorktreeInfo, delete_branch: bool) -> Result<(), String> {
    let repo = Path::new(&info.repo);
    if Path::new(&info.path).exists() {
        git(repo, &["worktree", "remove", "--force", &info.path])?;
    } else {
        // Already gone from disk: drop git's record of it.
        let _ = git(repo, &["worktree", "prune"]);
    }
    if delete_branch && branch_exists(repo, &info.branch) {
        git(repo, &["branch", "-D", &info.branch])?;
    }
    Ok(())
}

/// The worktree recorded for a terminal of a workspace.
fn recorded(store: &std::sync::Mutex<crate::workspace::WorkspaceStore>, workspace_id: &str, terminal_id: &str) -> Result<WorktreeInfo, String> {
    let store = store.lock().map_err(|error| error.to_string())?;
    store
        .workspace(workspace_id)?
        .terminals
        .iter()
        .find(|terminal| terminal.id == terminal_id)
        .and_then(|terminal| terminal.worktree.clone())
        .ok_or_else(|| format!("terminal {} has no worktree", terminal_id))
}

#[tauri::command(async)]
pub fn worktree_status(
    store: tauri::State<'_, std::sync::Mutex<crate::workspace::WorkspaceStore>>,
    workspace_id: String,
    terminal_id: String,
) -> Result<Option<WorktreeStatus>, String> {
    match recorded(&store, &workspace_id, &terminal_id) {
        Ok(info) => Ok(Some(status(&info))),
        Err(_) => Ok(None),
    }
}

/// Delete an agent's worktree, discarding uncommitted changes; the branch
/// (with its commits) goes too when `delete_branch` is set. Stop the agent
/// first: its shell must not be running inside the folder.
#[tauri::command(async)]
pub fn worktree_remove(
    store: tauri::State<'_, std::sync::Mutex<crate::workspace::WorkspaceStore>>,
    workspace_id: String,
    terminal_id: String,
    delete_branch: bool,
) -> Result<(), String> {
    let info = recorded(&store, &workspace_id, &terminal_id)?;
    remove(&info, delete_branch)
}

#[cfg(test)]
pub(crate) mod test_repo {
    use super::git;
    use std::path::{Path, PathBuf};

    /// A fresh repository with one commit on `main`.
    pub fn init(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("terra-wt-{}-{}-{}", name, std::process::id(), crate::mcp::repo::now_millis()));
        std::fs::create_dir_all(dir.join("app")).unwrap();
        let run = |args: &[&str]| git(&dir, args).unwrap();
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "user.name", "Test"]);
        std::fs::write(dir.join("app/readme.txt"), "hello\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "first"]);
        dir
    }

    pub fn cleanup(dir: &Path, root: &Path) {
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(root);
    }
}

#[cfg(test)]
mod tests {
    use super::test_repo::{cleanup, init};
    use super::*;

    #[test]
    fn creates_an_isolated_branch_and_reports_its_state() {
        let repo = init("create");
        let root = repo.with_extension("worktrees");
        let info = create(&repo.join("app"), &root, "ws-1", "t-3").unwrap();
        assert_eq!(info.branch, "terra/t-3");
        assert_eq!(info.base, "main");
        assert!(Path::new(&info.cwd).ends_with("t-3/app"));
        assert!(Path::new(&info.cwd).join("readme.txt").exists());

        let clean = status(&info);
        assert!(clean.exists);
        assert!(clean.dirty.is_empty());
        assert_eq!((clean.ahead, clean.behind), (0, 0));

        std::fs::write(Path::new(&info.cwd).join("new.txt"), "x").unwrap();
        assert_eq!(status(&info).dirty, vec!["app/new.txt".to_string()]);
        git(Path::new(&info.path), &["add", "."]).unwrap();
        git(Path::new(&info.path), &["commit", "-q", "-m", "work"]).unwrap();
        let committed = status(&info);
        assert!(committed.dirty.is_empty());
        assert_eq!(committed.ahead, 1);

        // A second agent with the same id gets a fresh branch name.
        let again = create(&repo.join("app"), &root, "ws-1", "t-3b").unwrap();
        assert_eq!(again.branch, "terra/t-3b");

        remove(&info, true).unwrap();
        assert!(!Path::new(&info.path).exists());
        assert!(!branch_exists(&repo, "terra/t-3"));
        remove(&again, false).unwrap();
        assert!(branch_exists(&repo, "terra/t-3b"));
        cleanup(&repo, &root);
    }

    #[test]
    fn refuses_a_folder_outside_git() {
        let dir = std::env::temp_dir().join(format!("terra-wt-plain-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(create(&dir, &dir.join("wt"), "ws", "t-1").unwrap_err().contains("not inside a git repository"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_taken_branch_name_gets_a_suffix() {
        let repo = init("suffix");
        let root = repo.with_extension("worktrees");
        git(&repo, &["branch", "terra/t-9"]).unwrap();
        let info = create(&repo, &root, "ws", "t-9").unwrap();
        assert_eq!(info.branch, "terra/t-9-2");
        remove(&info, true).unwrap();
        cleanup(&repo, &root);
    }
}
