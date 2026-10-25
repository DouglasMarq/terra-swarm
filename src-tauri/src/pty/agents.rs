//! Coding-agent CLIs Terra Swarm knows and which of them are installed.

use serde::Serialize;

use crate::agent_catalog::catalog;

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

/// Whether the catalog agent `id` resolves on the user's PATH. Ids outside
/// the compiled-in catalog are refused without running anything.
pub(super) fn command_available(id: &str) -> bool {
    catalog().iter().any(|agent| agent.id == id) && is_on_path(id)
}

#[cfg(unix)]
fn is_on_path(id: &str) -> bool {
    std::process::Command::new(user_shell())
        .args(["-l", "-c", &format!("command -v {}", id)])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(windows)]
fn is_on_path(id: &str) -> bool {
    find_on_path(id).is_some()
}

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
    match std::process::Command::new(user_shell())
        .args(["-l", "-c", &script])
        .stderr(std::process::Stdio::null())
        .output()
    {
        Ok(out) => String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|line| line.trim().to_string())
            .filter(|line| !line.is_empty())
            .collect(),
        Err(error) => {
            eprintln!("agent detection could not start the login shell: {}", error);
            std::collections::HashSet::new()
        }
    }
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
    let ids: Vec<&str> = catalog().iter().map(|agent| agent.id.as_str()).collect();
    let found = available_commands(&ids);
    let mut agents: Vec<AgentInfo> = catalog()
        .iter()
        .map(|agent| AgentInfo {
            id: agent.id.clone(),
            label: agent.label.clone(),
            available: found.contains(&agent.id),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn given_an_id_outside_the_catalog_reports_it_unavailable_without_looking_it_up() {
        #[cfg(unix)]
        let installed = "sh";
        #[cfg(windows)]
        let installed = "cmd";
        assert!(is_on_path(installed));
        assert!(!command_available(installed));
        assert!(!command_available("claude; exit 0"));
    }
}
