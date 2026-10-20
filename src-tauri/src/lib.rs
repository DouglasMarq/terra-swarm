pub mod cli;
mod fonts;
mod mcp;
mod pty;
mod scrollback;
mod sync;
mod voice;
mod workspace;

use std::sync::{Arc, Mutex};
use tauri::{Listener, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let store = workspace::WorkspaceStore::load(dir.join("workspaces.json"));
            for ws in &store.workspaces {
                workspace::bump_next_id(&ws.id);
                for t in &ws.terminals {
                    pty::bump_next_terminal_id(&t.id);
                }
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
            let scrollback_dir = dir.join("scrollback");
            let scrollback_store = scrollback::ScrollbackStore::from_root(scrollback_dir.clone());
            if let Err(error) = scrollback_store.cleanup_orphans(&known_terminals) {
                eprintln!("failed to clean orphaned scrollback: {}", error);
            }
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
            // Without a database there is nothing to serve: the server stays
            // off and Settings explains why.
            if let Ok(program) = std::env::current_exe() {
                hub.set_hook_program(program);
            }
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

            // Auto-stop voice recording when the user finishes talking
            let handle = app.handle().clone();
            app.listen("voice-silence-detected", move |_| {
                if let Err(error) = voice::stop_recording_impl(&handle) {
                    eprintln!("failed to stop recording after silence: {}", error);
                }
            });

            // Watch for microphone plug/unplug so the UI can react
            voice::watch_input_devices(app.handle().clone());

            if std::env::var("SWARM_DEMO").is_ok() {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(800));
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
            pty::shell::list_available_shells,
            fonts::list_system_fonts,
            mcp::commands::mcp_server_info,
            mcp::commands::mcp_set_enabled,
            mcp::commands::mcp_list_tasks,
            mcp::commands::mcp_create_task,
            mcp::commands::mcp_update_task,
            mcp::commands::mcp_delete_task,
            mcp::commands::mcp_agent_statuses,
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
                    if let Ok(store) = app.state::<Mutex<workspace::WorkspaceStore>>().lock() {
                        store.save_now();
                    }
                    pty::kill_all(&app.state::<Mutex<pty::PtyManager>>());
                }
                tauri::RunEvent::Exit => {
                    pty::kill_all(&app.state::<Mutex<pty::PtyManager>>());
                }
                _ => {}
            }
        });
}
