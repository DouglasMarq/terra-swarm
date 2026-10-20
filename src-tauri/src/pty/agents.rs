//! Coding-agent CLIs Terra Swarm knows and which of them are installed.

use serde::Serialize;

#[cfg(windows)]
use super::shell::find_on_path;
#[cfg(unix)]
use super::shell::user_shell;

#[derive(Serialize, Clone)]
pub struct AgentInfo {
    pub id: String,
    pub label: String,
    pub available: bool,
}

#[cfg(unix)]
pub(super) fn command_available(id: &str) -> bool {
    std::process::Command::new(user_shell())
        .args(["-l", "-c", &format!("command -v {}", id)])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(windows)]
pub(super) fn command_available(id: &str) -> bool {
    find_on_path(id).is_some()
}

/// Coding-agent CLIs Terra Swarm knows how to launch, as (executable, label).
/// The executable name doubles as the agent id used by the frontend profiles.
const KNOWN_AGENTS: [(&str, &str); 17] = [
    ("claude", "Claude Code"),
    ("codex", "Codex"),
    ("opencode", "OpenCode"),
    ("copilot", "GitHub Copilot"),
    ("gemini", "Gemini"),
    ("grok", "Grok"),
    ("kimi", "Kimi"),
    ("qwen", "Qwen Code"),
    ("deepseek", "DeepSeek"),
    ("aider", "Aider"),
    ("cursor-agent", "Cursor"),
    ("amp", "Amp"),
    ("goose", "Goose"),
    ("crush", "Crush"),
    ("droid", "Droid"),
    ("cline", "Cline"),
    ("auggie", "Auggie"),
];

/// Which of `ids` resolve on the user's PATH. On Unix a single login shell
/// answers for all of them, so detection costs one shell start, not one per
/// agent, and sees the same PATH as the terminals the app spawns.
#[cfg(not(windows))]
fn available_commands(ids: &[&str]) -> std::collections::HashSet<String> {
    let script = ids
        .iter()
        .map(|id| format!("command -v {id} >/dev/null 2>&1 && echo {id}"))
        .collect::<Vec<_>>()
        .join("; ");
    std::process::Command::new(user_shell())
        .args(["-l", "-c", &script])
        .stderr(std::process::Stdio::null())
        .output()
        .map(|out| {
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .map(|line| line.trim().to_string())
                .filter(|line| !line.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(windows)]
fn available_commands(ids: &[&str]) -> std::collections::HashSet<String> {
    ids.iter()
        .filter(|id| command_available(id))
        .map(|id| id.to_string())
        .collect()
}

#[tauri::command(async)]
pub fn detect_agents() -> Vec<AgentInfo> {
    let ids: Vec<&str> = KNOWN_AGENTS.iter().map(|(id, _)| *id).collect();
    let found = available_commands(&ids);
    let mut agents: Vec<AgentInfo> = KNOWN_AGENTS
        .iter()
        .map(|(id, label)| AgentInfo {
            id: id.to_string(),
            label: label.to_string(),
            available: found.contains(*id),
        })
        .collect();
    // Installed agents first, keeping the curated order inside each half.
    agents.sort_by_key(|agent| !agent.available);
    agents.push(AgentInfo {
        id: "shell".into(),
        label: "Shell".into(),
        available: true,
    });
    agents
}
