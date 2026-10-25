//! Branch and `git status` summary for a workspace folder.

use super::*;
use crate::sync::LockExt;
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

pub(crate) fn parse_git_status(output: &[u8]) -> Result<WorkspaceGitStatus, String> {
    let mut records = output.split(|byte| *byte == 0);
    let header = records
        .next()
        .ok_or_else(|| "git status returned no branch header".to_string())?;
    let mut status = parse_branch_header(&String::from_utf8_lossy(header))?;
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        let file = FileRecord::parse(record)?;
        if file.has_original_path() {
            // `-z` emits the original rename/copy path as the following
            // record. Consume it so it cannot be mistaken for a new status.
            let _ = records.next();
        }
        record_file(&mut status, file);
    }
    status.staged.sort_unstable();
    status.modified.sort_unstable();
    status.untracked.sort_unstable();
    status.conflicted.sort_unstable();
    Ok(status)
}

fn parse_branch_header(header: &str) -> Result<WorkspaceGitStatus, String> {
    let details = header
        .strip_prefix("## ")
        .ok_or_else(|| "git status returned an invalid branch header".to_string())?;
    let mut status = WorkspaceGitStatus {
        branch: branch_name(details),
        ..WorkspaceGitStatus::default()
    };
    apply_tracking(&mut status, details);
    Ok(status)
}

fn branch_name(details: &str) -> Option<String> {
    let branch_details = details.split(" [").next().unwrap_or(details);
    if branch_details == "HEAD (no branch)" {
        return None;
    }
    let unborn = branch_details
        .strip_prefix("No commits yet on ")
        .or_else(|| branch_details.strip_prefix("Initial commit on "));
    if let Some(name) = unborn {
        return Some(name.to_string());
    }
    let name = branch_details
        .split("...")
        .next()
        .unwrap_or(branch_details)
        .trim();
    (!name.is_empty()).then_some(name.to_string())
}

fn apply_tracking(status: &mut WorkspaceGitStatus, details: &str) {
    let Some(summary) = details
        .split_once(" [")
        .and_then(|(_, value)| value.strip_suffix(']'))
    else {
        return;
    };
    for item in summary.split(',').map(str::trim) {
        if let Some(value) = item.strip_prefix("ahead ") {
            status.ahead = value.parse().unwrap_or(0);
        } else if let Some(value) = item.strip_prefix("behind ") {
            status.behind = value.parse().unwrap_or(0);
        }
    }
}

struct FileRecord {
    index: char,
    worktree: char,
    path: String,
}

impl FileRecord {
    fn parse(record: &[u8]) -> Result<Self, String> {
        let [index, worktree, b' ', path @ ..] = record else {
            return Err(MALFORMED_FILE_RECORD.to_string());
        };
        if path.is_empty() {
            return Err(MALFORMED_FILE_RECORD.to_string());
        }
        Ok(Self {
            index: char::from(*index),
            worktree: char::from(*worktree),
            path: String::from_utf8_lossy(path).into_owned(),
        })
    }

    fn is_untracked(&self) -> bool {
        self.index == '?' && self.worktree == '?'
    }

    fn is_conflicted(&self) -> bool {
        matches!(
            (self.index, self.worktree),
            ('D', 'D')
                | ('A', 'U')
                | ('U', 'D')
                | ('U', 'A')
                | ('D', 'U')
                | ('A', 'A')
                | ('U', 'U')
        )
    }

    fn has_original_path(&self) -> bool {
        matches!(self.index, 'R' | 'C') || matches!(self.worktree, 'R' | 'C')
    }
}

const MALFORMED_FILE_RECORD: &str = "git status returned a malformed file record";

fn record_file(status: &mut WorkspaceGitStatus, file: FileRecord) {
    if file.is_untracked() {
        add_unique(&mut status.untracked, file.path);
        return;
    }
    if file.is_conflicted() {
        add_unique(&mut status.conflicted, file.path);
        // Unmerged entries form their own category. Keeping them out of
        // staged/modified avoids double-counting a conflict in the UI.
        return;
    }
    if file.index != ' ' && file.index != '?' {
        add_unique(&mut status.staged, file.path.clone());
    }
    if file.worktree != ' ' && file.worktree != '?' {
        add_unique(&mut status.modified, file.path);
    }
}

pub(crate) fn git_status_for_directory(cwd: &Path) -> Result<WorkspaceGitStatus, String> {
    let output = crate::worktree::git_command(cwd)
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
        let store = store.lock_or_recover();
        store.workspace(&workspace_id)?.cwd.clone()
    };
    git_status_for_directory(Path::new(&cwd))
}

fn git_line(cwd: &str, args: &[&str]) -> Option<String> {
    let mut command = crate::worktree::git_command(Path::new(cwd));
    command
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    crate::worktree::run_command(command, "git", "git failed")
        .ok()
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

/// Current git branch for a workspace directory, or the short commit hash
/// when HEAD is detached. None when the directory is not a git work tree.
#[tauri::command(async)]
pub fn git_branch(cwd: String) -> Option<String> {
    git_line(&cwd, &["branch", "--show-current"])
        .or_else(|| git_line(&cwd, &["rev-parse", "--short", "HEAD"]))
}
