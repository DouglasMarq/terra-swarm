#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if let Some(code) = terra_swarm_lib::cli::run(&args) {
        std::process::exit(code);
    }
    terra_swarm_lib::run()
}
