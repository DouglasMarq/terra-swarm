//! Reviewing an isolated agent's work: what changed on its branch, then
//! commit, merge into the base branch, or push and open a pull request.

use serde::Serialize;
use std::path::Path;
use std::process::Command;

use super::{git, status, WorktreeInfo, WorktreeStatus};

/// The patch shown in the review is capped; the file list never is.
const MAX_PATCH_BYTES: usize = 1024 * 1024;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    /// `added`, `modified`, `deleted`, `renamed` or `untracked`.
    pub change: String,
    /// `None` for binary files.
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeDiff {
    pub status: WorktreeStatus,
    /// Everything the branch changed since it left the base, committed or not.
    pub files: Vec<ChangedFile>,
    pub patch: String,
    pub truncated: bool,
}

/// The commit the branch forked from, so the diff ignores later base work.
fn fork_point(info: &WorktreeInfo) -> Result<String, String> {
    git(Path::new(&info.path), &["merge-base", &info.base, "HEAD"])
}

fn change_kind(code: &str) -> &'static str {
    match code.chars().next() {
        Some('A') => "added",
        Some('D') => "deleted",
        Some('R') => "renamed",
        _ => "modified",
    }
}

/// `git diff --no-index` exits 1 when the files differ, which is the point.
fn diff_new_file(dir: &Path, file: &str) -> String {
    Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["diff", "--no-index", "--", "/dev/null", file])
        .output()
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
        .unwrap_or_default()
}

pub fn diff(info: &WorktreeInfo) -> Result<WorktreeDiff, String> {
    let dir = Path::new(&info.path);
    if !dir.is_dir() {
        return Err(format!("the worktree {} is gone", info.path));
    }
    let base = fork_point(info)?;
    let mut files: Vec<ChangedFile> = Vec::new();
    let kinds = git(dir, &["diff", "--name-status", "-M", &base])?;
    let counts = git(dir, &["diff", "--numstat", "-M", &base])?;
    for (kind_line, count_line) in kinds.lines().zip(counts.lines()) {
        let code = kind_line.split('\t').next().unwrap_or("M");
        // A rename lists the old and the new path; the new one is last.
        let path = kind_line
            .rsplit('\t')
            .next()
            .unwrap_or_default()
            .to_string();
        let mut numbers = count_line.split('\t');
        let additions = numbers.next().and_then(|n| n.parse().ok());
        let deletions = numbers.next().and_then(|n| n.parse().ok());
        files.push(ChangedFile {
            path,
            change: change_kind(code).into(),
            additions,
            deletions,
        });
    }
    let mut patch = git(dir, &["diff", "-M", &base])?;
    let untracked = git(dir, &["ls-files", "--others", "--exclude-standard"])?;
    for file in untracked.lines().filter(|line| !line.is_empty()) {
        let text = diff_new_file(dir, file);
        let additions = text
            .lines()
            .filter(|line| line.starts_with('+') && !line.starts_with("+++"))
            .count() as u32;
        let binary = text.contains("Binary files");
        files.push(ChangedFile {
            path: file.to_string(),
            change: "untracked".into(),
            additions: (!binary).then_some(additions),
            deletions: (!binary).then_some(0),
        });
        if !patch.is_empty() && !patch.ends_with('\n') {
            patch.push('\n');
        }
        patch.push_str(&text);
    }
    let truncated = patch.len() > MAX_PATCH_BYTES;
    if truncated {
        let mut cut = MAX_PATCH_BYTES;
        while !patch.is_char_boundary(cut) {
            cut -= 1;
        }
        patch.truncate(cut);
    }
    Ok(WorktreeDiff {
        status: status(info),
        files,
        patch,
        truncated,
    })
}

/// Commit everything in the worktree (new files included) on its branch.
pub fn commit(info: &WorktreeInfo, message: &str) -> Result<WorktreeStatus, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("a commit message is required".into());
    }
    let dir = Path::new(&info.path);
    git(dir, &["add", "-A"])?;
    if git(dir, &["diff", "--cached", "--quiet"]).is_ok() {
        return Err("there is nothing to commit".into());
    }
    git(dir, &["commit", "-q", "-m", message])?;
    Ok(status(info))
}

/// Merge the branch into its base, in the main checkout. The main checkout
/// must have the base checked out, and the worktree must be committed.
pub fn merge(info: &WorktreeInfo) -> Result<WorktreeStatus, String> {
    let current = status(info);
    if !current.dirty.is_empty() {
        return Err("commit or discard the agent's uncommitted changes first".into());
    }
    if current.ahead == 0 {
        return Err(format!(
            "{} has nothing that {} lacks",
            info.branch, info.base
        ));
    }
    let repo = Path::new(&info.repo);
    let head = git(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"]).unwrap_or_default();
    if head != info.base {
        return Err(format!(
            "the main checkout is on {}, not {}; switch it to {} to merge",
            if head.is_empty() {
                "a detached HEAD"
            } else {
                &head
            },
            info.base,
            info.base
        ));
    }
    // Never touch a merge the user has in progress there.
    if git(repo, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_ok() {
        return Err(
            "the main checkout is in the middle of a merge; finish or abort it first".into(),
        );
    }
    let message = format!("Merge {} into {}", info.branch, info.base);
    if let Err(error) = git(
        repo,
        &[
            "merge",
            "--no-ff",
            "--no-edit",
            "-m",
            &message,
            &info.branch,
        ],
    ) {
        // Leave the main checkout exactly as it was.
        let _ = git(repo, &["merge", "--abort"]);
        return Err(format!(
            "the merge did not apply cleanly, nothing was changed: {}",
            error
        ));
    }
    Ok(status(info))
}

fn run(program: &str, dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new(program)
        .current_dir(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GH_PROMPT_DISABLED", "1")
        .output()
        .map_err(|error| format!("could not run {}: {}", program, error))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("{} failed", program)
        } else {
            stderr
        })
    }
}

/// Push the branch to `origin` and open a pull request against the base
/// with the GitHub CLI. Returns the pull request's URL.
pub fn open_pull_request(info: &WorktreeInfo, title: &str, body: &str) -> Result<String, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("a title is required".into());
    }
    let current = status(info);
    if !current.dirty.is_empty() {
        return Err("commit the agent's changes before opening a pull request".into());
    }
    if current.ahead == 0 {
        return Err(format!("{} has no commits to propose", info.branch));
    }
    let dir = Path::new(&info.path);
    git(dir, &["push", "-u", "origin", &info.branch])?;
    run(
        "gh",
        dir,
        &[
            "pr",
            "create",
            "--base",
            &info.base,
            "--head",
            &info.branch,
            "--title",
            title,
            "--body",
            body,
        ],
    )
    .map(|out| out.lines().last().unwrap_or_default().to_string())
}

#[cfg(test)]
mod tests {
    use super::super::test_repo::{cleanup, init};
    use super::super::{create, git};
    use super::*;

    #[test]
    fn diff_covers_commits_edits_and_new_files() {
        let repo = init("diff");
        let root = repo.with_extension("worktrees");
        let info = create(&repo, &root, "ws", "t-1").unwrap();
        let dir = Path::new(&info.path);
        std::fs::write(dir.join("app/readme.txt"), "hello\nworld\n").unwrap();
        git(dir, &["commit", "-qam", "edit"]).unwrap();
        std::fs::write(dir.join("app/notes.md"), "a\nb\n").unwrap();
        // Work landing on the base later must not show up in the branch diff.
        std::fs::write(repo.join("other.txt"), "x").unwrap();
        git(&repo, &["add", "."]).unwrap();
        git(&repo, &["commit", "-qm", "base moves"]).unwrap();

        let diff = diff(&info).unwrap();
        assert_eq!(
            diff.files,
            vec![
                ChangedFile {
                    path: "app/readme.txt".into(),
                    change: "modified".into(),
                    additions: Some(1),
                    deletions: Some(0)
                },
                ChangedFile {
                    path: "app/notes.md".into(),
                    change: "untracked".into(),
                    additions: Some(2),
                    deletions: Some(0)
                },
            ]
        );
        assert!(diff.patch.contains("+world"));
        assert!(diff.patch.contains("+++ b/app/notes.md"));
        assert!(!diff.patch.contains("other.txt"));
        assert_eq!((diff.status.ahead, diff.status.behind), (1, 1));
        cleanup(&repo, &root);
    }

    #[test]
    fn commit_then_merge_into_the_base() {
        let repo = init("merge");
        let root = repo.with_extension("worktrees");
        let info = create(&repo, &root, "ws", "t-2").unwrap();
        assert!(commit(&info, "nothing")
            .unwrap_err()
            .contains("nothing to commit"));
        std::fs::write(Path::new(&info.path).join("feature.txt"), "done\n").unwrap();
        assert!(merge(&info).unwrap_err().contains("uncommitted"));
        let after = commit(&info, "Add the feature").unwrap();
        assert_eq!(after.ahead, 1);
        assert!(after.dirty.is_empty());

        // The main checkout must be on the base branch.
        git(&repo, &["checkout", "-q", "-b", "elsewhere"]).unwrap();
        assert!(merge(&info).unwrap_err().contains("switch it to main"));
        git(&repo, &["checkout", "-q", "main"]).unwrap();

        let merged = merge(&info).unwrap();
        assert_eq!(merged.ahead, 0);
        assert!(repo.join("feature.txt").exists());
        assert!(merge(&info).unwrap_err().contains("nothing"));
        cleanup(&repo, &root);
    }

    #[test]
    fn a_conflicting_merge_leaves_the_base_untouched() {
        let repo = init("conflict");
        let root = repo.with_extension("worktrees");
        let info = create(&repo, &root, "ws", "t-3").unwrap();
        std::fs::write(Path::new(&info.path).join("app/readme.txt"), "agent\n").unwrap();
        commit(&info, "agent edit").unwrap();
        std::fs::write(repo.join("app/readme.txt"), "human\n").unwrap();
        git(&repo, &["commit", "-qam", "human edit"]).unwrap();
        let before = git(&repo, &["rev-parse", "HEAD"]).unwrap();

        assert!(merge(&info).unwrap_err().contains("did not apply cleanly"));
        assert_eq!(git(&repo, &["rev-parse", "HEAD"]).unwrap(), before);
        assert_eq!(git(&repo, &["status", "--porcelain"]).unwrap(), "");
        cleanup(&repo, &root);
    }
}
