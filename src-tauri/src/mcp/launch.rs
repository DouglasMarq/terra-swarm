//! Connects a new terminal to the MCP server: a token, four environment
//! variables and, for agent CLIs that support it, the flags that register
//! the server. The persisted terminal command never contains any of this, so
//! a token never reaches `workspaces.json`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::roles::Role;
use super::{AgentIdentity, McpHub, McpLease};

pub const ENV_URL: &str = "TERRA_MCP_URL";
pub const ENV_TOKEN: &str = "TERRA_MCP_TOKEN";
pub const ENV_PANE_ID: &str = "TERRA_PANE_ID";
pub const ENV_WORKSPACE_ID: &str = "TERRA_WORKSPACE_ID";
pub const ENV_HOOK_URL: &str = "TERRA_HOOK_URL";

/// Name the server is registered under in each CLI.
pub const SERVER_NAME: &str = "terra";

const CLAUDE_CONFIG_FILE: &str = "claude-mcp.json";
const CLAUDE_SETTINGS_FILE: &str = "claude-hooks.json";

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

/// Where each CLI finds Terra: the MCP server and the state hooks.
#[derive(Default, Clone, Copy)]
pub struct Registration<'a> {
    pub url: &'a str,
    /// Claude Code `--mcp-config` file.
    pub claude_mcp: Option<&'a Path>,
    /// Claude Code `--settings` file with the state hooks.
    pub claude_settings: Option<&'a Path>,
    /// Program Codex runs as `notify` (this app's binary), when the user has
    /// no `notify` of their own.
    pub codex_notify: Option<&'a Path>,
    /// Appended to Claude Code's system prompt (the agent's team role).
    pub system_prompt: Option<&'a str>,
}

/// Insert the flags that register the server (and the state hooks) with a
/// known agent CLI. Commands of other agents come back unchanged.
pub fn rewrite_command(command: &str, agent: &str, registration: Registration<'_>, quoting: Quoting) -> String {
    let command = command.trim();
    match crate::pty::agents::integration_of(agent) {
        Some("claude") => {
            let mut flags = String::new();
            if let Some(path) = registration.claude_settings {
                flags.push_str(&format!(" --settings {}", quote(&path.to_string_lossy(), quoting)));
            }
            if let Some(prompt) = registration.system_prompt {
                flags.push_str(&format!(" --append-system-prompt {}", quote(prompt, quoting)));
            }
            // `--mcp-config` takes several values, so it goes last: placed
            // before a prompt argument it would swallow the prompt as a file.
            if let Some(path) = registration.claude_mcp {
                flags.push_str(&format!(" --mcp-config {}", quote(&path.to_string_lossy(), quoting)));
            }
            format!("{}{}", command, flags)
        }
        // `-c` is a global flag, so it is valid before a subcommand such as
        // `codex resume --last`. The token is read from the environment.
        Some("codex") => {
            let rest = command
                .split_once(char::is_whitespace)
                .map(|(_, rest)| rest.trim_start())
                .unwrap_or("");
            let executable = command.split_whitespace().next().unwrap_or("codex");
            let url = registration.url;
            let mut overrides = match quoting {
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
            // `notify` is a TOML array; on Windows shells the nested quotes
            // are not worth the risk, so the state hook stays POSIX-only.
            if let (Some(program), Quoting::Posix) = (registration.codex_notify, quoting) {
                let program = serde_json::to_string(&program.to_string_lossy()).unwrap_or_default();
                overrides.push_str(&format!(
                    " -c {}",
                    quote(&format!("notify=[{},\"hook\",\"codex\",\"notify\"]", program), quoting)
                ));
            }
            if rest.is_empty() {
                format!("{} {}", executable, overrides)
            } else {
                format!("{} {} {}", executable, overrides, rest)
            }
        }
        _ => command.to_string(),
    }
}

/// Claude Code hooks that report the agent's state to Terra over HTTP.
/// Claude validates the URL before expanding variables, so it is written
/// literally (loopback and port only); the token still comes from the
/// environment, so the file holds no secret.
pub fn claude_settings_json(hook_url: &str) -> String {
    let handler = serde_json::json!({
        "type": "http",
        "url": format!("{}/claude", hook_url),
        "headers": { "Authorization": format!("Bearer ${{{}}}", ENV_TOKEN) },
        "allowedEnvVars": [ENV_TOKEN],
        "timeout": 5,
    });
    let group = serde_json::json!([{ "hooks": [handler] }]);
    serde_json::json!({
        "hooks": {
            "SessionStart": group,
            "UserPromptSubmit": group,
            "PreToolUse": group,
            "Notification": group,
            "Stop": group,
        }
    })
    .to_string()
}

/// Whether the user's own Codex config already sets `notify`; Terra's hook
/// would replace it, so it is left out then.
pub fn user_has_codex_notify() -> bool {
    let Some(home) = std::env::var_os("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| std::path::Path::new(&home).join(".codex")))
    else {
        return false;
    };
    std::fs::read_to_string(home.join("config.toml"))
        .map(|text| codex_config_sets_notify(&text))
        .unwrap_or(false)
}

/// A top-level `notify = ...` line, before the first table header.
pub fn codex_config_sets_notify(config: &str) -> bool {
    for line in config.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            return false;
        }
        if let Some((key, _)) = line.split_once('=') {
            if key.trim() == "notify" {
                return true;
            }
        }
    }
    false
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

fn write_if_changed(path: &Path, contents: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if std::fs::read_to_string(path).ok().as_deref() != Some(contents) {
        std::fs::write(path, contents)?;
    }
    Ok(())
}

pub fn write_claude_config(dir: &Path) -> std::io::Result<PathBuf> {
    let path = dir.join(CLAUDE_CONFIG_FILE);
    write_if_changed(&path, &claude_config_json())?;
    Ok(path)
}

pub fn write_claude_settings(dir: &Path, hook_url: &str) -> std::io::Result<PathBuf> {
    let path = dir.join(CLAUDE_SETTINGS_FILE);
    write_if_changed(&path, &claude_settings_json(hook_url))?;
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
        role: Option<Role>,
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
            role,
        });
        let lease = McpLease::new(self, token.clone());
        let hook_url = url.trim_end_matches(super::server::MCP_PATH).to_string() + super::hooks::HOOKS_PATH;
        let integration = crate::pty::agents::integration_of(&agent);
        let written = |what: &str, result: std::io::Result<PathBuf>| match result {
            Ok(path) => Some(path),
            Err(error) => {
                eprintln!("failed to write the {}: {}", what, error);
                None
            }
        };
        let (claude_mcp, claude_settings) = match (integration, self.config_dir()) {
            (Some("claude"), Some(dir)) => (
                written("Claude MCP config", write_claude_config(dir)),
                written("Claude hooks settings", write_claude_settings(dir, &hook_url)),
            ),
            _ => (None, None),
        };
        let codex_notify = match integration {
            Some("codex") if !user_has_codex_notify() => self.hook_program(),
            _ => None,
        };
        let brief = role.map(Role::brief);
        let registration = Registration {
            url: &url,
            system_prompt: brief.as_deref(),
            claude_mcp: claude_mcp.as_deref(),
            claude_settings: claude_settings.as_deref(),
            codex_notify: codex_notify.as_deref(),
        };
        let command = if command.trim().is_empty() || command.trim() == "shell" {
            command.to_string()
        } else {
            rewrite_command(command, &agent, registration, quoting)
        };
        Some(McpLaunch {
            env: vec![
                (ENV_URL.into(), url.clone()),
                (ENV_HOOK_URL.into(), hook_url),
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
    fn claude_gets_hooks_and_its_config_file_last() {
        let mcp = Path::new("/Users/me/Library/Application Support/x/claude-mcp.json");
        let hooks = Path::new("/Users/me/Library/Application Support/x/claude-hooks.json");
        let registration = Registration { url: URL, claude_mcp: Some(mcp), claude_settings: Some(hooks), ..Registration::default() };
        assert_eq!(
            rewrite_command("claude --continue", "claude", registration, Quoting::Posix),
            "claude --continue --settings '/Users/me/Library/Application Support/x/claude-hooks.json' \
             --mcp-config '/Users/me/Library/Application Support/x/claude-mcp.json'"
        );
        let windows = Registration { url: URL, claude_mcp: Some(Path::new("C:\\a b\\c.json")), ..Registration::default() };
        assert_eq!(
            rewrite_command("claude", "claude", windows, Quoting::Windows),
            "claude --mcp-config \"C:\\a b\\c.json\""
        );
        let bare = Registration { url: URL, ..Registration::default() };
        assert_eq!(rewrite_command("claude", "claude", bare, Quoting::Posix), "claude");
        let brief = Role::Tester.brief();
        let role = Registration { url: URL, system_prompt: Some(&brief), claude_mcp: Some(Path::new("/m.json")), ..Registration::default() };
        assert_eq!(
            rewrite_command("claude", "claude", role, Quoting::Posix),
            format!("claude --append-system-prompt '{}' --mcp-config '/m.json'", brief)
        );
    }

    #[test]
    fn codex_gets_overrides_before_its_subcommand() {
        let registration = Registration { url: URL, ..Registration::default() };
        assert_eq!(
            rewrite_command("codex resume --last", "codex", registration, Quoting::Posix),
            "codex -c 'mcp_servers.terra.url=\"http://127.0.0.1:4100/mcp\"' \
             -c 'mcp_servers.terra.bearer_token_env_var=\"TERRA_MCP_TOKEN\"' resume --last"
        );
        assert_eq!(
            rewrite_command("codex", "codex", registration, Quoting::Windows),
            "codex -c mcp_servers.terra.url=http://127.0.0.1:4100/mcp \
             -c mcp_servers.terra.bearer_token_env_var=TERRA_MCP_TOKEN"
        );
    }

    #[test]
    fn codex_notify_runs_this_app_as_a_hook_on_posix_only() {
        let program = Path::new("/Applications/Terra Swarm.app/Contents/MacOS/terra-swarm");
        let registration = Registration { url: URL, codex_notify: Some(program), ..Registration::default() };
        let posix = rewrite_command("codex", "codex", registration, Quoting::Posix);
        assert!(posix.ends_with(
            "-c 'notify=[\"/Applications/Terra Swarm.app/Contents/MacOS/terra-swarm\",\"hook\",\"codex\",\"notify\"]'"
        ), "{}", posix);
        assert!(!rewrite_command("codex", "codex", registration, Quoting::Windows).contains("notify"));
    }

    #[test]
    fn an_existing_codex_notify_is_detected() {
        assert!(codex_config_sets_notify("model = \"o3\"\nnotify = [\"say\", \"done\"]\n"));
        assert!(!codex_config_sets_notify("model = \"o3\"\n[tui]\nnotify = true\n"));
        assert!(!codex_config_sets_notify(""));
    }

    #[test]
    fn claude_hooks_settings_hold_no_secret() {
        let json: serde_json::Value = serde_json::from_str(&claude_settings_json("http://127.0.0.1:4100/hooks")).unwrap();
        for event in ["SessionStart", "UserPromptSubmit", "PreToolUse", "Notification", "Stop"] {
            let handler = &json["hooks"][event][0]["hooks"][0];
            assert_eq!(handler["type"], "http", "{}", event);
            assert_eq!(handler["url"], "http://127.0.0.1:4100/hooks/claude");
            assert_eq!(handler["headers"]["Authorization"], "Bearer ${TERRA_MCP_TOKEN}");
            assert_eq!(handler["allowedEnvVars"], serde_json::json!(["TERRA_MCP_TOKEN"]));
        }
    }

    #[test]
    fn other_commands_are_left_alone() {
        let registration = Registration { url: URL, ..Registration::default() };
        assert_eq!(
            rewrite_command("opencode --continue", "opencode", registration, Quoting::Posix),
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
            .launch("t-1", "ws-1", "claude", None, Quoting::Posix)
            .is_none());
        hub.set_port(4100);
        let launch = hub.launch("t-1", "ws-1", "shell", None, Quoting::Posix).unwrap();
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
