//! Connects a new terminal to the MCP server: a token, four environment
//! variables and, for agent CLIs that support it, the flags that register
//! the server. The persisted terminal command never contains any of this, so
//! a token never reaches `workspaces.json`.

use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Runtime, Wry};

use super::integration::{self, LaunchContext};
use super::launch::{
    agent_of, Quoting, ENV_HOOK_URL, ENV_PANE_ID, ENV_TOKEN, ENV_URL, ENV_WORKSPACE_ID,
};
use super::{AgentIdentity, McpHub, McpLease};
use crate::roles::Role;

pub struct McpLaunch<R: Runtime = Wry> {
    pub env: Vec<(String, String)>,
    pub command: String,
    pub lease: McpLease<R>,
}

pub fn rewrite_command(command: &str, agent: &str, context: &LaunchContext<'_>) -> String {
    let command = command.trim();
    let Some(integration) = integration::of_agent(agent) else {
        return command.to_string();
    };
    integration.launch_command(command, context)
}

impl<R: Runtime> McpHub<R> {
    /// Everything a terminal needs to talk to the server, or `None` when the
    /// server is off or not running (the terminal then starts unchanged).
    pub fn launch(
        self: &Arc<Self>,
        terminal_id: &str,
        workspace_id: &str,
        command: &str,
        role: Option<Role>,
        quoting: Quoting,
    ) -> Option<McpLaunch<R>> {
        if !self.enabled() {
            return None;
        }
        let url = self.url()?;
        let identity = AgentIdentity {
            terminal_id: terminal_id.to_string(),
            workspace_id: workspace_id.to_string(),
            agent: agent_of(command),
            role,
        };
        let token = match self.issue(identity.clone()) {
            Ok(token) => token,
            Err(error) => {
                eprintln!("cannot issue an MCP token for {}: {}", terminal_id, error);
                return None;
            }
        };
        let lease = McpLease::new(self, token.clone());
        let endpoints = Endpoints {
            hook_url: hook_url_of(&url),
            url,
        };
        let hook_program = self.hook_program();
        let brief = role.map(Role::brief);
        let context = LaunchContext {
            url: &endpoints.url,
            hook_url: &endpoints.hook_url,
            hook_program: hook_program.as_deref(),
            config_dir: self.config_dir().map(PathBuf::as_path),
            system_prompt: brief.as_deref(),
            quoting,
        };
        Some(McpLaunch {
            command: agent_command(command, &identity.agent, &context),
            env: launch_env(&identity, &endpoints, token),
            lease,
        })
    }
}

struct Endpoints {
    url: String,
    hook_url: String,
}

fn hook_url_of(url: &str) -> String {
    url.trim_end_matches(super::server::MCP_PATH).to_string() + super::hooks::HOOKS_PATH
}

fn agent_command(command: &str, agent: &str, context: &LaunchContext<'_>) -> String {
    if command.trim().is_empty() || command.trim() == "shell" {
        return command.to_string();
    }
    rewrite_command(command, agent, context)
}

fn launch_env(
    identity: &AgentIdentity,
    endpoints: &Endpoints,
    token: String,
) -> Vec<(String, String)> {
    vec![
        (ENV_URL.into(), endpoints.url.clone()),
        (ENV_HOOK_URL.into(), endpoints.hook_url.clone()),
        (ENV_TOKEN.into(), token),
        (ENV_PANE_ID.into(), identity.terminal_id.clone()),
        (ENV_WORKSPACE_ID.into(), identity.workspace_id.clone()),
    ]
}

#[cfg(test)]
mod tests {
    use super::super::test_support::hub;
    use super::*;

    const URL: &str = "http://127.0.0.1:4100/mcp";

    #[test]
    fn other_commands_are_left_alone() {
        let context = LaunchContext {
            url: URL,
            hook_url: "http://127.0.0.1:4100/hooks",
            hook_program: None,
            config_dir: None,
            system_prompt: None,
            quoting: Quoting::Posix,
        };
        assert_eq!(
            rewrite_command("opencode --continue", "opencode", &context),
            "opencode --continue"
        );
    }

    #[test]
    fn launch_issues_a_token_and_env_only_when_enabled_and_running() {
        let (hub, _) = hub();
        assert!(hub
            .launch("t-1", "ws-1", "claude", None, Quoting::Posix)
            .is_none());
        hub.set_port(4100);
        let launch = hub
            .launch("t-1", "ws-1", "shell", None, Quoting::Posix)
            .unwrap();
        let env: std::collections::HashMap<_, _> = launch.env.iter().cloned().collect();
        assert_eq!(env[ENV_URL], URL);
        assert_eq!(env[ENV_HOOK_URL], "http://127.0.0.1:4100/hooks");
        assert_eq!(env[ENV_PANE_ID], "t-1");
        assert_eq!(env[ENV_WORKSPACE_ID], "ws-1");
        assert_eq!(hub.identify(&env[ENV_TOKEN]).unwrap().agent, "shell");
        assert_eq!(launch.command, "shell");
        drop(launch);
        assert!(hub.identify(&env[ENV_TOKEN]).is_none());

        hub.repo().unwrap().set_enabled(false).unwrap();
        assert!(hub
            .launch("t-1", "ws-1", "claude", None, Quoting::Posix)
            .is_none());
    }
}
