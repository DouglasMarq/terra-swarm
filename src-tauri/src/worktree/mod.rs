use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::paths::is_plain_path_component;

pub mod review;

pub const BRANCH_PREFIX: &str = "terra/";

const FIRST_BRANCH_SUFFIX: u32 = 2;

const PORCELAIN_PATH_OFFSET: usize = 3;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub cwd: String,
    pub branch: String,
    pub base: String,
    pub repo: String,
}

impl WorktreeInfo {
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

#[derive(Clone, Copy)]
pub struct NewWorktree<'a> {
    pub project_cwd: &'a Path,
    pub root: &'a Path,
    pub workspace_id: &'a str,
    pub terminal_id: &'a str,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatus {
    pub branch: String,
    pub base: String,
    pub path: String,
    pub dirty: Vec<String>,
    pub ahead: u32,
    pub behind: u32,
    pub is_present: bool,
}

pub(crate) fn git_command(dir: &Path) -> Command {
    let mut command = Command::new("git");
    command.arg("-C").arg(dir).env("GIT_TERMINAL_PROMPT", "0");
    command
}

pub(crate) fn run_command(
    mut command: Command,
    program: &str,
    failure: &str,
) -> Result<String, String> {
    let output = command
        .output()
        .map_err(|error| format!("could not run {}: {}", program, error))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_string());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        failure.to_string()
    } else {
        stderr
    })
}

pub(crate) fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = git_command(dir);
    command.args(args);
    run_command(command, "git", &format!("git {} failed", args.join(" ")))
}

pub fn repo_root(dir: &Path) -> Option<PathBuf> {
    git(dir, &["rev-parse", "--show-toplevel"])
        .ok()
        .filter(|root| !root.is_empty())
        .map(PathBuf::from)
}

fn has_branch(repo: &Path, branch: &str) -> bool {
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

pub fn create(new: NewWorktree<'_>) -> Result<WorktreeInfo, String> {
    let NewWorktree {
        project_cwd,
        root,
        workspace_id,
        terminal_id,
    } = new;
    check_folder_ids(workspace_id, terminal_id)?;
    let repo = repo_root(project_cwd).ok_or("this project is not inside a git repository")?;
    let relative = subfolder_in_repo(project_cwd, &repo);
    let base = base_ref(&repo)?;
    let branch = free_branch(&repo, terminal_id);
    let path = root.join(workspace_id).join(terminal_id);
    prepare_worktree_folder(&path, root)?;
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

fn check_folder_ids(workspace_id: &str, terminal_id: &str) -> Result<(), String> {
    for id in [workspace_id, terminal_id] {
        if !is_plain_path_component(id) {
            return Err(format!("invalid id for a worktree folder: {:?}", id));
        }
    }
    Ok(())
}

fn subfolder_in_repo(project_cwd: &Path, repo: &Path) -> PathBuf {
    let canonical_cwd =
        std::fs::canonicalize(project_cwd).unwrap_or_else(|_| project_cwd.to_path_buf());
    let canonical_repo = std::fs::canonicalize(repo).unwrap_or_else(|_| repo.to_path_buf());
    canonical_cwd
        .strip_prefix(&canonical_repo)
        .map(Path::to_path_buf)
        .unwrap_or_default()
}

fn base_ref(repo: &Path) -> Result<String, String> {
    match git(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"]) {
        Ok(branch) if !branch.is_empty() => Ok(branch),
        _ => git(repo, &["rev-parse", "--short", "HEAD"])
            .map_err(|error| format!("the repository has no commits yet: {}", error)),
    }
}

fn free_branch(repo: &Path, terminal_id: &str) -> String {
    let mut branch = format!("{}{}", BRANCH_PREFIX, terminal_id);
    let mut suffix = FIRST_BRANCH_SUFFIX;
    while has_branch(repo, &branch) {
        branch = format!("{}{}-{}", BRANCH_PREFIX, terminal_id, suffix);
        suffix += 1;
    }
    branch
}

fn prepare_worktree_folder(path: &Path, root: &Path) -> Result<(), String> {
    if !path.starts_with(root) {
        return Err(format!("{} is outside the worktree folder", path.display()));
    }
    if path.exists() {
        return Err(format!("{} already exists", path.display()));
    }
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())
}

fn count(text: &str) -> u32 {
    text.trim().parse().unwrap_or(0)
}

pub fn status(info: &WorktreeInfo) -> Result<WorktreeStatus, String> {
    info.check()?;
    let path = Path::new(&info.path);
    let is_present = path.is_dir();
    let dirty = if is_present {
        git(path, &["status", "--porcelain"])
            .map_err(|error| format!("could not read the worktree status: {}", error))?
            .lines()
            .filter_map(|line| line.get(PORCELAIN_PATH_OFFSET..))
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
        is_present,
    })
}

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
        Err(_) if !has_branch(repo, &info.branch) => Ok((0, 0)),
        Err(error) => Err(format!(
            "could not compare {} with {}: {}",
            info.branch, info.base, error
        )),
    }
}

pub fn remove(info: &WorktreeInfo, should_delete_branch: bool) -> Result<(), String> {
    info.check()?;
    let repo = Path::new(&info.repo);
    if Path::new(&info.path).exists() {
        git(repo, &["worktree", "remove", "--force", "--", &info.path])?;
    } else if let Err(error) = git(repo, &["worktree", "prune"]) {
        eprintln!("failed to prune worktrees of {}: {}", info.repo, error);
    }
    if should_delete_branch && has_branch(repo, &info.branch) {
        git(repo, &["branch", "-D", "--", &info.branch])?;
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod test_repo {
    use super::git;
    use std::path::{Path, PathBuf};

    pub fn init(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "terra-wt-{}-{}-{}",
            name,
            std::process::id(),
            crate::clock::now_millis()
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
    fn given_a_repository_when_creating_a_worktree_then_it_gets_an_isolated_branch_and_reports_its_state(
    ) {
        let repo = init("create");
        let root = repo.with_extension("worktrees");
        let info = create(NewWorktree {
            project_cwd: &repo.join("app"),
            root: &root,
            workspace_id: "ws-1",
            terminal_id: "t-3",
        })
        .unwrap();
        assert_eq!(info.branch, "terra/t-3");
        assert_eq!(info.base, "main");
        assert!(Path::new(&info.cwd).ends_with("t-3/app"));
        assert!(Path::new(&info.cwd).join("readme.txt").exists());

        let clean = status(&info).unwrap();
        assert!(clean.is_present);
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

        let again = create(NewWorktree {
            project_cwd: &repo.join("app"),
            root: &root,
            workspace_id: "ws-1",
            terminal_id: "t-3b",
        })
        .unwrap();
        assert_eq!(again.branch, "terra/t-3b");

        remove(&info, true).unwrap();
        assert!(!Path::new(&info.path).exists());
        assert!(!has_branch(&repo, "terra/t-3"));
        remove(&again, false).unwrap();
        assert!(has_branch(&repo, "terra/t-3b"));
        cleanup(&repo, &root);
    }

    #[test]
    fn given_a_folder_outside_git_when_creating_a_worktree_then_it_is_refused() {
        let dir = std::env::temp_dir().join(format!("terra-wt-plain-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(create(NewWorktree {
            project_cwd: &dir,
            root: &dir.join("wt"),
            workspace_id: "ws",
            terminal_id: "t-1"
        })
        .unwrap_err()
        .contains("not inside a git repository"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn given_a_taken_branch_name_when_creating_a_worktree_then_the_branch_gets_a_suffix() {
        let repo = init("suffix");
        let root = repo.with_extension("worktrees");
        git(&repo, &["branch", "terra/t-9"]).unwrap();
        let info = create(NewWorktree {
            project_cwd: &repo,
            root: &root,
            workspace_id: "ws",
            terminal_id: "t-9",
        })
        .unwrap();
        assert_eq!(info.branch, "terra/t-9-2");
        remove(&info, true).unwrap();
        cleanup(&repo, &root);
    }

    #[test]
    fn given_ids_that_are_not_plain_folder_names_when_creating_a_worktree_then_it_is_refused() {
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
                create(NewWorktree {
                    project_cwd: &repo,
                    root: &root,
                    workspace_id,
                    terminal_id,
                })
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
    fn given_a_broken_checkout_when_reading_status_then_it_reports_an_error_instead_of_clean() {
        let repo = init("broken");
        let root = repo.with_extension("worktrees");
        let info = create(NewWorktree {
            project_cwd: &repo,
            root: &root,
            workspace_id: "ws",
            terminal_id: "t-1",
        })
        .unwrap();
        std::fs::write(Path::new(&info.path).join("draft.txt"), "x").unwrap();
        std::fs::write(Path::new(&info.path).join(".git"), "gitdir: /missing\n").unwrap();

        assert!(status(&info)
            .unwrap_err()
            .contains("could not read the worktree status"));
        cleanup(&repo, &root);
    }

    #[test]
    fn given_a_deleted_checkout_when_reading_status_then_it_still_counts_the_branch_commits() {
        let repo = init("deleted");
        let root = repo.with_extension("worktrees");
        let info = create(NewWorktree {
            project_cwd: &repo,
            root: &root,
            workspace_id: "ws",
            terminal_id: "t-1",
        })
        .unwrap();
        std::fs::write(Path::new(&info.path).join("feature.txt"), "x").unwrap();
        git(Path::new(&info.path), &["add", "."]).unwrap();
        git(Path::new(&info.path), &["commit", "-q", "-m", "work"]).unwrap();
        std::fs::remove_dir_all(&info.path).unwrap();

        let kept_branch = status(&info).unwrap();
        assert!(!kept_branch.is_present);
        assert_eq!((kept_branch.ahead, kept_branch.behind), (1, 0));

        git(&repo, &["worktree", "prune"]).unwrap();
        git(&repo, &["branch", "-D", "terra/t-1"]).unwrap();
        let gone = status(&info).unwrap();
        assert_eq!((gone.ahead, gone.behind), (0, 0));
        cleanup(&repo, &root);
    }

    #[test]
    fn given_a_base_git_cannot_compare_when_reading_status_then_it_reports_an_error() {
        let repo = init("no-base");
        let root = repo.with_extension("worktrees");
        let mut info = create(NewWorktree {
            project_cwd: &repo,
            root: &root,
            workspace_id: "ws",
            terminal_id: "t-1",
        })
        .unwrap();
        info.base = "vanished".to_string();

        assert!(status(&info).unwrap_err().contains("could not compare"));
        cleanup(&repo, &root);
    }

    #[test]
    fn given_any_git_command_when_running_it_then_terminal_prompts_are_disabled() {
        let command = git_command(Path::new("/Users/me/project"));
        assert!(command
            .get_envs()
            .any(|(key, value)| key == "GIT_TERMINAL_PROMPT"
                && value == Some(std::ffi::OsStr::new("0"))));
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
    fn given_worktree_values_git_could_read_as_options_when_using_them_then_they_are_refused() {
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
    fn given_an_option_like_branch_when_removing_then_no_git_runs() {
        let repo = init("remove-option");
        let root = repo.with_extension("worktrees");
        let mut info = create(NewWorktree {
            project_cwd: &repo,
            root: &root,
            workspace_id: "ws",
            terminal_id: "t-1",
        })
        .unwrap();
        info.branch = "--receive-pack=x".to_string();
        assert!(remove(&info, true).unwrap_err().contains("invalid"));
        assert!(Path::new(&info.path).exists());
        assert!(has_branch(&repo, "terra/t-1"));
        cleanup(&repo, &root);
    }
}
