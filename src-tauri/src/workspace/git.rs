//! Branch and `git status` summary for a workspace folder.

use super::*;
use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;
use tauri::State;

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitStatus {
    pub branch: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub staged: Vec<String>,
    pub modified: Vec<String>,
    pub untracked: Vec<String>,
    pub conflicted: Vec<String>,
}

pub(crate) fn add_unique(values: &mut Vec<String>, value: String) {
    if !values.iter().any(|existing| existing == &value) {
        values.push(value);
    }
}

pub(crate) fn parse_git_status(output: &[u8]) -> Result<WorkspaceGitStatus, String> {
    let mut records = output.split(|byte| *byte == 0);
    let header = records
        .next()
        .ok_or_else(|| "git status returned no branch header".to_string())?;
    let header = String::from_utf8_lossy(header);
    let details = header
        .strip_prefix("## ")
        .ok_or_else(|| "git status returned an invalid branch header".to_string())?;
    let branch_details = details.split(" [").next().unwrap_or(details);
    let branch = if branch_details == "HEAD (no branch)" {
        None
    } else if let Some(name) = branch_details.strip_prefix("No commits yet on ") {
        Some(name.to_string())
    } else if let Some(name) = branch_details.strip_prefix("Initial commit on ") {
        Some(name.to_string())
    } else {
        let name = branch_details
            .split("...")
            .next()
            .unwrap_or(branch_details)
            .trim();
        (!name.is_empty()).then_some(name.to_string())
    };
    let mut status = WorkspaceGitStatus {
        branch,
        ..WorkspaceGitStatus::default()
    };
    if let Some(summary) = details
        .split_once(" [")
        .and_then(|(_, value)| value.strip_suffix(']'))
    {
        for item in summary.split(',').map(str::trim) {
            if let Some(value) = item.strip_prefix("ahead ") {
                status.ahead = value.parse().unwrap_or(0);
            } else if let Some(value) = item.strip_prefix("behind ") {
                status.behind = value.parse().unwrap_or(0);
            }
        }
    }

    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        if record.len() < 4 || record[2] != b' ' {
            return Err("git status returned a malformed file record".to_string());
        }
        let index = record[0] as char;
        let worktree = record[1] as char;
        let path = String::from_utf8_lossy(&record[3..]).into_owned();
        if index == '?' && worktree == '?' {
            add_unique(&mut status.untracked, path);
            continue;
        }
        if matches!(
            (index, worktree),
            ('D', 'D')
                | ('A', 'U')
                | ('U', 'D')
                | ('U', 'A')
                | ('D', 'U')
                | ('A', 'A')
                | ('U', 'U')
        ) {
            add_unique(&mut status.conflicted, path.clone());
            // Unmerged entries form their own category. Keeping them out of
            // staged/modified avoids double-counting a conflict in the UI.
            continue;
        }
        if index != ' ' && index != '?' {
            add_unique(&mut status.staged, path.clone());
        }
        if worktree != ' ' && worktree != '?' {
            add_unique(&mut status.modified, path.clone());
        }
        if matches!(index, 'R' | 'C') || matches!(worktree, 'R' | 'C') {
            // `-z` emits the original rename/copy path as the following
            // record. Consume it so it cannot be mistaken for a new status.
            let _ = records.next();
        }
    }
    status.staged.sort_unstable();
    status.modified.sort_unstable();
    status.untracked.sort_unstable();
    status.conflicted.sort_unstable();
    Ok(status)
}

pub(crate) fn git_status_for_directory(cwd: &Path) -> Result<WorkspaceGitStatus, String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args([
            "status",
            "--porcelain=v1",
            "-z",
            "-b",
            "--untracked-files=all",
        ])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .map_err(|error| format!("failed to start git: {}", error))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            "directory is not a git repository".to_string()
        } else {
            format!("git status failed: {}", detail)
        });
    }
    parse_git_status(&output.stdout)
}

#[tauri::command(async)]
pub fn git_status(
    store: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
) -> Result<WorkspaceGitStatus, String> {
    let cwd = {
        let store = store.lock().map_err(|error| error.to_string())?;
        store.workspace(&workspace_id)?.cwd.clone()
    };
    git_status_for_directory(Path::new(&cwd))
}

/// Current git branch for a workspace directory, or the short commit hash
/// when HEAD is detached. None when the directory is not a git work tree.
#[tauri::command(async)]
pub fn git_branch(cwd: String) -> Option<String> {
    fn git(cwd: &str, args: &[&str]) -> Option<String> {
        let mut cmd = std::process::Command::new("git");
        cmd.arg("-C")
            .arg(cwd)
            .args(args)
            .env("GIT_OPTIONAL_LOCKS", "0")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let out = cmd.output().ok()?;
        if !out.status.success() {
            return None;
        }
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    }
    git(&cwd, &["branch", "--show-current"])
        .or_else(|| git(&cwd, &["rev-parse", "--short", "HEAD"]))
}
