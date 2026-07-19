mod pty;
mod workspace;

use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
            workspace::close_workspace,
            workspace::rename_workspace,
            workspace::reorder_terminals,
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
