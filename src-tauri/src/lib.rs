pub mod cli;
mod fonts;
mod mcp;
mod pty;
mod scrollback;
mod sync;
mod usage;
mod voice;
mod workspace;
mod worktree;

use std::sync::{Arc, Mutex};
use std::time::Duration;
use sync::LockExt;
use tauri::{Listener, Manager};

/// How long `SWARM_DEMO=1` waits for the window before seeding terminals.
const DEMO_SEED_DELAY: Duration = Duration::from_millis(800);

/// Remove the old scrollback of terminals the store no longer knows. A
/// store that could not be read knows no terminals, so it keeps them all.
fn clean_orphaned_scrollback(
    store: &workspace::WorkspaceStore,
    scrollback_store: &scrollback::ScrollbackStore,
) {
    if store.save_path.is_none() {
        return;
    }
    let known_terminals = store
        .workspaces
        .iter()
        .flat_map(|workspace| {
            workspace
                .terminals
                .iter()
                .map(|terminal| terminal.id.clone())
        })
        .collect::<std::collections::HashSet<_>>();
    if let Err(error) = scrollback_store.cleanup_orphans(&known_terminals) {
        eprintln!("failed to clean orphaned scrollback: {}", error);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let store = workspace::WorkspaceStore::load(dir.join("workspaces.json"));
            for ws in &store.workspaces {
                workspace::bump_next_id(&ws.id);
                for t in &ws.terminals {
                    pty::bump_next_terminal_id(&t.id);
                }
            }
            let scrollback_dir = dir.join("scrollback");
            clean_orphaned_scrollback(
                &store,
                &scrollback::ScrollbackStore::from_root(scrollback_dir.clone()),
            );
            let hub = Arc::new(mcp::McpHub::open(
                dir.join(mcp::db::DB_FILE),
                Some(dir.join("mcp")),
                Box::new(mcp::TauriHost {
                    app: app.handle().clone(),
                }),
            ));
            let known_workspaces = store
                .workspaces
                .iter()
                .map(|workspace| workspace.id.clone())
                .collect::<std::collections::HashSet<_>>();
            // Workspaces closed by an older build left their data behind. An
            // empty list may mean the workspace store failed to load; keep
            // the board rather than wiping it in that case.
            if !known_workspaces.is_empty() {
                if let Err(error) = hub
                    .repo()
                    .and_then(|mut repo| repo.retain_workspaces(&known_workspaces))
                {
                    eprintln!("failed to clean orphaned MCP data: {}", error);
                }
            }
            match std::env::current_exe() {
                Ok(program) => hub.set_hook_program(program),
                Err(error) => eprintln!(
                    "agent state hooks are off: cannot locate the app binary: {}",
                    error
                ),
            }
            // Without a database there is nothing to serve: the server stays
            // off and Settings explains why.
            if hub.available() {
                if let Err(error) = mcp::server::start(Arc::clone(&hub)) {
                    eprintln!("failed to start the MCP server: {}", error);
                }
            }
            app.manage(hub);
            app.manage(Mutex::new(store));
            app.manage(Mutex::new(pty::PtyManager::with_scrollback_dir(
                scrollback_dir,
            )));
            app.manage(voice::VoiceState::default());
            app.manage(voice::audio::AudioController::new());
            app.manage(voice::audio::MicTestController::new());

            let handle = app.handle().clone();
            app.listen("voice-silence-detected", move |_| {
                if let Err(error) = voice::stop_recording_impl(&handle) {
                    eprintln!("failed to stop recording after silence: {}", error);
                }
            });

            voice::watch_input_devices(app.handle().clone());

            if std::env::var("SWARM_DEMO").is_ok() {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(DEMO_SEED_DELAY);
                    pty::demo_seed(&handle);
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            workspace::create_workspace,
            workspace::list_workspaces,
            workspace::list_groups,
            workspace::set_workspace_group,
            workspace::set_terminal_placement,
            workspace::set_active_pane,
            workspace::reorder_workspace_containers,
            workspace::reorder_workspace_panes,
            workspace::move_workspace_pane,
            workspace::set_workspace_container_state,
            workspace::set_workspace_layout,
            workspace::set_workspace_collapsed,
            workspace::create_group,
            workspace::rename_group,
            workspace::remove_group,
            workspace::suspend_group,
            workspace::resume_group,
            workspace::store_saved_at,
            workspace::export_workspace_snapshot,
            workspace::import_workspace_snapshot,
            workspace::close_workspace,
            workspace::rename_workspace,
            workspace::reorder_workspaces,
            workspace::set_terminal_width,
            workspace::list_workspace_files,
            workspace::read_workspace_file,
            workspace::write_workspace_file,
            workspace::git_status,
            workspace::git_branch,
            pty::spawn_terminal,
            pty::write_terminal,
            pty::resize_terminal,
            pty::kill_terminal,
            pty::stop_terminal,
            pty::terminal_backlog,
            pty::set_durable_scrollback_enabled,
            pty::running_terminals,
            pty::terminal_runtime_info,
            pty::agents::detect_agents,
            pty::dev_server::probe_dev_servers,
            pty::shell::list_available_shells,
            fonts::list_system_fonts,
            worktree::worktree_status,
            worktree::worktree_remove,
            worktree::worktree_diff,
            worktree::worktree_commit,
            worktree::worktree_merge,
            worktree::worktree_open_pr,
            mcp::commands::mcp_server_info,
            mcp::commands::mcp_set_enabled,
            mcp::commands::mcp_list_tasks,
            mcp::commands::mcp_create_task,
            mcp::commands::mcp_update_task,
            mcp::commands::mcp_delete_task,
            mcp::commands::mcp_agent_statuses,
            mcp::commands::agent_usage,
            voice::voice_toggle_recording,
            voice::voice_set_language,
            voice::voice_mic_available,
            voice::voice_list_input_devices,
            voice::voice_set_input_device,
            voice::voice_test_mic_start,
            voice::voice_test_mic_stop,
            voice::voice_list_models,
            voice::voice_set_model,
            voice::voice_download_model,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            match event {
                tauri::RunEvent::ExitRequested { .. } => {
                    // Flush the workspace store synchronously; the debounced
                    // background writer may not fire before the process exits.
                    app.state::<Mutex<workspace::WorkspaceStore>>()
                        .lock_or_recover()
                        .save_now();
                    pty::kill_all(&app.state::<Mutex<pty::PtyManager>>());
                }
                tauri::RunEvent::Exit => {
                    pty::kill_all(&app.state::<Mutex<pty::PtyManager>>());
                }
                _ => {}
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    const OLDER_THAN_ORPHAN_AGE: Duration = Duration::from_secs(60 * 24 * 60 * 60);

    fn old_transcript(label: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "terra-swarm-orphans-{label}-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let transcript = root.join("t-1.scrollback");
        std::fs::write(&transcript, "output").unwrap();
        std::fs::File::options()
            .write(true)
            .open(&transcript)
            .unwrap()
            .set_modified(SystemTime::now() - OLDER_THAN_ORPHAN_AGE)
            .unwrap();
        (root, transcript)
    }

    #[test]
    fn given_a_store_that_could_not_be_read_keeps_every_transcript() {
        let (root, transcript) = old_transcript("unread");
        let store = workspace::WorkspaceStore::default();

        clean_orphaned_scrollback(
            &store,
            &scrollback::ScrollbackStore::from_root(root.clone()),
        );

        assert!(transcript.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn given_a_loaded_store_removes_old_transcripts_it_does_not_know() {
        let (root, transcript) = old_transcript("loaded");
        let store = workspace::WorkspaceStore {
            save_path: Some(root.join("workspaces.json")),
            ..workspace::WorkspaceStore::default()
        };

        clean_orphaned_scrollback(
            &store,
            &scrollback::ScrollbackStore::from_root(root.clone()),
        );

        assert!(!transcript.exists());
        let _ = std::fs::remove_dir_all(root);
    }
}
