use super::*;
use std::fs;
use std::sync::atomic::AtomicU64;

static TEST_PATH_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn test_path(label: &str) -> PathBuf {
    let id = TEST_PATH_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let directory = std::env::temp_dir().join(format!(
        "terra-swarm-workspace-{label}-{}-{id}",
        std::process::id()
    ));
    fs::create_dir_all(&directory).expect("test directory");
    directory.join("workspaces.json")
}

fn cleanup(path: &std::path::Path) {
    if let Some(parent) = path.parent() {
        let _ = fs::remove_dir_all(parent);
    }
}

#[test]
fn given_a_workspace_folder_when_listing_files_then_it_returns_bounded_relative_metadata_and_rejects_escapes(
) {
    let path = test_path("files");
    let root = path.parent().expect("test root");
    fs::create_dir_all(root.join("src")).expect("src directory");
    fs::write(
        root.join("README.md"),
        "contents stay unread by the command",
    )
    .expect("file");
    fs::write(root.join("src/main.rs"), "fn main() {}").expect("nested file");

    let listing = list_directory_entries(root, None, Some(1)).expect("listing");
    assert_eq!(listing.path, "");
    assert_eq!(listing.entries.len(), 1);
    assert!(listing.is_truncated);
    assert_eq!(listing.entries[0].kind, "directory");
    assert_eq!(listing.entries[0].path, "src");
    assert!(safe_relative_path(Some("../outside")).is_err());
    assert!(list_directory_entries(root, Some("src/../../"), None).is_err());
    cleanup(&path);
}

#[test]
fn given_porcelain_git_status_output_when_parsing_then_changes_are_grouped_by_category() {
    let raw = b"## main...origin/main [ahead 2, behind 1]\0M  src/main.rs\0 M README.md\0?? new.txt\0UU conflict.txt\0";
    let status = parse_git_status(raw).expect("git status");
    assert_eq!(status.branch.as_deref(), Some("main"));
    assert_eq!(status.ahead, 2);
    assert_eq!(status.behind, 1);
    assert_eq!(status.staged, vec!["src/main.rs"]);
    assert_eq!(status.modified, vec!["README.md"]);
    assert_eq!(status.untracked, vec!["new.txt"]);
    assert_eq!(status.conflicted, vec!["conflict.txt"]);
}

#[test]
fn given_a_repository_with_changes_when_reading_git_status_then_they_are_listed_by_category() {
    let repo = crate::worktree::test_repo::init("workspace-status");
    fs::write(repo.join("app/readme.txt"), "changed\n").expect("edit");
    fs::write(repo.join("new.txt"), "new\n").expect("new file");

    let status = git_status_for_directory(&repo).expect("git status");

    assert_eq!(status.branch.as_deref(), Some("main"));
    assert_eq!(status.modified, vec!["app/readme.txt"]);
    assert_eq!(status.untracked, vec!["new.txt"]);
    assert_eq!(
        git_branch(repo.to_string_lossy().into_owned()).as_deref(),
        Some("main")
    );
    crate::worktree::test_repo::cleanup(&repo, &repo.with_extension("worktrees"));
}

fn workspace(id: &str) -> Workspace {
    Workspace {
        id: id.to_string(),
        name: format!("Workspace {id}"),
        cwd: "/tmp".to_string(),
        terminals: vec![TerminalMeta {
            id: format!("{id}-terminal"),
            command: "shell".to_string(),
            width: None,
            pane_id: None,
            tab_id: None,
            group_id: None,
            is_suspended: false,
            worktree: None,
            role: None,
        }],
        group_id: None,
        panes: Vec::new(),
        containers: Vec::new(),
        active_pane_id: None,
        active_container_id: None,
        is_collapsed: false,
        is_archived: false,
        created_at: None,
        layout_mode: None,
        layout: None,
    }
}

#[test]
fn given_a_store_when_saving_then_it_writes_the_current_versioned_envelope() {
    let path = test_path("current");
    let store = WorkspaceStore {
        workspaces: vec![workspace("ws-current")],
        groups: Vec::new(),
        save_path: Some(path.clone()),
    };

    store.save_now();

    let value: Value = serde_json::from_str(&fs::read_to_string(&path).expect("store"))
        .expect("versioned store JSON");
    assert_eq!(value["version"], Value::from(WORKSPACE_FILE_VERSION));
    assert_eq!(value["workspaces"].as_array().map(Vec::len), Some(1));
    cleanup(&path);
}

#[test]
fn given_a_legacy_array_file_when_loading_then_it_is_migrated_on_startup() {
    let path = test_path("legacy");
    let expected = workspace("ws-legacy");
    fs::write(
        &path,
        serde_json::to_string(&vec![expected.clone()]).expect("legacy JSON"),
    )
    .expect("legacy store");

    let store = WorkspaceStore::load(path.clone());

    assert_eq!(store.workspaces, vec![expected]);
    let value: Value = serde_json::from_str(&fs::read_to_string(&path).expect("migrated store"))
        .expect("migrated JSON");
    assert_eq!(value["version"], Value::from(WORKSPACE_FILE_VERSION));
    assert!(value["workspaces"].is_array());
    cleanup(&path);
}

#[test]
fn given_a_v1_envelope_when_loading_then_it_migrates_to_v2_without_losing_terminal_metadata() {
    let path = test_path("v1");
    let expected = workspace("ws-v1");
    let raw = serde_json::json!({
        "version": LEGACY_WORKSPACE_FILE_VERSION,
        "workspaces": [{
            "id": expected.id,
            "name": expected.name,
            "cwd": expected.cwd,
            "terminals": [{
                "id": "t-v1",
                "command": "shell",
                "width": 42.0
            }]
        }]
    });
    fs::write(&path, serde_json::to_string(&raw).expect("v1 JSON")).expect("v1 store");

    let store = WorkspaceStore::load(path.clone());

    assert_eq!(store.workspaces.len(), 1);
    assert_eq!(store.workspaces[0].id, "ws-v1");
    assert_eq!(store.workspaces[0].terminals[0].id, "t-v1");
    assert_eq!(store.workspaces[0].terminals[0].width, Some(42.0));
    assert!(store.groups.is_empty());
    let persisted: Value =
        serde_json::from_str(&fs::read_to_string(&path).expect("migrated v2 store"))
            .expect("migrated v2 JSON");
    assert_eq!(persisted["version"], Value::from(WORKSPACE_FILE_VERSION));
    assert!(persisted["groups"].is_array());
    cleanup(&path);
}

#[test]
fn given_a_group_when_going_through_its_lifecycle_then_projects_and_terminal_metadata_are_preserved(
) {
    let mut store = WorkspaceStore {
        workspaces: vec![workspace("ws-group")],
        groups: Vec::new(),
        save_path: None,
    };
    let group = store.create_group(" Agents ".to_string());
    let serialized = serde_json::to_value(&group).expect("group JSON");
    assert_eq!(serialized["projectIds"], Value::Array(Vec::new()));
    let snake_group: Group = serde_json::from_value(serde_json::json!({
        "id": "group-snake",
        "name": "Snake",
        "project_ids": ["ws-group"]
    }))
    .expect("snake group aliases");
    assert_eq!(snake_group.project_ids, vec!["ws-group"]);
    store.workspaces[0].group_id = Some(group.id.clone());
    store.groups[0].project_ids.push("ws-group".to_string());
    store
        .set_terminal_placement(
            "ws-group",
            TerminalPlacement {
                terminal_id: "ws-group-terminal".to_string(),
                pane_id: "pane-group".to_string(),
                tab_id: "tab-group".to_string(),
            },
        )
        .expect("placement");

    store
        .rename_group(&group.id, "Workers".to_string())
        .expect("rename");
    let suspended = store
        .group_terminal_ids(&group.id)
        .expect("group terminals");
    store.suspend_group(&group.id).expect("suspend");
    assert_eq!(suspended, vec!["ws-group-terminal"]);
    assert_eq!(store.groups[0].name, "Workers");
    assert!(store.groups[0].is_suspended);
    assert!(store.workspaces[0].terminals[0].is_suspended);
    assert!(store.workspaces[0].panes[0].tabs[0].is_suspended);
    assert_eq!(
        store.workspaces[0].group_id.as_deref(),
        Some(group.id.as_str())
    );
    assert_eq!(store.workspaces[0].terminals.len(), 1);

    store.resume_group(&group.id).expect("resume");
    assert!(!store.groups[0].is_suspended);
    store.remove_group(&group.id).expect("remove");
    assert!(store.groups.is_empty());
    assert!(store.workspaces[0].group_id.is_none());
    assert_eq!(store.workspaces[0].terminals.len(), 1);
}

#[test]
fn given_a_workspace_when_assigning_it_to_a_group_then_both_sides_stay_consistent() {
    let mut store = WorkspaceStore {
        workspaces: vec![workspace("ws-assign")],
        groups: vec![
            Group {
                id: "group-a".to_string(),
                name: "A".to_string(),
                color: None,
                icon_url: None,
                is_collapsed: false,
                project_ids: vec!["ws-assign".to_string(), "ws-assign".to_string()],
                parent_group_id: None,
                layout_mode: None,
                is_suspended: false,
                is_archived: false,
                created_at: None,
            },
            Group {
                id: "group-b".to_string(),
                name: "B".to_string(),
                color: None,
                icon_url: None,
                is_collapsed: false,
                project_ids: vec!["ws-assign".to_string()],
                parent_group_id: None,
                layout_mode: None,
                is_suspended: false,
                is_archived: false,
                created_at: None,
            },
        ],
        save_path: None,
    };

    store
        .set_workspace_group("ws-assign", Some("group-a".to_string()))
        .expect("assign");
    assert_eq!(store.workspaces[0].group_id.as_deref(), Some("group-a"));
    assert_eq!(
        store.workspaces[0].terminals[0].group_id.as_deref(),
        Some("group-a")
    );
    assert_eq!(store.groups[0].project_ids, vec!["ws-assign"]);
    assert!(store.groups[1].project_ids.is_empty());

    store
        .set_workspace_group("ws-assign", None)
        .expect("unassign");
    assert!(store.workspaces[0].group_id.is_none());
    assert!(store.workspaces[0].terminals[0].group_id.is_none());
    assert!(store
        .groups
        .iter()
        .all(|group| group.project_ids.is_empty()));
}

#[test]
fn given_a_terminal_when_placing_it_then_pane_and_tab_metadata_are_created_and_normalized() {
    let mut store = WorkspaceStore {
        workspaces: vec![workspace("ws-place")],
        groups: Vec::new(),
        save_path: None,
    };

    store
        .set_terminal_placement(
            "ws-place",
            TerminalPlacement {
                terminal_id: "ws-place-terminal".to_string(),
                pane_id: "pane-one".to_string(),
                tab_id: "tab-one".to_string(),
            },
        )
        .expect("first placement");
    assert_eq!(
        store.workspaces[0].terminals[0].pane_id.as_deref(),
        Some("pane-one")
    );
    assert_eq!(
        store.workspaces[0].terminals[0].tab_id.as_deref(),
        Some("tab-one")
    );
    assert_eq!(store.workspaces[0].panes.len(), 1);
    assert_eq!(
        store.workspaces[0].panes[0].active_tab_id.as_deref(),
        Some("tab-one")
    );
    assert_eq!(
        store.workspaces[0].panes[0].tabs[0].pty_id.as_deref(),
        Some("ws-place-terminal")
    );

    store
        .set_terminal_placement(
            "ws-place",
            TerminalPlacement {
                terminal_id: "ws-place-terminal".to_string(),
                pane_id: "pane-two".to_string(),
                tab_id: "tab-two".to_string(),
            },
        )
        .expect("second placement");
    assert_eq!(store.workspaces[0].panes[0].tabs.len(), 0);
    assert_eq!(store.workspaces[0].panes[1].id, "pane-two");
    assert_eq!(store.workspaces[0].panes[1].tabs.len(), 1);
    assert_eq!(store.workspaces[0].panes[1].tabs[0].id, "tab-two");

    store
        .set_active_pane("ws-place", Some("pane-two".to_string()))
        .expect("active pane");
    assert_eq!(
        store.workspaces[0].active_pane_id.as_deref(),
        Some("pane-two")
    );
    store
        .set_active_pane("ws-place", None)
        .expect("clear active pane");
    assert!(store.workspaces[0].active_pane_id.is_none());
}

#[test]
fn given_a_store_with_invalid_entries_when_loading_then_valid_entries_are_recovered_and_a_backup_is_kept(
) {
    let path = test_path("invalid");
    let mut first = workspace("ws-one");
    first.terminals[0].width = Some(1000.0);
    first.terminals.push(TerminalMeta {
        id: first.terminals[0].id.clone(),
        command: "duplicate".to_string(),
        width: Some(-5.0),
        pane_id: None,
        tab_id: None,
        group_id: None,
        is_suspended: false,
        worktree: None,
        role: None,
    });
    let mut duplicate_workspace = workspace("ws-one");
    duplicate_workspace.name = "duplicate workspace".to_string();
    let empty_id = Workspace {
        id: "   ".to_string(),
        name: "invalid".to_string(),
        cwd: "/tmp".to_string(),
        terminals: Vec::new(),
        group_id: None,
        panes: Vec::new(),
        containers: Vec::new(),
        active_pane_id: None,
        active_container_id: None,
        is_collapsed: false,
        is_archived: false,
        created_at: None,
        layout_mode: None,
        layout: None,
    };
    let malformed = serde_json::json!({"id": "missing required fields"});
    let content = serde_json::json!({
        "version": WORKSPACE_FILE_VERSION,
        "workspaces": [first, duplicate_workspace, empty_id, malformed],
    });
    fs::write(&path, serde_json::to_string(&content).expect("store JSON")).expect("invalid store");

    let store = WorkspaceStore::load(path.clone());

    assert_eq!(store.workspaces.len(), 1);
    assert_eq!(store.workspaces[0].id, "ws-one");
    assert_eq!(store.workspaces[0].terminals.len(), 1);
    assert_eq!(store.workspaces[0].terminals[0].width, Some(100.0));
    assert!(path.with_extension("json.bak").exists());
    let persisted: Value =
        serde_json::from_str(&fs::read_to_string(&path).expect("normalized store"))
            .expect("normalized JSON");
    assert_eq!(persisted["version"], Value::from(WORKSPACE_FILE_VERSION));
    cleanup(&path);
}

#[test]
fn given_terminal_ids_repeated_across_workspaces_when_loading_then_they_are_deduplicated_without_touching_scrollback(
) {
    let path = test_path("cross-workspace-terminal-ids");
    let scrollback_dir = path
        .parent()
        .expect("workspace directory")
        .join("scrollback");
    fs::create_dir_all(&scrollback_dir).expect("scrollback directory");
    let scrollback_path = scrollback_dir.join("shared-terminal.scrollback");
    fs::write(&scrollback_path, b"valid durable output").expect("scrollback");

    let mut first = workspace("ws-first");
    first.terminals[0].id = "shared-terminal".to_string();
    let mut second = workspace("ws-second");
    second.terminals[0].id = "shared-terminal".to_string();
    let content = serde_json::json!({
        "version": WORKSPACE_FILE_VERSION,
        "workspaces": [first, second],
    });
    fs::write(&path, serde_json::to_string(&content).expect("store JSON"))
        .expect("workspace store");

    let mut store = WorkspaceStore::load(path.clone());

    assert_eq!(store.workspaces.len(), 2);
    assert_eq!(store.workspaces[0].terminals.len(), 1);
    assert_eq!(store.workspaces[1].terminals.len(), 0);
    assert_eq!(store.terminal_owner("shared-terminal"), Some("ws-first"));
    assert!(path.with_extension("json.bak").exists());
    assert_eq!(
        fs::read(&scrollback_path).expect("preserved scrollback"),
        b"valid durable output"
    );

    store.forget_terminal("shared-terminal");
    assert!(store
        .workspaces
        .iter()
        .all(|workspace| workspace.terminals.is_empty()));
    assert_eq!(
        fs::read(&scrollback_path).expect("scrollback remains"),
        b"valid durable output"
    );

    cleanup(&path);
}

#[test]
fn given_corrupt_json_when_loading_then_it_is_backed_up_without_being_overwritten() {
    let path = test_path("corrupt");
    fs::write(&path, "not valid JSON").expect("corrupt store");

    let store = WorkspaceStore::load(path.clone());

    assert!(store.workspaces.is_empty());
    assert!(!path.exists());
    assert!(path.with_extension("json.bak").exists());
    cleanup(&path);
}

#[cfg(unix)]
#[test]
fn given_an_unreadable_store_when_loading_then_the_file_is_kept_and_not_saved() {
    use std::os::unix::fs::PermissionsExt;
    let path = test_path("unreadable");
    let original = serde_json::to_string(&vec![workspace("ws-kept")]).expect("store JSON");
    fs::write(&path, &original).expect("store");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).expect("chmod");
    if fs::read(&path).is_ok() {
        cleanup(&path);
        return;
    }

    let mut store = WorkspaceStore::load(path.clone());
    store.create("New".to_string(), "/Users/me/project".to_string());
    store.save_now();

    assert!(store.save_path.is_none());
    assert!(!path.with_extension("json.bak").exists());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("chmod");
    assert_eq!(fs::read_to_string(&path).expect("store"), original);
    cleanup(&path);
}

#[test]
fn given_a_store_that_is_not_utf8_when_loading_then_it_is_backed_up_before_starting_fresh() {
    let path = test_path("not-utf8");
    fs::write(&path, [0xff, 0xfe, 0x00]).expect("store");

    let store = WorkspaceStore::load(path.clone());

    assert!(store.workspaces.is_empty());
    assert_eq!(
        fs::read(path.with_extension("json.bak")).expect("backup"),
        vec![0xff, 0xfe, 0x00]
    );
    cleanup(&path);
}

#[test]
fn given_unknown_or_duplicate_ids_when_reordering_workspaces_then_the_order_is_stable_and_they_are_ignored(
) {
    let first = workspace("ws-one");
    let second = workspace("ws-two");
    let mut store = WorkspaceStore {
        workspaces: vec![first, second],
        groups: Vec::new(),
        save_path: None,
    };

    store.reorder_workspaces(&[
        "ws-two".to_string(),
        "unknown".to_string(),
        "ws-two".to_string(),
    ]);
    assert_eq!(
        store
            .workspaces
            .iter()
            .map(|workspace| workspace.id.as_str())
            .collect::<Vec<_>>(),
        vec!["ws-two", "ws-one"]
    );
}

#[test]
fn given_visual_layout_operations_when_applying_them_then_they_persist_and_never_remove_ptys() {
    let mut first = workspace("ws-layout");
    first.terminals.push(TerminalMeta {
        id: "ws-layout-terminal-two".to_string(),
        command: "worker".to_string(),
        width: None,
        pane_id: None,
        tab_id: None,
        group_id: None,
        is_suspended: false,
        worktree: None,
        role: None,
    });
    let mut store = WorkspaceStore {
        workspaces: vec![first],
        groups: Vec::new(),
        save_path: None,
    };
    store
        .set_terminal_placement(
            "ws-layout",
            TerminalPlacement {
                terminal_id: "ws-layout-terminal".to_string(),
                pane_id: "pane-one".to_string(),
                tab_id: "tab-one".to_string(),
            },
        )
        .expect("first pane placement");
    store
        .set_terminal_placement(
            "ws-layout",
            TerminalPlacement {
                terminal_id: "ws-layout-terminal-two".to_string(),
                pane_id: "pane-two".to_string(),
                tab_id: "tab-two".to_string(),
            },
        )
        .expect("second pane placement");
    let first_container_id = store.workspaces[0].containers[0].id.clone();
    store.workspaces[0]
        .containers
        .push(WorkspaceStore::new_container(
            "ws-layout",
            "container-secondary".to_string(),
        ));
    store
        .reorder_panes(
            "ws-layout",
            PaneReorder {
                container_id: &first_container_id,
                order: &["pane-two".to_string(), "pane-one".to_string()],
            },
        )
        .expect("pane reorder");
    store
        .move_pane(
            "ws-layout",
            PaneMove {
                pane_id: "pane-two".to_string(),
                to_container_id: "container-secondary".to_string(),
                index: Some(0),
            },
        )
        .expect("pane move");
    store
        .set_container_state(
            "ws-layout",
            ContainerStateChange {
                container_id: "container-secondary",
                patch: WorkspaceContainerPatch {
                    is_collapsed: Some(true),
                    is_fullscreen: Some(true),
                    active_pane_id: Some("pane-two".to_string()),
                    internal_layout: Some("vertical".to_string()),
                    size: Some(42.0),
                    ..WorkspaceContainerPatch::default()
                },
            },
        )
        .expect("container state");
    store
        .set_layout(
            "ws-layout",
            WorkspaceLayout {
                mode: "spotlight".to_string(),
                item_ids: vec![
                    first_container_id.clone(),
                    "container-secondary".to_string(),
                ],
                sizes: HashMap::from([
                    (first_container_id.clone(), 60.0),
                    ("container-secondary".to_string(), 40.0),
                ]),
                ..WorkspaceLayout::default()
            },
        )
        .expect("workspace layout");
    store
        .set_collapsed("ws-layout", true)
        .expect("workspace collapse");

    let workspace = &store.workspaces[0];
    assert_eq!(workspace.terminals.len(), 2);
    assert_eq!(workspace.layout_mode.as_deref(), Some("spotlight"));
    assert!(workspace.is_collapsed);
    assert_eq!(workspace.containers[1].pane_ids, vec!["pane-two"]);
    assert!(workspace.containers[1].is_collapsed);
    assert!(workspace.containers[1].is_fullscreen);
    assert_eq!(
        workspace.containers[1].active_pane_id.as_deref(),
        Some("pane-two")
    );
    assert_eq!(workspace.containers[1].internal_layout, "vertical");
    assert_eq!(
        workspace.panes[1].container_id.as_deref(),
        Some("container-secondary")
    );
    let serialized = store.serialized_snapshot().expect("layout JSON");
    let value: Value = serde_json::from_str(&serialized).expect("serialized JSON");
    assert_eq!(value["workspaces"][0]["layout"]["mode"], "spotlight");
    assert_eq!(
        value["workspaces"][0]["containers"][1]["activePaneId"],
        "pane-two"
    );
}

#[test]
fn given_a_width_when_setting_it_then_non_finite_values_are_rejected_and_finite_ones_clamped() {
    let mut store = WorkspaceStore {
        workspaces: vec![workspace("ws-width")],
        groups: Vec::new(),
        save_path: None,
    };
    let terminal_id = store.workspaces[0].terminals[0].id.clone();

    store
        .set_width(
            "ws-width",
            TerminalWidth {
                terminal_id: &terminal_id,
                width: f64::NAN,
            },
        )
        .expect("width");
    assert_eq!(store.workspaces[0].terminals[0].width, None);
    store
        .set_width(
            "ws-width",
            TerminalWidth {
                terminal_id: &terminal_id,
                width: f64::INFINITY,
            },
        )
        .expect("width");
    assert_eq!(store.workspaces[0].terminals[0].width, None);
    store
        .set_width(
            "ws-width",
            TerminalWidth {
                terminal_id: &terminal_id,
                width: 1.0,
            },
        )
        .expect("width");
    assert_eq!(
        store.workspaces[0].terminals[0].width,
        Some(MIN_TERMINAL_WIDTH)
    );
}

#[test]
fn given_an_unknown_workspace_or_terminal_when_setting_width_then_it_reports_not_found() {
    let mut store = WorkspaceStore {
        workspaces: vec![workspace("ws-1")],
        groups: Vec::new(),
        save_path: None,
    };

    assert!(store
        .set_width(
            "ws-missing",
            TerminalWidth {
                terminal_id: "ws-1-terminal",
                width: 40.0
            }
        )
        .unwrap_err()
        .contains("workspace ws-missing not found"));
    assert!(store
        .set_width(
            "ws-1",
            TerminalWidth {
                terminal_id: "t-missing",
                width: 40.0
            }
        )
        .unwrap_err()
        .contains("terminal t-missing not found"));
    assert_eq!(store.workspaces[0].terminals[0].width, None);
}

#[test]
fn given_an_unknown_workspace_when_renaming_then_it_reports_not_found() {
    let mut store = WorkspaceStore {
        workspaces: vec![workspace("ws-1")],
        groups: Vec::new(),
        save_path: None,
    };

    assert!(store
        .rename("ws-missing", "Renamed".to_string())
        .unwrap_err()
        .contains("workspace ws-missing not found"));
    store
        .rename("ws-1", "  Renamed  ".to_string())
        .expect("rename");
    assert_eq!(store.workspaces[0].name, "Renamed");
    store.rename("ws-1", "   ".to_string()).expect("blank name");
    assert_eq!(store.workspaces[0].name, "Renamed");
}

#[test]
fn given_an_exported_snapshot_when_importing_it_then_the_layout_is_preserved_and_sessions_are_suspended(
) {
    let source = test_path("transfer-roundtrip-source");
    let mut original = WorkspaceStore {
        workspaces: vec![workspace("ws-transfer")],
        groups: Vec::new(),
        save_path: None,
    };
    let group = original.create_group("Imported agents".to_string());
    original
        .set_workspace_group("ws-transfer", Some(group.id.clone()))
        .expect("group assignment");
    original
        .set_terminal_placement(
            "ws-transfer",
            TerminalPlacement {
                terminal_id: "ws-transfer-terminal".to_string(),
                pane_id: "pane-transfer".to_string(),
                tab_id: "tab-transfer".to_string(),
            },
        )
        .expect("terminal placement");
    let json = original.serialized_snapshot().expect("snapshot JSON");
    write_atomic(&source, &json).expect("write source snapshot");

    let raw = fs::read_to_string(&source).expect("source snapshot");
    let mut imported = parse_import_snapshot(&raw).expect("strict roundtrip parse");
    assert_eq!(imported.workspaces, original.workspaces);
    assert_eq!(imported.groups, original.groups);
    mark_imported_sessions_suspended(&mut imported);
    assert!(imported.workspaces[0].terminals[0].is_suspended);
    assert!(imported.workspaces[0].panes[0].tabs[0].is_suspended);
    assert_eq!(
        imported.workspaces[0].panes[0].tabs[0].pty_id.as_deref(),
        Some("ws-transfer-terminal")
    );
    assert_eq!(
        transfer_summary(&imported, &source).suspended_terminal_count,
        1
    );
    cleanup(&source);
}

#[test]
fn given_an_unknown_snapshot_version_when_importing_then_it_is_rejected_before_replacing_state() {
    let raw = serde_json::json!({
        "version": WORKSPACE_FILE_VERSION + 1,
        "workspaces": [],
        "groups": []
    });
    assert!(parse_import_snapshot(&serde_json::to_string(&raw).expect("version JSON")).is_err());
}

#[test]
fn given_malformed_json_or_entries_when_importing_then_they_are_rejected() {
    assert!(parse_import_snapshot("{not json").is_err());
    let malformed_entry = serde_json::json!({
        "version": WORKSPACE_FILE_VERSION,
        "workspaces": [{"id": "missing required metadata"}],
        "groups": []
    });
    assert!(parse_import_snapshot(
        &serde_json::to_string(&malformed_entry).expect("malformed entry JSON")
    )
    .is_err());
}

#[test]
fn given_an_existing_store_when_replacing_it_then_a_recoverable_backup_is_kept_and_the_file_is_written_atomically(
) {
    let current = test_path("transfer-backup");
    fs::write(&current, "previous workspace file").expect("current store");
    let replacement = WorkspaceStore {
        workspaces: vec![workspace("ws-imported")],
        groups: Vec::new(),
        save_path: None,
    };
    let json = replacement.serialized_snapshot().expect("replacement JSON");

    let backup = replace_store_file(&current, &json)
        .expect("replace store")
        .expect("backup path");
    assert_eq!(
        fs::read_to_string(&backup).expect("backup content"),
        "previous workspace file"
    );
    let loaded: Value =
        serde_json::from_str(&fs::read_to_string(&current).expect("new current store"))
            .expect("new current JSON");
    assert_eq!(loaded["version"], Value::from(WORKSPACE_FILE_VERSION));
    assert_eq!(loaded["workspaces"][0]["id"], Value::from("ws-imported"));
    let temp_prefix = format!(
        ".{}.tmp-{}-",
        current
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(""),
        std::process::id()
    );
    let has_leftover_temp = fs::read_dir(current.parent().expect("current parent"))
        .expect("current directory")
        .filter_map(Result::ok)
        .any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(&temp_prefix)
        });
    assert!(!has_leftover_temp);
    cleanup(&current);
}

#[test]
fn given_a_relative_or_traversal_snapshot_path_when_resolving_it_then_it_is_rejected() {
    assert!(validate_explicit_path("snapshot.json").is_err());
    assert!(validate_explicit_path("/tmp/../snapshot.json").is_err());
    assert!(validate_explicit_path("\0snapshot.json").is_err());
}

fn workspace_with_worktree_branch(id: &str, branch: &str) -> Workspace {
    let checkout = std::env::temp_dir().join("terra-worktrees").join(id);
    let mut workspace = workspace(id);
    workspace.terminals[0].worktree = Some(crate::worktree::WorktreeInfo {
        path: checkout.to_string_lossy().into_owned(),
        cwd: checkout.to_string_lossy().into_owned(),
        branch: branch.to_string(),
        base: "main".to_string(),
        repo: std::env::temp_dir().to_string_lossy().into_owned(),
    });
    workspace
}

#[test]
fn given_a_stored_worktree_with_an_option_like_branch_when_loading_then_it_is_dropped() {
    let mut store = WorkspaceStore {
        workspaces: vec![
            workspace_with_worktree_branch("ws-1", "--receive-pack=touch /tmp/x"),
            workspace_with_worktree_branch("ws-2", "terra/t-2"),
        ],
        groups: Vec::new(),
        save_path: None,
    };

    assert!(!store.is_normalized());
    store.normalize();
    assert_eq!(store.workspaces[0].terminals[0].worktree, None);
    assert_eq!(store.workspaces[0].terminals[0].id, "ws-1-terminal");
    assert!(store.workspaces[1].terminals[0].worktree.is_some());
}

#[test]
fn given_a_snapshot_with_an_invalid_worktree_when_importing_then_it_is_refused() {
    let raw = serde_json::json!({
        "version": WORKSPACE_FILE_VERSION,
        "workspaces": [workspace_with_worktree_branch("ws-1", "terra/../../main")],
        "groups": [],
    })
    .to_string();

    assert!(parse_import_snapshot(&raw).is_err());
}

const OLD_FLAG_NAMES_FIXTURE: &str = include_str!("fixtures/workspaces-old-flag-names.json");

fn assert_old_flags_survived(store: &WorkspaceStore) {
    let workspace = &store.workspaces[0];
    assert!(workspace.is_collapsed);
    assert!(workspace.is_archived);
    assert!(workspace.terminals[0].is_suspended);
    let pane = &workspace.panes[0];
    assert!(pane.is_disabled);
    assert!(pane.is_collapsed);
    assert!(pane.tabs[0].has_unread_completion);
    assert!(pane.tabs[0].is_suspended);
    let container = &workspace.containers[0];
    assert!(container.is_collapsed);
    assert!(!container.is_visible);
    assert!(container.is_closed);
    assert!(container.is_fullscreen);
    let group = &store.groups[0];
    assert!(group.is_collapsed);
    assert!(group.is_suspended);
    assert!(group.is_archived);
}

#[test]
fn given_a_store_written_with_the_old_flag_names_when_loading_then_every_flag_survives_and_saves_under_the_new_names(
) {
    let path = test_path("old-flag-names");
    fs::write(&path, OLD_FLAG_NAMES_FIXTURE).expect("old store");

    let store = WorkspaceStore::load(path.clone());

    assert_old_flags_survived(&store);
    store.save_now();
    let saved: Value =
        serde_json::from_str(&fs::read_to_string(&path).expect("saved store")).expect("saved JSON");
    let saved_workspace = &saved["workspaces"][0];
    assert_eq!(saved_workspace["isCollapsed"], Value::Bool(true));
    assert!(saved_workspace.get("collapsed").is_none());
    assert_eq!(
        saved_workspace["panes"][0]["tabs"][0]["hasUnreadCompletion"],
        Value::Bool(true)
    );
    assert_eq!(
        saved_workspace["containers"][0]["isVisible"],
        Value::Bool(false)
    );
    assert_eq!(saved["groups"][0]["isSuspended"], Value::Bool(true));
    cleanup(&path);
}

#[test]
fn given_a_snapshot_exported_with_the_old_flag_names_when_importing_then_every_flag_survives() {
    let imported = parse_import_snapshot(OLD_FLAG_NAMES_FIXTURE).expect("old snapshot");

    assert_old_flags_survived(&imported);
}

mod command_tests {
    use super::*;
    use crate::ipc_error::IpcErrorCode;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    use tauri::test::{mock_app, MockRuntime};
    use tauri::{App, Manager, State};

    const SAVE_DEADLINE: Duration = Duration::from_secs(5);

    fn app_with(store: WorkspaceStore) -> App<MockRuntime> {
        let app = mock_app();
        assert!(app.manage(Mutex::new(store)));
        app
    }

    fn state(app: &App<MockRuntime>) -> State<'_, Mutex<WorkspaceStore>> {
        app.state::<Mutex<WorkspaceStore>>()
    }

    fn real_folder(label: &str) -> PathBuf {
        let path = test_path(label);
        path.parent()
            .expect("test folder")
            .canonicalize()
            .expect("canonical test folder")
    }

    fn store_in(folder: &std::path::Path) -> WorkspaceStore {
        let mut entry = workspace("ws-folder");
        entry.cwd = folder.to_string_lossy().into_owned();
        WorkspaceStore {
            workspaces: vec![entry],
            groups: Vec::new(),
            save_path: None,
        }
    }

    fn read(app: &App<MockRuntime>, relative: &str) -> Result<WorkspaceFileContent, String> {
        read_workspace_file(state(app), "ws-folder".into(), relative.into())
    }

    fn write(
        app: &App<MockRuntime>,
        content: &str,
        expected_modified: Option<u64>,
    ) -> Result<WorkspaceFileSaved, crate::ipc_error::IpcError> {
        write_workspace_file(
            state(app),
            WorkspaceFileWriteRequest {
                workspace_id: "ws-folder".into(),
                relative_path: "notes.txt".into(),
                content: content.into(),
                expected_modified,
            },
        )
    }

    fn listing(
        app: &App<MockRuntime>,
        relative_path: Option<&str>,
        limit: Option<usize>,
    ) -> Result<WorkspaceFileListing, String> {
        list_workspace_files(
            state(app),
            WorkspaceFileListRequest {
                workspace_id: "ws-folder".into(),
                relative_path: relative_path.map(str::to_string),
                limit,
            },
        )
    }

    #[test]
    fn given_a_store_with_a_workspace_and_a_group_when_listing_them_then_both_are_returned() {
        let mut store = WorkspaceStore {
            workspaces: vec![workspace("ws-listed")],
            groups: Vec::new(),
            save_path: None,
        };
        store.create_group("Listed group".into());
        let app = app_with(store);

        let workspaces = list_workspaces(state(&app)).unwrap();
        let groups = list_groups(state(&app)).unwrap();

        assert_eq!(workspaces[0].id, "ws-listed");
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].name, "Listed group");
    }

    #[test]
    fn given_a_store_with_and_without_a_file_when_reading_its_save_time_then_only_the_saved_one_has_it(
    ) {
        let path = test_path("saved-at");
        fs::write(&path, "{}").unwrap();
        let unsaved = app_with(WorkspaceStore::default());
        let saved = app_with(WorkspaceStore {
            save_path: Some(path.clone()),
            ..WorkspaceStore::default()
        });

        assert_eq!(store_saved_at(state(&unsaved)).unwrap(), None);
        assert!(store_saved_at(state(&saved))
            .unwrap()
            .is_some_and(|millis| millis > 0));
        cleanup(&path);
    }

    #[test]
    fn given_a_valid_target_when_exporting_a_snapshot_then_it_is_written_and_summarized() {
        let folder = real_folder("export");
        let target = folder.join("snapshot.json");
        let app = app_with(WorkspaceStore {
            workspaces: vec![workspace("ws-exported")],
            groups: Vec::new(),
            save_path: None,
        });

        let transfer =
            export_workspace_snapshot(state(&app), target.to_string_lossy().into_owned()).unwrap();
        let relative = export_workspace_snapshot(state(&app), "snapshot.json".into());

        assert_eq!(transfer.workspace_count, 1);
        assert_eq!(transfer.terminal_count, 1);
        assert_eq!(transfer.suspended_terminal_count, 0);
        let exported = parse_import_snapshot(&read_snapshot_file(&target).unwrap()).unwrap();
        assert_eq!(exported.workspaces[0].id, "ws-exported");
        assert!(relative.is_err());
        let _ = fs::remove_dir_all(folder);
    }

    #[test]
    fn given_targets_that_are_not_plain_files_when_validating_a_snapshot_path_then_they_are_rejected(
    ) {
        let folder = real_folder("validate");
        let file = folder.join("file.txt");
        fs::write(&file, "x").unwrap();
        let link = folder.join("link");
        std::os::unix::fs::symlink(&folder, &link).unwrap();

        let empty = validate_explicit_path("   ");
        let root = validate_explicit_path("/");
        let directory = validate_explicit_path(&folder.to_string_lossy());
        let through_file = validate_explicit_path(&file.join("child.json").to_string_lossy());
        let through_link = validate_explicit_path(&link.join("child.json").to_string_lossy());
        let fresh = validate_explicit_path(&folder.join("new/child.json").to_string_lossy());

        assert_eq!(empty, Err("snapshot path cannot be empty".to_string()));
        assert_eq!(root, Err("snapshot path must name a file".to_string()));
        assert_eq!(
            directory,
            Err("snapshot path must be a file, not a directory".to_string())
        );
        assert_eq!(
            through_file,
            Err("snapshot path contains a non-directory component".to_string())
        );
        assert_eq!(
            through_link,
            Err("snapshot path cannot traverse a symlink".to_string())
        );
        assert_eq!(fresh, Ok(folder.join("new/child.json")));
        let _ = fs::remove_dir_all(folder);
    }

    #[test]
    fn given_a_workspace_file_when_reading_and_saving_it_through_the_commands_then_changes_on_disk_are_detected(
    ) {
        let folder = real_folder("editor-commands");
        fs::write(folder.join("notes.txt"), "first").unwrap();
        let app = app_with(store_in(&folder));

        let opened = read(&app, "notes.txt").unwrap();
        let stale = write(&app, "lost", Some(opened.modified.saturating_add(1))).unwrap_err();
        let saved = write(&app, "second", Some(opened.modified)).unwrap();
        let unknown = read_workspace_file(state(&app), "ws-missing".into(), "notes.txt".into());

        assert_eq!(opened.content, "first");
        assert!(!opened.is_binary);
        assert_eq!(stale.code, IpcErrorCode::ChangedOnDisk);
        assert_eq!(saved.size, 6);
        assert_eq!(
            fs::read_to_string(folder.join("notes.txt")).unwrap(),
            "second"
        );
        assert!(unknown.is_err());
        let _ = fs::remove_dir_all(folder);
    }

    #[test]
    fn given_files_the_editor_cannot_open_when_reading_them_then_each_is_refused() {
        let folder = real_folder("editor-refusals");
        let outside = real_folder("editor-outside");
        fs::write(outside.join("secret.txt"), "secret").unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), folder.join("escape.txt")).unwrap();
        fs::create_dir_all(folder.join("dir")).unwrap();
        fs::write(folder.join("blob.bin"), [0u8, 1, 2]).unwrap();
        let large = fs::File::create(folder.join("large.txt")).unwrap();
        large.set_len(MAX_EDIT_BYTES + 1).unwrap();
        let app = app_with(store_in(&folder));

        let binary = read(&app, "blob.bin").unwrap();

        assert!(binary.is_binary);
        assert!(binary.content.is_empty());
        assert_eq!(read(&app, " "), Err("choose a file".to_string()));
        assert_eq!(read(&app, "dir"), Err("not a regular file".to_string()));
        assert_eq!(
            read(&app, "escape.txt"),
            Err("file path cannot escape the workspace".to_string())
        );
        assert!(read(&app, "large.txt").is_err_and(|error| error.contains("too large")));
        assert!(read(&app, "missing.txt").is_err_and(|error| error.contains("unavailable")));
        let _ = fs::remove_dir_all(folder);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn given_text_over_the_edit_limit_when_saving_then_it_is_refused() {
        let folder = real_folder("editor-large-save");
        fs::write(folder.join("notes.txt"), "small").unwrap();
        let app = app_with(store_in(&folder));
        let too_large = "x".repeat(usize::try_from(MAX_EDIT_BYTES).unwrap() + 1);

        let result = write(&app, &too_large, None);

        assert!(result.is_err_and(|error| error.code == IpcErrorCode::Other));
        assert_eq!(
            fs::read_to_string(folder.join("notes.txt")).unwrap(),
            "small"
        );
        let _ = fs::remove_dir_all(folder);
    }

    #[test]
    fn given_a_workspace_folder_when_listing_it_through_the_command_then_directories_come_first_and_bad_requests_fail(
    ) {
        let folder = real_folder("list-command");
        fs::create_dir_all(folder.join("src")).unwrap();
        fs::write(folder.join("b.txt"), "b").unwrap();
        fs::write(folder.join("A.txt"), "a").unwrap();
        std::os::unix::fs::symlink(folder.join("b.txt"), folder.join("c-link")).unwrap();
        let app = app_with(store_in(&folder));

        let root = listing(&app, None, None).unwrap();
        let names: Vec<&str> = root
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect();

        assert_eq!(names, vec!["src", "A.txt", "b.txt", "c-link"]);
        assert_eq!(root.entries[3].kind, "symlink");
        assert_eq!(root.entries[1].size, Some(1));
        assert!(listing(&app, None, Some(0)).is_err());
        assert_eq!(
            listing(&app, Some("b.txt"), None),
            Err("requested file path is not a directory".to_string())
        );
        assert!(listing(&app, Some("missing"), None).is_err());
        let _ = fs::remove_dir_all(folder);
    }

    #[test]
    fn given_repositories_and_plain_folders_when_reading_git_state_then_detached_heads_and_non_repositories_are_handled(
    ) {
        let repo = crate::worktree::test_repo::init("git-commands");
        let plain = real_folder("git-plain");
        let app = app_with(store_in(&repo));

        let status = git_status(state(&app), "ws-folder".into()).unwrap();
        crate::worktree::git(&repo, &["checkout", "-q", "--detach"]).unwrap();
        let detached = git_branch(repo.to_string_lossy().into_owned());
        let short_head = crate::worktree::git(&repo, &["rev-parse", "--short", "HEAD"]).unwrap();

        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(detached, Some(short_head));
        assert_eq!(git_branch(plain.to_string_lossy().into_owned()), None);
        assert!(git_status_for_directory(&plain).is_err());
        assert!(git_status(state(&app), "ws-missing".into()).is_err());
        crate::worktree::test_repo::cleanup(&repo, &repo.with_extension("worktrees"));
        let _ = fs::remove_dir_all(plain);
    }

    #[test]
    fn given_malformed_store_envelopes_when_decoding_then_each_is_rejected_with_its_reason() {
        let decode = |raw: &str| decode_workspace_file(raw).err();

        assert_eq!(
            decode(r#"{"workspaces":[]}"#).as_deref(),
            Some("workspace store is missing a numeric version")
        );
        assert_eq!(
            decode(r#"{"version":99}"#).as_deref(),
            Some("unsupported workspace store version: 99")
        );
        assert_eq!(
            decode(r#"{"version":2,"workspaces":{}}"#).as_deref(),
            Some("workspace store workspaces must be an array")
        );
        assert_eq!(
            decode(r#"{"version":2,"groups":"none"}"#).as_deref(),
            Some("workspace store groups must be an array")
        );
        assert_eq!(
            decode("42").as_deref(),
            Some("workspace store must be an object or array")
        );
    }

    #[test]
    fn given_a_malformed_group_when_decoding_then_it_is_dropped_and_reported() {
        let decoded =
            decode_workspace_file(r#"{"version":2,"groups":[42]}"#).expect("envelope decodes");

        assert!(decoded.groups.is_empty());
        assert!(decoded.has_dropped_entries);
        assert!(!decoded.is_legacy);
    }

    #[test]
    fn given_a_newer_write_when_an_older_save_arrives_then_the_older_one_is_skipped() {
        let path = test_path("guarded");

        write_guarded_result(&path, "newer", 1_000_002).unwrap();
        write_guarded_result(&path, "older", 1_000_001).unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "newer");
        cleanup(&path);
    }

    #[test]
    fn given_an_existing_backup_when_backing_up_again_then_a_numbered_backup_is_used() {
        let path = test_path("numbered-backup");
        fs::write(&path, "first").unwrap();
        fs::write(path.with_extension("json.bak"), "older backup").unwrap();

        let backup = backup_store(&path).unwrap().expect("backup made");
        let missing = backup_store(&path).unwrap();

        assert!(backup.to_string_lossy().ends_with("workspaces.json.bak-1"));
        assert_eq!(fs::read_to_string(&backup).unwrap(), "first");
        assert_eq!(missing, None);
        assert!(read_snapshot_file(&path).is_err());
        cleanup(&path);
    }

    #[test]
    fn given_a_store_with_a_save_path_when_saving_in_the_background_then_the_file_is_written() {
        let path = test_path("background-save");
        let store = WorkspaceStore {
            workspaces: vec![workspace("ws-background")],
            groups: Vec::new(),
            save_path: Some(path.clone()),
        };

        store.save();

        let deadline = Instant::now() + SAVE_DEADLINE;
        while !fs::read_to_string(&path).is_ok_and(|text| text.contains("ws-background")) {
            assert!(
                Instant::now() < deadline,
                "the background save never landed"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        cleanup(&path);
    }
}

mod layout_tests {
    use super::*;

    const WS: &str = "ws-edit";
    const SECONDARY: &str = "container-secondary";

    fn placement(terminal_id: &str, pane_id: &str, tab_id: &str) -> TerminalPlacement {
        TerminalPlacement {
            terminal_id: terminal_id.into(),
            pane_id: pane_id.into(),
            tab_id: tab_id.into(),
        }
    }

    fn placed_store() -> WorkspaceStore {
        let mut store = WorkspaceStore {
            workspaces: vec![workspace(WS)],
            groups: Vec::new(),
            save_path: None,
        };
        store
            .set_terminal_placement(WS, placement("ws-edit-terminal", "pane-one", "tab-one"))
            .expect("placement");
        store.workspaces[0]
            .containers
            .push(WorkspaceStore::new_container(WS, SECONDARY.into()));
        store
    }

    fn first_container_id(store: &WorkspaceStore) -> String {
        store.workspaces[0].containers[0].id.clone()
    }

    fn patch_secondary(store: &mut WorkspaceStore, patch: WorkspaceContainerPatch) {
        store
            .set_container_state(
                WS,
                ContainerStateChange {
                    container_id: SECONDARY,
                    patch,
                },
            )
            .expect("container patch");
    }

    fn secondary(store: &WorkspaceStore) -> &WorkspaceContainer {
        &store.workspaces[0].containers[1]
    }

    #[test]
    fn given_invalid_placements_when_placing_a_terminal_then_they_are_refused() {
        let mut store = placed_store();

        let blank = store.set_terminal_placement(WS, placement("ws-edit-terminal", " ", "tab"));
        let unknown = store.set_terminal_placement(WS, placement("t-unknown", "pane", "tab"));

        assert_eq!(blank, Err("pane id and tab id cannot be empty".to_string()));
        assert_eq!(
            unknown,
            Err(format!("terminal t-unknown not found in workspace {WS}"))
        );
    }

    #[test]
    fn given_known_and_unknown_panes_when_activating_them_then_only_known_ones_become_active() {
        let mut store = placed_store();
        let container_id = first_container_id(&store);

        let unknown = store.set_active_pane(WS, Some("pane-missing".into()));
        store
            .set_active_pane(WS, Some(" pane-one ".into()))
            .unwrap();
        let active = store.workspaces[0].clone();
        store.set_active_pane(WS, Some("   ".into())).unwrap();

        assert_eq!(
            unknown,
            Err(format!("pane pane-missing not found in workspace {WS}"))
        );
        assert_eq!(active.active_pane_id.as_deref(), Some("pane-one"));
        assert_eq!(
            active.active_container_id.as_deref(),
            Some(container_id.as_str())
        );
        assert_eq!(
            active.containers[0].active_pane_id.as_deref(),
            Some("pane-one")
        );
        assert_eq!(store.workspaces[0].active_pane_id, None);
        assert_eq!(store.workspaces[0].containers[0].active_pane_id, None);
    }

    #[test]
    fn given_a_container_order_when_reordering_then_the_containers_follow_it() {
        let mut store = placed_store();
        let first = first_container_id(&store);

        store
            .reorder_containers(WS, &[SECONDARY.to_string(), first.clone()])
            .unwrap();

        let ids: Vec<&str> = store.workspaces[0]
            .containers
            .iter()
            .map(|container| container.id.as_str())
            .collect();
        assert_eq!(ids, vec![SECONDARY, first.as_str()]);
    }

    #[test]
    fn given_unknown_panes_or_containers_when_moving_a_pane_then_it_is_refused() {
        let mut store = placed_store();
        let pane_move = |pane_id: &str, to_container_id: &str| PaneMove {
            pane_id: pane_id.into(),
            to_container_id: to_container_id.into(),
            index: None,
        };

        let unknown_pane = store.move_pane(WS, pane_move("pane-missing", SECONDARY));
        let unknown_container = store.move_pane(WS, pane_move("pane-one", "container-missing"));
        let unknown_state = store.set_container_state(
            WS,
            ContainerStateChange {
                container_id: "container-missing",
                patch: WorkspaceContainerPatch::default(),
            },
        );

        assert_eq!(
            unknown_pane,
            Err(format!("pane pane-missing not found in workspace {WS}"))
        );
        assert_eq!(
            unknown_container,
            Err(format!(
                "container container-missing not found in workspace {WS}"
            ))
        );
        assert!(unknown_state.is_err());
    }

    #[test]
    fn given_a_pane_moved_into_a_laid_out_container_when_moving_then_the_layout_follows_and_the_source_drops_it(
    ) {
        let mut store = placed_store();
        patch_secondary(
            &mut store,
            WorkspaceContainerPatch {
                layout: Some(WorkspaceLayout::default()),
                ..WorkspaceContainerPatch::default()
            },
        );
        store.set_active_pane(WS, Some("pane-one".into())).unwrap();

        store
            .move_pane(
                WS,
                PaneMove {
                    pane_id: "pane-one".into(),
                    to_container_id: SECONDARY.into(),
                    index: Some(99),
                },
            )
            .unwrap();

        assert!(store.workspaces[0].containers[0].pane_ids.is_empty());
        assert_eq!(store.workspaces[0].containers[0].active_pane_id, None);
        assert_eq!(secondary(&store).pane_ids, vec!["pane-one"]);
        assert_eq!(
            secondary(&store)
                .layout
                .as_ref()
                .map(|layout| layout.item_ids.clone()),
            Some(vec!["pane-one".to_string()])
        );
    }

    #[test]
    fn given_container_patches_when_applying_them_then_visibility_layout_and_size_follow_the_rules()
    {
        let mut store = placed_store();
        let container_id = first_container_id(&store);

        let foreign_active = store.set_container_state(
            WS,
            ContainerStateChange {
                container_id: SECONDARY,
                patch: WorkspaceContainerPatch {
                    active_pane_id: Some("pane-one".into()),
                    ..WorkspaceContainerPatch::default()
                },
            },
        );
        patch_secondary(
            &mut store,
            WorkspaceContainerPatch {
                is_visible: Some(false),
                internal_layout: Some("   ".into()),
                size: Some(f64::NAN),
                ..WorkspaceContainerPatch::default()
            },
        );
        let hidden = secondary(&store).clone();
        patch_secondary(
            &mut store,
            WorkspaceContainerPatch {
                is_closed: Some(false),
                size: Some(250.0),
                should_clear_active_pane: true,
                ..WorkspaceContainerPatch::default()
            },
        );
        store
            .set_container_state(
                WS,
                ContainerStateChange {
                    container_id: &container_id,
                    patch: WorkspaceContainerPatch {
                        layout: Some(WorkspaceLayout {
                            item_ids: vec!["pane-one".into(), "pane-stranger".into()],
                            ..WorkspaceLayout::default()
                        }),
                        ..WorkspaceContainerPatch::default()
                    },
                },
            )
            .unwrap();

        assert_eq!(
            foreign_active,
            Err(format!("pane pane-one is not in container {SECONDARY}"))
        );
        assert!(!hidden.is_visible);
        assert!(hidden.is_closed);
        assert_ne!(hidden.internal_layout, "   ");
        assert!(secondary(&store).is_visible);
        assert!(!secondary(&store).is_closed);
        assert_eq!(secondary(&store).size, 100.0);
        assert_eq!(secondary(&store).active_pane_id, None);
        assert_eq!(
            store.workspaces[0].containers[0]
                .layout
                .as_ref()
                .map(|layout| layout.item_ids.clone()),
            Some(vec!["pane-one".to_string()])
        );
    }

    #[test]
    fn given_container_ids_when_ensuring_a_container_then_blank_ids_fail_and_legacy_workspaces_get_one(
    ) {
        let mut legacy = workspace("ws-legacy");
        let mut modern = placed_store().workspaces.remove(0);

        let blank = WorkspaceStore::ensure_container(&mut legacy, "  ");
        let created = WorkspaceStore::ensure_container(&mut legacy, "container-legacy");
        let missing = WorkspaceStore::ensure_container(&mut modern, "container-missing");

        assert_eq!(blank, Err("container id cannot be empty".to_string()));
        assert_eq!(created, Ok(0));
        assert_eq!(legacy.containers[0].id, "container-legacy");
        assert!(missing.is_err());
    }
}
