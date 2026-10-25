use serde::Deserialize;
use std::sync::Mutex;
use tauri::State;

use crate::sync::LockExt;
use crate::workspace::WorkspaceStore;
use crate::worktree::{self, review, WorktreeInfo, WorktreeStatus};

fn recorded(
    store: &Mutex<WorkspaceStore>,
    workspace_id: &str,
    terminal_id: &str,
) -> Result<WorktreeInfo, String> {
    let store = store.lock_or_recover();
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
    store: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    terminal_id: String,
) -> Result<Option<WorktreeStatus>, String> {
    match recorded(&store, &workspace_id, &terminal_id) {
        Ok(info) => worktree::status(&info).map(Some),
        Err(error) => {
            eprintln!("no worktree status for terminal {}: {}", terminal_id, error);
            Ok(None)
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRemoveRequest {
    pub workspace_id: String,
    pub terminal_id: String,
    pub should_delete_branch: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCommitRequest {
    pub workspace_id: String,
    pub terminal_id: String,
    pub message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreePullRequestRequest {
    pub workspace_id: String,
    pub terminal_id: String,
    pub title: String,
    pub body: String,
}

#[tauri::command(async)]
pub fn worktree_remove(
    store: State<'_, Mutex<WorkspaceStore>>,
    request: WorktreeRemoveRequest,
) -> Result<(), String> {
    let info = recorded(&store, &request.workspace_id, &request.terminal_id)?;
    worktree::remove(&info, request.should_delete_branch)
}

#[tauri::command(async)]
pub fn worktree_diff(
    store: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    terminal_id: String,
) -> Result<review::WorktreeDiff, String> {
    review::diff(&recorded(&store, &workspace_id, &terminal_id)?)
}

#[tauri::command(async)]
pub fn worktree_commit(
    store: State<'_, Mutex<WorkspaceStore>>,
    request: WorktreeCommitRequest,
) -> Result<WorktreeStatus, String> {
    let info = recorded(&store, &request.workspace_id, &request.terminal_id)?;
    review::commit(&info, &request.message)
}

#[tauri::command(async)]
pub fn worktree_merge(
    store: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    terminal_id: String,
) -> Result<WorktreeStatus, String> {
    review::merge(&recorded(&store, &workspace_id, &terminal_id)?)
}

#[tauri::command(async)]
pub fn worktree_open_pr(
    store: State<'_, Mutex<WorkspaceStore>>,
    request: WorktreePullRequestRequest,
) -> Result<String, String> {
    let info = recorded(&store, &request.workspace_id, &request.terminal_id)?;
    review::open_pull_request(&info, &request.title, &request.body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::TerminalMeta;
    use crate::worktree::test_repo::{cleanup, init};
    use crate::worktree::{create, git, NewWorktree};
    use std::path::{Path, PathBuf};
    use tauri::test::{mock_app, MockRuntime};
    use tauri::{App, Manager};

    const TERMINAL_ID: &str = "t-wt";

    struct Fixture {
        app: App<MockRuntime>,
        workspace_id: String,
        info: WorktreeInfo,
        repo: PathBuf,
        root: PathBuf,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let repo = init(name);
            let root = repo.with_extension("worktrees");
            let info = create(NewWorktree {
                project_cwd: &repo,
                root: &root,
                workspace_id: "ws",
                terminal_id: TERMINAL_ID,
            })
            .unwrap();
            let app = mock_app();
            assert!(app.manage(Mutex::new(WorkspaceStore::default())));
            let workspace_id = {
                let store = app.state::<Mutex<WorkspaceStore>>();
                let mut store = store.lock_or_recover();
                let workspace = store.create("wt".into(), repo.to_string_lossy().into_owned());
                store.record_terminal(&workspace.id, terminal(TERMINAL_ID, Some(info.clone())));
                store.record_terminal(&workspace.id, terminal("t-plain", None));
                workspace.id
            };
            Self {
                app,
                workspace_id,
                info,
                repo,
                root,
            }
        }

        fn store(&self) -> State<'_, Mutex<WorkspaceStore>> {
            self.app.state::<Mutex<WorkspaceStore>>()
        }

        fn worktree_dir(&self) -> &Path {
            Path::new(&self.info.path)
        }

        fn commit_request(&self, message: &str) -> WorktreeCommitRequest {
            WorktreeCommitRequest {
                workspace_id: self.workspace_id.clone(),
                terminal_id: TERMINAL_ID.into(),
                message: message.into(),
            }
        }

        fn pull_request(&self, title: &str) -> WorktreePullRequestRequest {
            WorktreePullRequestRequest {
                workspace_id: self.workspace_id.clone(),
                terminal_id: TERMINAL_ID.into(),
                title: title.into(),
                body: "body".into(),
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            cleanup(&self.repo, &self.root);
        }
    }

    fn terminal(id: &str, worktree: Option<WorktreeInfo>) -> TerminalMeta {
        TerminalMeta {
            id: id.into(),
            command: "claude".into(),
            width: None,
            pane_id: None,
            tab_id: None,
            group_id: None,
            is_suspended: false,
            worktree,
            role: None,
        }
    }

    #[test]
    fn given_terminals_with_and_without_a_worktree_when_reading_status_then_only_the_isolated_one_reports_it(
    ) {
        let fixture = Fixture::new("cmd-status");

        let isolated = worktree_status(
            fixture.store(),
            fixture.workspace_id.clone(),
            TERMINAL_ID.into(),
        )
        .unwrap()
        .expect("isolated terminal status");
        let plain = worktree_status(
            fixture.store(),
            fixture.workspace_id.clone(),
            "t-plain".into(),
        )
        .unwrap();
        let unknown_workspace =
            worktree_status(fixture.store(), "ws-missing".into(), TERMINAL_ID.into()).unwrap();

        assert_eq!(isolated.branch, fixture.info.branch);
        assert!(isolated.is_present);
        assert_eq!(plain, None);
        assert_eq!(unknown_workspace, None);
    }

    #[test]
    fn given_a_terminal_without_a_worktree_when_reviewing_it_then_every_command_refuses() {
        let fixture = Fixture::new("cmd-plain");
        let plain = || "t-plain".to_string();

        let diff = worktree_diff(fixture.store(), fixture.workspace_id.clone(), plain());
        let merge = worktree_merge(fixture.store(), fixture.workspace_id.clone(), plain());
        let commit = worktree_commit(
            fixture.store(),
            WorktreeCommitRequest {
                terminal_id: plain(),
                ..fixture.commit_request("message")
            },
        );

        assert!(diff.is_err_and(|error| error.contains("has no worktree")));
        assert!(merge.is_err());
        assert!(commit.is_err());
    }

    #[test]
    fn given_an_edit_in_the_worktree_when_diffing_committing_and_merging_then_it_lands_in_the_base()
    {
        let fixture = Fixture::new("cmd-flow");
        std::fs::write(
            fixture.worktree_dir().join("app/readme.txt"),
            "hello\nagent\n",
        )
        .unwrap();

        let diff = worktree_diff(
            fixture.store(),
            fixture.workspace_id.clone(),
            TERMINAL_ID.into(),
        )
        .unwrap();
        let blank = worktree_commit(fixture.store(), fixture.commit_request("   "));
        let dirty_merge = worktree_merge(
            fixture.store(),
            fixture.workspace_id.clone(),
            TERMINAL_ID.into(),
        );
        let committed =
            worktree_commit(fixture.store(), fixture.commit_request("agent edit")).unwrap();
        let empty = worktree_commit(fixture.store(), fixture.commit_request("again"));
        let merged = worktree_merge(
            fixture.store(),
            fixture.workspace_id.clone(),
            TERMINAL_ID.into(),
        )
        .unwrap();

        assert!(diff.patch.contains("+agent"));
        assert_eq!(blank, Err("a commit message is required".to_string()));
        assert!(dirty_merge.is_err_and(|error| error.contains("uncommitted")));
        assert_eq!(committed.ahead, 1);
        assert_eq!(empty, Err("there is nothing to commit".to_string()));
        assert_eq!(merged.ahead, 0);
        assert_eq!(
            std::fs::read_to_string(fixture.repo.join("app/readme.txt")).unwrap(),
            "hello\nagent\n"
        );
    }

    #[test]
    fn given_a_worktree_with_nothing_new_when_merging_or_proposing_then_it_is_refused() {
        let fixture = Fixture::new("cmd-nothing");

        let merge = worktree_merge(
            fixture.store(),
            fixture.workspace_id.clone(),
            TERMINAL_ID.into(),
        );
        let untitled = worktree_open_pr(fixture.store(), fixture.pull_request("  "));
        let nothing = worktree_open_pr(fixture.store(), fixture.pull_request("Proposal"));

        assert!(merge.is_err_and(|error| error.contains("has nothing that")));
        assert_eq!(untitled, Err("a title is required".to_string()));
        assert!(nothing.is_err_and(|error| error.contains("has no commits to propose")));
    }

    #[test]
    fn given_uncommitted_or_unpushable_changes_when_opening_a_pull_request_then_it_is_refused() {
        let fixture = Fixture::new("cmd-pr");
        std::fs::write(fixture.worktree_dir().join("app/readme.txt"), "changed\n").unwrap();

        let dirty = worktree_open_pr(fixture.store(), fixture.pull_request("Proposal"));
        git(fixture.worktree_dir(), &["commit", "-qam", "agent work"]).unwrap();
        let without_remote = worktree_open_pr(fixture.store(), fixture.pull_request("Proposal"));

        assert!(dirty.is_err_and(|error| error.contains("commit the agent's changes")));
        assert!(without_remote.is_err());
    }

    #[test]
    fn given_an_isolated_terminal_when_removing_its_worktree_then_the_checkout_and_branch_are_gone()
    {
        let fixture = Fixture::new("cmd-remove");

        worktree_remove(
            fixture.store(),
            WorktreeRemoveRequest {
                workspace_id: fixture.workspace_id.clone(),
                terminal_id: TERMINAL_ID.into(),
                should_delete_branch: true,
            },
        )
        .unwrap();

        assert!(!fixture.worktree_dir().exists());
        let branches = git(&fixture.repo, &["branch", "--list", &fixture.info.branch]).unwrap();
        assert!(branches.is_empty());
    }
}
