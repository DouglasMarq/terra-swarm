//! Connects a new terminal to the MCP server: a token, four environment
//! variables and, for agent CLIs that support it, the flags that register
//! the server. The persisted terminal command never contains any of this, so
//! a token never reaches `workspaces.json`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::{AgentIdentity, McpHub, McpLease};

pub const ENV_URL: &str = "TERRA_MCP_URL";
pub const ENV_TOKEN: &str = "TERRA_MCP_TOKEN";
pub const ENV_PANE_ID: &str = "TERRA_PANE_ID";
pub const ENV_WORKSPACE_ID: &str = "TERRA_WORKSPACE_ID";

/// Name the server is registered under in each CLI.
pub const SERVER_NAME: &str = "terra";

const CLAUDE_CONFIG_FILE: &str = "claude-mcp.json";

/// How the shell that runs the command expects arguments to be quoted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Quoting {
    /// `sh -c`: single quotes.
    Posix,
    /// PowerShell `-Command` / `cmd /C`: double quotes.
    #[cfg_attr(unix, allow(dead_code))]
    Windows,
}

pub struct McpLaunch {
    pub env: Vec<(String, String)>,
    pub command: String,
    pub lease: McpLease,
}

/// The agent id of a command line: its executable's file name.
pub fn agent_of(command: &str) -> String {
    let executable = command.split_whitespace().next().unwrap_or("");
    if executable.is_empty() || executable == "shell" {
        return "shell".into();
    }
    let name = executable
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(executable)
        .trim_end_matches(".exe")
        .trim_end_matches(".cmd");
    name.to_string()
}

fn quote(value: &str, quoting: Quoting) -> String {
    match quoting {
        Quoting::Posix => format!("'{}'", value.replace('\'', r"'\''")),
        Quoting::Windows => format!("\"{}\"", value.replace('"', "")),
    }
}

/// Insert the flags that register the server with a known agent CLI.
/// Commands of other agents come back unchanged.
pub fn rewrite_command(
    command: &str,
    agent: &str,
    url: &str,
    claude_config: Option<&Path>,
    quoting: Quoting,
) -> String {
    let command = command.trim();
    match crate::pty::agents::integration_of(agent) {
        // `--mcp-config` takes several values, so it goes last: placed
        // before a prompt argument it would swallow the prompt as a file.
        Some("claude") => match claude_config {
            Some(path) => format!(
                "{} --mcp-config {}",
                command,
                quote(&path.to_string_lossy(), quoting)
            ),
            None => command.to_string(),
        },
        // `-c` is a global flag, so it is valid before a subcommand such as
        // `codex resume --last`. The token is read from the environment.
        Some("codex") => {
            let rest = command
                .split_once(char::is_whitespace)
                .map(|(_, rest)| rest.trim_start())
                .unwrap_or("");
            let executable = command.split_whitespace().next().unwrap_or("codex");
            let overrides = match quoting {
                Quoting::Posix => format!(
                    "-c {} -c {}",
                    quote(&format!("mcp_servers.{}.url=\"{}\"", SERVER_NAME, url), quoting),
                    quote(
                        &format!("mcp_servers.{}.bearer_token_env_var=\"{}\"", SERVER_NAME, ENV_TOKEN),
                        quoting
                    ),
                ),
                // Codex reads a value that is not valid TOML as a plain
                // string, which avoids nesting quotes for cmd/PowerShell.
                Quoting::Windows => format!(
                    "-c mcp_servers.{name}.url={url} -c mcp_servers.{name}.bearer_token_env_var={env}",
                    name = SERVER_NAME,
                    url = url,
                    env = ENV_TOKEN
                ),
            };
            if rest.is_empty() {
                format!("{} {}", executable, overrides)
            } else {
                format!("{} {} {}", executable, overrides, rest)
            }
        }
        _ => command.to_string(),
    }
}

/// The Claude Code config reads the URL and token from the environment, so
/// one file serves every terminal and holds no secret.
pub fn claude_config_json() -> String {
    serde_json::json!({
        "mcpServers": {
            SERVER_NAME: {
                "type": "http",
                "url": format!("${{{}}}", ENV_URL),
                "headers": { "Authorization": format!("Bearer ${{{}}}", ENV_TOKEN) },
            }
        }
    })
    .to_string()
}

pub fn write_claude_config(dir: &Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(CLAUDE_CONFIG_FILE);
    let json = claude_config_json();
    if std::fs::read_to_string(&path).ok().as_deref() != Some(json.as_str()) {
        std::fs::write(&path, json)?;
    }
    Ok(path)
}

impl McpHub {
    /// Everything a terminal needs to talk to the server, or `None` when the
    /// server is off or not running (the terminal then starts unchanged).
    pub fn launch(
        self: &Arc<Self>,
        terminal_id: &str,
        workspace_id: &str,
        command: &str,
        quoting: Quoting,
    ) -> Option<McpLaunch> {
        if !self.enabled() {
            return None;
        }
        let url = self.url()?;
        let agent = agent_of(command);
        let token = self.issue(AgentIdentity {
            terminal_id: terminal_id.to_string(),
            workspace_id: workspace_id.to_string(),
            agent: agent.clone(),
        });
        let lease = McpLease::new(self, token.clone());
        let claude_config = if crate::pty::agents::integration_of(&agent) == Some("claude") {
            self.config_dir()
                .and_then(|dir| match write_claude_config(dir) {
                    Ok(path) => Some(path),
                    Err(error) => {
                        eprintln!("failed to write the Claude MCP config: {}", error);
                        None
                    }
                })
        } else {
            None
        };
        let command = if command.trim().is_empty() || command.trim() == "shell" {
            command.to_string()
        } else {
            rewrite_command(command, &agent, &url, claude_config.as_deref(), quoting)
        };
        Some(McpLaunch {
            env: vec![
                (ENV_URL.into(), url),
                (ENV_TOKEN.into(), token),
                (ENV_PANE_ID.into(), terminal_id.to_string()),
                (ENV_WORKSPACE_ID.into(), workspace_id.to_string()),
            ],
            command,
            lease,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::hub;
    use super::*;

    const URL: &str = "http://127.0.0.1:4100/mcp";

    #[test]
    fn agent_is_the_executable_name() {
        assert_eq!(agent_of("claude --continue"), "claude");
        assert_eq!(agent_of("/opt/bin/codex resume --last"), "codex");
        assert_eq!(agent_of(r"C:\tools\codex.exe"), "codex");
        assert_eq!(agent_of(""), "shell");
        assert_eq!(agent_of("shell"), "shell");
    }

    #[test]
    fn claude_gets_its_config_file_last() {
        let path = Path::new("/Users/me/Library/Application Support/x/claude-mcp.json");
        assert_eq!(
            rewrite_command("claude --continue", "claude", URL, Some(path), Quoting::Posix),
            "claude --continue --mcp-config '/Users/me/Library/Application Support/x/claude-mcp.json'"
        );
        assert_eq!(
            rewrite_command(
                "claude",
                "claude",
                URL,
                Some(Path::new("C:\\a b\\c.json")),
                Quoting::Windows
            ),
            "claude --mcp-config \"C:\\a b\\c.json\""
        );
        assert_eq!(
            rewrite_command("claude", "claude", URL, None, Quoting::Posix),
            "claude"
        );
    }

    #[test]
    fn codex_gets_overrides_before_its_subcommand() {
        assert_eq!(
            rewrite_command("codex resume --last", "codex", URL, None, Quoting::Posix),
            "codex -c 'mcp_servers.terra.url=\"http://127.0.0.1:4100/mcp\"' \
             -c 'mcp_servers.terra.bearer_token_env_var=\"TERRA_MCP_TOKEN\"' resume --last"
        );
        assert_eq!(
            rewrite_command("codex", "codex", URL, None, Quoting::Windows),
            "codex -c mcp_servers.terra.url=http://127.0.0.1:4100/mcp \
             -c mcp_servers.terra.bearer_token_env_var=TERRA_MCP_TOKEN"
        );
    }

    #[test]
    fn other_commands_are_left_alone() {
        assert_eq!(
            rewrite_command("opencode --continue", "opencode", URL, None, Quoting::Posix),
            "opencode --continue"
        );
    }

    #[test]
    fn posix_quoting_escapes_single_quotes() {
        assert_eq!(quote("it's", Quoting::Posix), r"'it'\''s'");
    }

    #[test]
    fn claude_config_holds_no_secret() {
        let json: serde_json::Value = serde_json::from_str(&claude_config_json()).unwrap();
        let server = &json["mcpServers"]["terra"];
        assert_eq!(server["type"], "http");
        assert_eq!(server["url"], "${TERRA_MCP_URL}");
        assert_eq!(
            server["headers"]["Authorization"],
            "Bearer ${TERRA_MCP_TOKEN}"
        );
    }

    #[test]
    fn launch_issues_a_token_and_env_only_when_enabled_and_running() {
        let (hub, _) = hub();
        assert!(hub
            .launch("t-1", "ws-1", "claude", Quoting::Posix)
            .is_none());
        hub.set_port(4100);
        let launch = hub.launch("t-1", "ws-1", "shell", Quoting::Posix).unwrap();
        let env: std::collections::HashMap<_, _> = launch.env.iter().cloned().collect();
        assert_eq!(env[ENV_URL], URL);
        assert_eq!(env[ENV_PANE_ID], "t-1");
        assert_eq!(env[ENV_WORKSPACE_ID], "ws-1");
        assert_eq!(hub.identify(&env[ENV_TOKEN]).unwrap().agent, "shell");
        assert_eq!(launch.command, "shell");
        drop(launch);
        assert!(hub.identify(&env[ENV_TOKEN]).is_none());

        hub.repo().unwrap().set_enabled(false).unwrap();
        assert!(hub
            .launch("t-1", "ws-1", "claude", Quoting::Posix)
            .is_none());
    }
}
