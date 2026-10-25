use serde_json::Value;
use std::ffi::OsStr;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use super::{text_field, AgentIntegration, LaunchContext};
use crate::mcp::launch::{quote, Quoting, ENV_TOKEN, SERVER_NAME};
use crate::mcp::repo::AgentState;
use crate::usage::{number, SessionLog, TokenUsage};

const ID: &str = "codex";

/// How deep the Codex sessions folder is searched (`YYYY/MM/DD/<log>`).
const MAX_CODEX_LOG_DEPTH: usize = 4;

pub struct Codex;

pub struct Overrides<'a> {
    pub url: &'a str,
    pub notify: Option<&'a Path>,
}

impl AgentIntegration for Codex {
    fn id(&self) -> &'static str {
        ID
    }

    fn launch_command(&self, command: &str, context: &LaunchContext<'_>) -> String {
        let notify = if user_has_codex_notify() {
            None
        } else {
            context.hook_program
        };
        let overrides = Overrides {
            url: context.url,
            notify,
        };
        rewrite(command, &overrides, context.quoting)
    }

    fn interpret(&self, event: &str, payload: &Value) -> Option<(AgentState, String)> {
        match payload.get("type").and_then(Value::as_str).unwrap_or(event) {
            "agent-turn-complete" => Some((
                AgentState::Idle,
                text_field(
                    payload,
                    &["last-assistant-message", "last_assistant_message"],
                )
                .unwrap_or_default(),
            )),
            _ => None,
        }
    }

    fn session_log(&self, payload: &Value) -> Option<SessionLog> {
        payload
            .get("thread-id")
            .or_else(|| payload.get("thread_id"))
            .and_then(Value::as_str)
            .filter(|thread| !thread.is_empty())
            .map(|thread| SessionLog {
                integration: ID,
                locator: thread.into(),
            })
    }

    fn usage(&self, locator: &OsStr) -> Option<std::io::Result<TokenUsage>> {
        let thread = locator.to_str()?;
        Some(codex_usage(&find_codex_log(
            &codex_sessions_dir()?,
            thread,
        )?))
    }
}

pub fn rewrite(command: &str, registration: &Overrides<'_>, quoting: Quoting) -> String {
    // `-c` is a global flag, so it is valid before a subcommand such as
    // `codex resume --last`. The token is read from the environment.
    let rest = command
        .split_once(char::is_whitespace)
        .map(|(_, rest)| rest.trim_start())
        .unwrap_or("");
    let executable = command.split_whitespace().next().unwrap_or("codex");
    let url = registration.url;
    let mut overrides = match quoting {
        Quoting::Posix => format!(
            "-c {} -c {}",
            quote(
                &format!("mcp_servers.{}.url=\"{}\"", SERVER_NAME, url),
                quoting
            ),
            quote(
                &format!(
                    "mcp_servers.{}.bearer_token_env_var=\"{}\"",
                    SERVER_NAME, ENV_TOKEN
                ),
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
    if let (Some(program), Quoting::Posix) = (registration.notify, quoting) {
        let program = serde_json::to_string(&program.to_string_lossy()).unwrap_or_default();
        overrides.push_str(&format!(
            " -c {}",
            quote(
                &format!("notify=[{},\"hook\",\"codex\",\"notify\"]", program),
                quoting
            )
        ));
    }
    if rest.is_empty() {
        format!("{} {}", executable, overrides)
    } else {
        format!("{} {} {}", executable, overrides, rest)
    }
}

/// Whether the user's own Codex config already sets `notify`; Terra's hook
/// would replace it, so it is left out then.
pub fn user_has_codex_notify() -> bool {
    let Some(home) = std::env::var_os("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| std::path::Path::new(&home).join(".codex"))
        })
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

/// Codex logs running totals; the last `token_count` event has them.
pub fn codex_usage(path: &Path) -> std::io::Result<TokenUsage> {
    let reader = BufReader::new(std::fs::File::open(path)?);
    let mut total = TokenUsage::default();
    for line in reader.lines() {
        let Ok(line) = line else { continue };
        let Ok(entry) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let payload = entry.get("payload").unwrap_or(&Value::Null);
        match payload.get("type").and_then(Value::as_str) {
            Some("token_count") => {
                if let Some(usage) = payload.pointer("/info/total_token_usage") {
                    let cached = number(usage, "cached_input_tokens");
                    total.input_tokens = number(usage, "input_tokens").saturating_sub(cached);
                    total.cache_read_tokens = cached;
                    total.output_tokens = number(usage, "output_tokens");
                }
            }
            Some("agent_message") => total.turns += 1,
            _ => {}
        }
        if let Some(model) = payload.get("model").and_then(Value::as_str) {
            total.model = Some(model.to_string());
        }
    }
    Ok(total)
}

/// The Codex rollout file of `thread_id`, searched newest day first.
pub fn find_codex_log(sessions: &Path, thread_id: &str) -> Option<PathBuf> {
    if thread_id.is_empty()
        || !thread_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return None;
    }
    fn walk(dir: &Path, thread_id: &str, depth: usize) -> Option<PathBuf> {
        let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
            .ok()?
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .collect();
        entries.sort();
        entries.reverse();
        for path in entries {
            if path.is_dir() && depth < MAX_CODEX_LOG_DEPTH {
                if let Some(found) = walk(&path, thread_id, depth + 1) {
                    return Some(found);
                }
            } else if path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".jsonl") && name.contains(thread_id))
            {
                return Some(path);
            }
        }
        None
    }
    walk(sessions, thread_id, 0)
}

fn codex_sessions_dir() -> Option<PathBuf> {
    let base = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| crate::paths::home_dir().map(|home| home.join(".codex")))?;
    Some(base.join("sessions"))
}

#[cfg(test)]
mod tests {
    use super::super::test_support::temp;
    use super::*;

    const URL: &str = "http://127.0.0.1:4100/mcp";

    #[test]
    fn codex_gets_overrides_before_its_subcommand() {
        let registration = Overrides {
            url: URL,
            notify: None,
        };
        assert_eq!(
            rewrite("codex resume --last", &registration, Quoting::Posix),
            "codex -c 'mcp_servers.terra.url=\"http://127.0.0.1:4100/mcp\"' \
             -c 'mcp_servers.terra.bearer_token_env_var=\"TERRA_MCP_TOKEN\"' resume --last"
        );
        assert_eq!(
            rewrite("codex", &registration, Quoting::Windows),
            "codex -c mcp_servers.terra.url=http://127.0.0.1:4100/mcp \
             -c mcp_servers.terra.bearer_token_env_var=TERRA_MCP_TOKEN"
        );
    }

    #[test]
    fn codex_notify_runs_this_app_as_a_hook_on_posix_only() {
        let program = Path::new("/Applications/Terra Swarm.app/Contents/MacOS/terra-swarm");
        let registration = Overrides {
            url: URL,
            notify: Some(program),
        };
        let posix = rewrite("codex", &registration, Quoting::Posix);
        assert!(posix.ends_with(
            "-c 'notify=[\"/Applications/Terra Swarm.app/Contents/MacOS/terra-swarm\",\"hook\",\"codex\",\"notify\"]'"
        ), "{}", posix);
        assert!(!rewrite("codex", &registration, Quoting::Windows).contains("notify"));
    }

    #[test]
    fn an_existing_codex_notify_is_detected() {
        assert!(codex_config_sets_notify(
            "model = \"o3\"\nnotify = [\"say\", \"done\"]\n"
        ));
        assert!(!codex_config_sets_notify(
            "model = \"o3\"\n[tui]\nnotify = true\n"
        ));
        assert!(!codex_config_sets_notify(""));
    }

    #[test]
    fn codex_takes_the_last_running_total() {
        let sessions = temp("codex");
        let day = sessions.join("2026/10/20");
        std::fs::create_dir_all(&day).unwrap();
        let log = day.join("rollout-2026-10-20T10-00-00-abc-123.jsonl");
        let lines = [
            r#"{"type":"turn_context","payload":{"model":"gpt-test"}}"#,
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":9}}}}"#,
            r#"{"type":"event_msg","payload":{"type":"agent_message","message":"done"}}"#,
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":300,"cached_input_tokens":200,"output_tokens":30}}}}"#,
        ];
        std::fs::write(&log, lines.join("\n")).unwrap();
        assert_eq!(find_codex_log(&sessions, "abc-123"), Some(log.clone()));
        assert_eq!(find_codex_log(&sessions, "../etc"), None);
        let usage = codex_usage(&log).unwrap();
        assert_eq!(
            (
                usage.input_tokens,
                usage.cache_read_tokens,
                usage.output_tokens,
                usage.turns
            ),
            (100, 200, 30, 1)
        );
        assert_eq!(usage.model.as_deref(), Some("gpt-test"));
        let _ = std::fs::remove_dir_all(sessions);
    }
}
