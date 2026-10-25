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
fn lists_workspace_relative_metadata_with_a_bound_and_rejects_escape() {
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
    assert!(listing.truncated);
    assert_eq!(listing.entries[0].kind, "directory");
    assert_eq!(listing.entries[0].path, "src");
    assert!(safe_relative_path(Some("../outside")).is_err());
    assert!(list_directory_entries(root, Some("src/../../"), None).is_err());
    cleanup(&path);
}

#[test]
fn parses_structured_git_status_categories() {
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
fn given_a_repository_with_changes_git_status_lists_them_by_category() {
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
            suspended: false,
            worktree: None,
            role: None,
        }],
        group_id: None,
        panes: Vec::new(),
        containers: Vec::new(),
        active_pane_id: None,
        active_container_id: None,
        collapsed: false,
        archived: false,
        created_at: None,
        layout_mode: None,
        layout: None,
    }
}

#[test]
fn saves_the_current_versioned_envelope() {
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
fn loads_legacy_array_and_migrates_it_on_startup() {
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
fn loads_v1_envelope_and_migrates_to_v2_without_losing_terminal_metadata() {
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
fn group_lifecycle_preserves_projects_and_terminal_metadata() {
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
    assert!(store.groups[0].suspended);
    assert!(store.workspaces[0].terminals[0].suspended);
    assert!(store.workspaces[0].panes[0].tabs[0].suspended);
    assert_eq!(
        store.workspaces[0].group_id.as_deref(),
        Some(group.id.as_str())
    );
    assert_eq!(store.workspaces[0].terminals.len(), 1);

    store.resume_group(&group.id).expect("resume");
    assert!(!store.groups[0].suspended);
    store.remove_group(&group.id).expect("remove");
    assert!(store.groups.is_empty());
    assert!(store.workspaces[0].group_id.is_none());
    assert_eq!(store.workspaces[0].terminals.len(), 1);
}

#[test]
fn workspace_group_assignment_keeps_both_sides_consistent() {
    let mut store = WorkspaceStore {
        workspaces: vec![workspace("ws-assign")],
        groups: vec![
            Group {
                id: "group-a".to_string(),
                name: "A".to_string(),
                color: None,
                icon_url: None,
                collapsed: false,
                project_ids: vec!["ws-assign".to_string(), "ws-assign".to_string()],
                parent_group_id: None,
                layout_mode: None,
                suspended: false,
                archived: false,
                created_at: None,
            },
            Group {
                id: "group-b".to_string(),
                name: "B".to_string(),
                color: None,
                icon_url: None,
                collapsed: false,
                project_ids: vec!["ws-assign".to_string()],
                parent_group_id: None,
                layout_mode: None,
                suspended: false,
                archived: false,
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
fn terminal_placement_creates_and_normalizes_pane_and_tab_metadata() {
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
fn recovers_valid_entries_and_preserves_a_backup_for_invalid_data() {
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
        suspended: false,
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
        collapsed: false,
        archived: false,
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
fn deduplicates_terminal_ids_across_workspaces_without_touching_scrollback() {
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

    // A destructive terminal removal now has exactly one owner to act
    // on; the quarantined duplicate cannot make a second workspace match.
    store.remove_terminal("shared-terminal");
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
fn corrupt_json_is_backed_up_without_being_overwritten() {
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
fn given_an_unreadable_store_keeps_the_file_and_does_not_save() {
    use std::os::unix::fs::PermissionsExt;
    let path = test_path("unreadable");
    let original = serde_json::to_string(&vec![workspace("ws-kept")]).expect("store JSON");
    fs::write(&path, &original).expect("store");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).expect("chmod");
    if fs::read(&path).is_ok() {
        // Permission bits do not stop a privileged user (root) from reading.
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
fn given_a_store_that_is_not_utf8_backs_it_up_before_starting_fresh() {
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
fn reorder_workspaces_is_stable_and_ignores_unknown_or_duplicate_ids() {
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
fn visual_layout_operations_are_durable_and_never_remove_ptys() {
    let mut first = workspace("ws-layout");
    first.terminals.push(TerminalMeta {
        id: "ws-layout-terminal-two".to_string(),
        command: "worker".to_string(),
        width: None,
        pane_id: None,
        tab_id: None,
        group_id: None,
        suspended: false,
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
            &first_container_id,
            &["pane-two".to_string(), "pane-one".to_string()],
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
            "container-secondary",
            WorkspaceContainerPatch {
                collapsed: Some(true),
                fullscreen: Some(true),
                active_pane_id: Some("pane-two".to_string()),
                internal_layout: Some("vertical".to_string()),
                size: Some(42.0),
                ..WorkspaceContainerPatch::default()
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
    assert!(workspace.collapsed);
    assert_eq!(workspace.containers[1].pane_ids, vec!["pane-two"]);
    assert!(workspace.containers[1].collapsed);
    assert!(workspace.containers[1].fullscreen);
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
fn set_width_rejects_non_finite_values_and_clamps_finite_values() {
    let mut store = WorkspaceStore {
        workspaces: vec![workspace("ws-width")],
        groups: Vec::new(),
        save_path: None,
    };
    let terminal_id = store.workspaces[0].terminals[0].id.clone();

    store
        .set_width("ws-width", &terminal_id, f64::NAN)
        .expect("width");
    assert_eq!(store.workspaces[0].terminals[0].width, None);
    store
        .set_width("ws-width", &terminal_id, f64::INFINITY)
        .expect("width");
    assert_eq!(store.workspaces[0].terminals[0].width, None);
    store
        .set_width("ws-width", &terminal_id, 1.0)
        .expect("width");
    assert_eq!(
        store.workspaces[0].terminals[0].width,
        Some(MIN_TERMINAL_WIDTH)
    );
}

#[test]
fn given_an_unknown_workspace_or_terminal_set_width_reports_not_found() {
    let mut store = WorkspaceStore {
        workspaces: vec![workspace("ws-1")],
        groups: Vec::new(),
        save_path: None,
    };

    assert!(store
        .set_width("ws-missing", "ws-1-terminal", 40.0)
        .unwrap_err()
        .contains("workspace ws-missing not found"));
    assert!(store
        .set_width("ws-1", "t-missing", 40.0)
        .unwrap_err()
        .contains("terminal t-missing not found"));
    assert_eq!(store.workspaces[0].terminals[0].width, None);
}

#[test]
fn given_an_unknown_workspace_rename_reports_not_found() {
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
fn snapshot_roundtrip_preserves_layout_but_suspends_imported_sessions() {
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
    assert!(imported.workspaces[0].terminals[0].suspended);
    assert!(imported.workspaces[0].panes[0].tabs[0].suspended);
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
fn import_rejects_unknown_versions_before_replacing_state() {
    let raw = serde_json::json!({
        "version": WORKSPACE_FILE_VERSION + 1,
        "workspaces": [],
        "groups": []
    });
    assert!(parse_import_snapshot(&serde_json::to_string(&raw).expect("version JSON")).is_err());
}

#[test]
fn import_rejects_malformed_json_and_entries() {
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
fn replacing_store_keeps_a_recoverable_backup_and_current_file_atomic() {
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
    let leftover_temp = fs::read_dir(current.parent().expect("current parent"))
        .expect("current directory")
        .filter_map(Result::ok)
        .any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(&temp_prefix)
        });
    assert!(!leftover_temp);
    cleanup(&current);
}

#[test]
fn explicit_snapshot_paths_reject_relative_and_traversal_input() {
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
fn given_a_stored_worktree_with_an_option_like_branch_drops_it_on_load() {
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
fn given_a_snapshot_with_an_invalid_worktree_refuses_to_import() {
    let raw = serde_json::json!({
        "version": WORKSPACE_FILE_VERSION,
        "workspaces": [workspace_with_worktree_branch("ws-1", "terra/../../main")],
        "groups": [],
    })
    .to_string();

    assert!(parse_import_snapshot(&raw).is_err());
}
