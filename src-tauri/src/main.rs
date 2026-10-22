// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Agent CLIs call this binary for hooks; those calls never open a window.
    let args: Vec<String> = std::env::args().collect();
    if let Some(code) = terra_swarm_lib::cli::run(&args) {
        std::process::exit(code);
    }
    terra_swarm_lib::run()
}
