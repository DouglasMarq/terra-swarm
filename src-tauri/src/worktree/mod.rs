//! Git worktrees that isolate one agent from the others. Each isolated agent
//! works on its own branch (`terra/<terminal-id>`) in a checkout kept under
//! the app data directory, so several agents in one repository never edit
//! the same files.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::scrollback::is_plain_path_component;

pub mod review;

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

impl WorktreeInfo {
    /// Refuses values that git could read as an option or that do not name
    /// an agent branch. Stored worktrees come from `workspaces.json` and
    /// imported snapshots, and every field ends up on a git command line.
    pub(crate) fn check(&self) -> Result<(), String> {
        let is_agent_branch = self
            .branch
            .strip_prefix(BRANCH_PREFIX)
            .is_some_and(is_plain_path_component);
        if !is_agent_branch {
            return Err(format!("invalid worktree branch {:?}", self.branch));
        }
        if self.base.is_empty() || self.base.starts_with('-') {
            return Err(format!("invalid worktree base {:?}", self.base));
        }
        for path in [&self.path, &self.cwd, &self.repo] {
            if !Path::new(path).is_absolute() {
                return Err(format!("invalid worktree path {:?}", path));
            }
        }
        Ok(())
    }
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
        Ok(String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_string())
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
    git(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{}", branch),
        ],
    )
    .is_ok()
}

/// Create a worktree for `terminal_id` of the project at `project_cwd`,
/// under `<root>/<workspace_id>/<terminal_id>`.
pub fn create(
    project_cwd: &Path,
    root: &Path,
    workspace_id: &str,
    terminal_id: &str,
) -> Result<WorktreeInfo, String> {
    for id in [workspace_id, terminal_id] {
        if !is_plain_path_component(id) {
            return Err(format!("invalid id for a worktree folder: {:?}", id));
        }
    }
    let repo = repo_root(project_cwd).ok_or("this project is not inside a git repository")?;
    // Keep the agent in the same subfolder the project points at.
    let canonical_cwd =
        std::fs::canonicalize(project_cwd).unwrap_or_else(|_| project_cwd.to_path_buf());
    let canonical_repo = std::fs::canonicalize(&repo).unwrap_or_else(|_| repo.clone());
    let relative = canonical_cwd
        .strip_prefix(&canonical_repo)
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let base = match git(&repo, &["symbolic-ref", "--quiet", "--short", "HEAD"]) {
        Ok(branch) if !branch.is_empty() => branch,
        _ => git(&repo, &["rev-parse", "--short", "HEAD"])
            .map_err(|_| "the repository has no commits yet")?,
    };
    let mut branch = format!("{}{}", BRANCH_PREFIX, terminal_id);
    let mut suffix = 2;
    while branch_exists(&repo, &branch) {
        branch = format!("{}{}-{}", BRANCH_PREFIX, terminal_id, suffix);
        suffix += 1;
    }
    let path = root.join(workspace_id).join(terminal_id);
    if !path.starts_with(root) {
        return Err(format!("{} is outside the worktree folder", path.display()));
    }
    if path.exists() {
        return Err(format!("{} already exists", path.display()));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let path_text = path.to_string_lossy().to_string();
    git(
        &repo,
        &["worktree", "add", "-b", &branch, &path_text, "HEAD"],
    )?;
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

/// The checkout's uncommitted files and how far the branch and its base
/// diverged. Fails when git cannot answer, so a failure is never mistaken
/// for a clean worktree with nothing to lose.
pub fn status(info: &WorktreeInfo) -> Result<WorktreeStatus, String> {
    info.check()?;
    let path = Path::new(&info.path);
    let exists = path.is_dir();
    let dirty = if exists {
        git(path, &["status", "--porcelain"])
            .map_err(|error| format!("could not read the worktree status: {}", error))?
            .lines()
            .filter_map(|line| line.get(3..))
            .map(str::to_string)
            .collect()
    } else {
        Vec::new()
    };
    let (behind, ahead) = divergence(info)?;
    Ok(WorktreeStatus {
        branch: info.branch.clone(),
        base: info.base.clone(),
        path: info.path.clone(),
        dirty,
        ahead,
        behind,
        exists,
    })
}

/// Commits only the base has and commits only the branch has; none once
/// the branch itself is gone.
fn divergence(info: &WorktreeInfo) -> Result<(u32, u32), String> {
    let repo = Path::new(&info.repo);
    let range = format!("{}...{}", info.base, info.branch);
    match git(repo, &["rev-list", "--left-right", "--count", &range]) {
        Ok(text) => {
            let mut parts = text.split_whitespace();
            let (Some(behind), Some(ahead)) = (parts.next(), parts.next()) else {
                return Err(format!("unexpected git rev-list output: {}", text));
            };
            Ok((count(behind), count(ahead)))
        }
        Err(_) if !branch_exists(repo, &info.branch) => Ok((0, 0)),
        Err(error) => Err(format!(
            "could not compare {} with {}: {}",
            info.branch, info.base, error
        )),
    }
}

/// Remove the checkout (discarding uncommitted changes) and, when asked,
/// the branch with its commits.
pub fn remove(info: &WorktreeInfo, delete_branch: bool) -> Result<(), String> {
    info.check()?;
    let repo = Path::new(&info.repo);
    if Path::new(&info.path).exists() {
        git(repo, &["worktree", "remove", "--force", "--", &info.path])?;
    } else {
        // Already gone from disk: drop git's record of it.
        let _ = git(repo, &["worktree", "prune"]);
    }
    if delete_branch && branch_exists(repo, &info.branch) {
        git(repo, &["branch", "-D", "--", &info.branch])?;
    }
    Ok(())
}

/// The worktree recorded for a terminal of a workspace.
fn recorded(
    store: &std::sync::Mutex<crate::workspace::WorkspaceStore>,
    workspace_id: &str,
    terminal_id: &str,
) -> Result<WorktreeInfo, String> {
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
        Ok(info) => status(&info).map(Some),
        Err(error) => {
            eprintln!("no worktree status for terminal {}: {}", terminal_id, error);
            Ok(None)
        }
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

#[tauri::command(async)]
pub fn worktree_diff(
    store: tauri::State<'_, std::sync::Mutex<crate::workspace::WorkspaceStore>>,
    workspace_id: String,
    terminal_id: String,
) -> Result<review::WorktreeDiff, String> {
    review::diff(&recorded(&store, &workspace_id, &terminal_id)?)
}

#[tauri::command(async)]
pub fn worktree_commit(
    store: tauri::State<'_, std::sync::Mutex<crate::workspace::WorkspaceStore>>,
    workspace_id: String,
    terminal_id: String,
    message: String,
) -> Result<WorktreeStatus, String> {
    review::commit(&recorded(&store, &workspace_id, &terminal_id)?, &message)
}

#[tauri::command(async)]
pub fn worktree_merge(
    store: tauri::State<'_, std::sync::Mutex<crate::workspace::WorkspaceStore>>,
    workspace_id: String,
    terminal_id: String,
) -> Result<WorktreeStatus, String> {
    review::merge(&recorded(&store, &workspace_id, &terminal_id)?)
}

/// Pushes the agent's branch and opens a pull request; the user asks for
/// this explicitly from the review dialog.
#[tauri::command(async)]
pub fn worktree_open_pr(
    store: tauri::State<'_, std::sync::Mutex<crate::workspace::WorkspaceStore>>,
    workspace_id: String,
    terminal_id: String,
    title: String,
    body: String,
) -> Result<String, String> {
    review::open_pull_request(
        &recorded(&store, &workspace_id, &terminal_id)?,
        &title,
        &body,
    )
}

#[cfg(test)]
pub(crate) mod test_repo {
    use super::git;
    use std::path::{Path, PathBuf};

    /// A fresh repository with one commit on `main`.
    pub fn init(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "terra-wt-{}-{}-{}",
            name,
            std::process::id(),
            crate::mcp::repo::now_millis()
        ));
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

        let clean = status(&info).unwrap();
        assert!(clean.exists);
        assert!(clean.dirty.is_empty());
        assert_eq!((clean.ahead, clean.behind), (0, 0));

        std::fs::write(Path::new(&info.cwd).join("new.txt"), "x").unwrap();
        assert_eq!(
            status(&info).unwrap().dirty,
            vec!["app/new.txt".to_string()]
        );
        git(Path::new(&info.path), &["add", "."]).unwrap();
        git(Path::new(&info.path), &["commit", "-q", "-m", "work"]).unwrap();
        let committed = status(&info).unwrap();
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
        assert!(create(&dir, &dir.join("wt"), "ws", "t-1")
            .unwrap_err()
            .contains("not inside a git repository"));
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

    #[test]
    fn given_ids_that_are_not_plain_folder_names_refuses_to_create_a_worktree() {
        let repo = init("ids");
        let root = repo.with_extension("worktrees");
        let absolute = std::env::temp_dir().join("terra-wt-escape");
        let absolute = absolute.to_string_lossy();
        for (workspace_id, terminal_id) in [
            ("..", "t-1"),
            ("ws-1", ".."),
            ("ws-1", "../../escape"),
            (absolute.as_ref(), "t-1"),
            ("ws-1", absolute.as_ref()),
            ("ws-1", ""),
            ("ws-1", "--receive-pack=x/y"),
        ] {
            assert!(
                create(&repo, &root, workspace_id, terminal_id)
                    .unwrap_err()
                    .contains("invalid id"),
                "{workspace_id} / {terminal_id}"
            );
        }
        assert!(!root.exists());
        assert!(git(&repo, &["branch", "--list", "terra/*"])
            .unwrap()
            .is_empty());
        cleanup(&repo, &root);
    }

    #[test]
    fn given_a_broken_checkout_status_reports_an_error_instead_of_clean() {
        let repo = init("broken");
        let root = repo.with_extension("worktrees");
        let info = create(&repo, &root, "ws", "t-1").unwrap();
        std::fs::write(Path::new(&info.path).join("draft.txt"), "x").unwrap();
        std::fs::write(Path::new(&info.path).join(".git"), "gitdir: /missing\n").unwrap();

        assert!(status(&info)
            .unwrap_err()
            .contains("could not read the worktree status"));
        cleanup(&repo, &root);
    }

    #[test]
    fn given_a_deleted_checkout_status_still_counts_the_branch_commits() {
        let repo = init("deleted");
        let root = repo.with_extension("worktrees");
        let info = create(&repo, &root, "ws", "t-1").unwrap();
        std::fs::write(Path::new(&info.path).join("feature.txt"), "x").unwrap();
        git(Path::new(&info.path), &["add", "."]).unwrap();
        git(Path::new(&info.path), &["commit", "-q", "-m", "work"]).unwrap();
        std::fs::remove_dir_all(&info.path).unwrap();

        let kept_branch = status(&info).unwrap();
        assert!(!kept_branch.exists);
        assert_eq!((kept_branch.ahead, kept_branch.behind), (1, 0));

        git(&repo, &["worktree", "prune"]).unwrap();
        git(&repo, &["branch", "-D", "terra/t-1"]).unwrap();
        let gone = status(&info).unwrap();
        assert_eq!((gone.ahead, gone.behind), (0, 0));
        cleanup(&repo, &root);
    }

    #[test]
    fn given_a_base_git_cannot_compare_status_reports_an_error() {
        let repo = init("no-base");
        let root = repo.with_extension("worktrees");
        let mut info = create(&repo, &root, "ws", "t-1").unwrap();
        info.base = "vanished".to_string();

        assert!(status(&info).unwrap_err().contains("could not compare"));
        cleanup(&repo, &root);
    }

    fn stored_info(branch: &str, base: &str) -> WorktreeInfo {
        let checkout = std::env::temp_dir().join("terra-wt-stored");
        WorktreeInfo {
            path: checkout.to_string_lossy().into_owned(),
            cwd: checkout.to_string_lossy().into_owned(),
            branch: branch.to_string(),
            base: base.to_string(),
            repo: std::env::temp_dir().to_string_lossy().into_owned(),
        }
    }

    #[test]
    fn given_worktree_values_git_could_read_as_options_refuses_them() {
        assert!(stored_info("terra/t-1", "main").check().is_ok());
        assert!(stored_info("terra/t-1-2", "feature/login").check().is_ok());
        for (branch, base) in [
            ("--receive-pack=x", "main"),
            ("terra/--upload-pack=x/y", "main"),
            ("terra/../main", "main"),
            ("terra/", "main"),
            ("main", "main"),
            ("terra/t-1", "--output=x"),
            ("terra/t-1", ""),
        ] {
            assert!(
                stored_info(branch, base).check().is_err(),
                "{branch} / {base}"
            );
        }
        let mut relative = stored_info("terra/t-1", "main");
        relative.path = "-C/elsewhere".to_string();
        assert!(relative.check().is_err());
    }

    #[test]
    fn given_an_option_like_branch_remove_runs_no_git() {
        let repo = init("remove-option");
        let root = repo.with_extension("worktrees");
        let mut info = create(&repo, &root, "ws", "t-1").unwrap();
        info.branch = "--receive-pack=x".to_string();
        assert!(remove(&info, true).unwrap_err().contains("invalid"));
        assert!(Path::new(&info.path).exists());
        assert!(branch_exists(&repo, "terra/t-1"));
        cleanup(&repo, &root);
    }
}
