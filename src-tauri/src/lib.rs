mod pty;
mod voice;
mod workspace;

use std::sync::Mutex;
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
            app.manage(Mutex::new(store));
            app.manage(Mutex::new(pty::PtyManager::default()));
            app.manage(voice::VoiceState::default());
            app.manage(voice::audio::AudioController::new());

            // Auto-stop voice recording when the user finishes talking
            let handle = app.handle().clone();
            app.listen("voice-silence-detected", move |_| {
                let _ = voice::stop_recording_impl(&handle);
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
            workspace::store_saved_at,
            workspace::close_workspace,
            workspace::rename_workspace,
            workspace::reorder_terminals,
            workspace::reorder_workspaces,
            workspace::set_terminal_width,
            workspace::git_branch,
            pty::spawn_terminal,
            pty::write_terminal,
            pty::resize_terminal,
            pty::kill_terminal,
            pty::stop_terminal,
            pty::terminal_backlog,
            pty::running_terminals,
            pty::detect_agents,
            pty::list_available_shells,
            voice::voice_toggle_recording,
            voice::voice_set_language,
            voice::voice_mic_available,
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
