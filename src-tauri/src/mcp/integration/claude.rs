use serde_json::Value;
use std::collections::HashSet;
use std::ffi::OsStr;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use super::{text_field, AgentIntegration, LaunchContext};
use crate::mcp::launch::{quote, Quoting, ENV_TOKEN, ENV_URL, SERVER_NAME};
use crate::mcp::model::AgentState;
use crate::usage::{number, SessionLog, TokenUsage};

const ID: &str = "claude";

const CLAUDE_CONFIG_FILE: &str = "claude-mcp.json";
const CLAUDE_SETTINGS_FILE: &str = "claude-hooks.json";
const CLAUDE_HOOK_TIMEOUT_SECS: u64 = 5;

pub struct Claude;

#[derive(Default)]
pub struct Flags<'a> {
    pub mcp_config: Option<&'a Path>,
    pub settings: Option<&'a Path>,
    pub system_prompt: Option<&'a str>,
}

impl AgentIntegration for Claude {
    fn id(&self) -> &'static str {
        ID
    }

    fn has_http_hooks(&self) -> bool {
        true
    }

    fn http_hook_event(&self, payload: &Value) -> Option<String> {
        Some(payload.get("hook_event_name")?.as_str()?.to_string())
    }

    fn launch_command(&self, command: &str, context: &LaunchContext<'_>) -> String {
        let Some(dir) = context.config_dir else {
            let flags = Flags {
                system_prompt: context.system_prompt,
                ..Flags::default()
            };
            return rewrite(command, &flags, context.quoting);
        };
        let session_start = session_start_command(context);
        let mcp_config = written("Claude MCP config", write_claude_config(dir));
        let settings = written(
            "Claude hooks settings",
            write_claude_settings(dir, context.hook_url, session_start.as_deref()),
        );
        let flags = Flags {
            mcp_config: mcp_config.as_deref(),
            settings: settings.as_deref(),
            system_prompt: context.system_prompt,
        };
        rewrite(command, &flags, context.quoting)
    }

    fn interpret(&self, event: &str, payload: &Value) -> Option<(AgentState, String)> {
        match event {
            "UserPromptSubmit" => Some((
                AgentState::Working,
                text_field(payload, &["prompt"]).unwrap_or_default(),
            )),
            "PreToolUse" => Some((
                AgentState::Working,
                text_field(payload, &["tool_name"]).unwrap_or_default(),
            )),
            "Notification" => {
                let message = text_field(payload, &["message"]).unwrap_or_default();
                match payload.get("notification_type").and_then(Value::as_str) {
                    None
                    | Some("permission_prompt")
                    | Some("elicitation_dialog")
                    | Some("elicitation_url_dialog")
                    | Some("agent_needs_input") => Some((AgentState::NeedsInput, message)),
                    Some("idle_prompt") => Some((AgentState::Idle, String::new())),
                    Some(_) => None,
                }
            }
            "Stop" | "SessionStart" => Some((AgentState::Idle, String::new())),
            _ => None,
        }
    }

    fn session_log(&self, payload: &Value) -> Option<SessionLog> {
        payload
            .get("transcript_path")
            .and_then(Value::as_str)
            .and_then(claude_transcript_from_hook)
            .map(|path| SessionLog {
                integration: ID,
                locator: path.into_os_string(),
            })
    }

    fn usage(&self, locator: &OsStr) -> Option<std::io::Result<TokenUsage>> {
        Some(claude_usage(Path::new(locator)))
    }
}

fn session_start_command(context: &LaunchContext<'_>) -> Option<String> {
    context.hook_program.map(|program| {
        format!(
            "{} hook claude SessionStart",
            quote(&program.to_string_lossy(), context.quoting)
        )
    })
}

fn written(what: &str, result: std::io::Result<PathBuf>) -> Option<PathBuf> {
    match result {
        Ok(path) => Some(path),
        Err(error) => {
            eprintln!("failed to write the {}: {}", what, error);
            None
        }
    }
}

pub fn rewrite(command: &str, registration: &Flags<'_>, quoting: Quoting) -> String {
    let mut flags = String::new();
    if let Some(path) = registration.settings {
        flags.push_str(&format!(
            " --settings {}",
            quote(&path.to_string_lossy(), quoting)
        ));
    }
    if let Some(prompt) = registration.system_prompt {
        flags.push_str(&format!(
            " --append-system-prompt {}",
            quote(prompt, quoting)
        ));
    }
    if let Some(path) = registration.mcp_config {
        flags.push_str(&format!(
            " --mcp-config {}",
            quote(&path.to_string_lossy(), quoting)
        ));
    }
    format!("{}{}", command, flags)
}

pub fn claude_settings_json(hook_url: &str, session_start_command: Option<&str>) -> String {
    let handler = serde_json::json!({
        "type": "http",
        "url": format!("{}/claude", hook_url),
        "headers": { "Authorization": format!("Bearer ${{{}}}", ENV_TOKEN) },
        "allowedEnvVars": [ENV_TOKEN],
        "timeout": CLAUDE_HOOK_TIMEOUT_SECS,
    });
    let group = serde_json::json!([{ "hooks": [handler] }]);
    let mut hooks = serde_json::json!({
        "UserPromptSubmit": group,
        "PreToolUse": group,
        "Notification": group,
        "Stop": group,
    });
    if let Some(command) = session_start_command {
        hooks["SessionStart"] = serde_json::json!([{ "hooks": [{ "type": "command", "command": command, "timeout": CLAUDE_HOOK_TIMEOUT_SECS }] }]);
    }
    serde_json::json!({ "hooks": hooks }).to_string()
}

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

pub fn write_claude_settings(
    dir: &Path,
    hook_url: &str,
    session_start_command: Option<&str>,
) -> std::io::Result<PathBuf> {
    let path = dir.join(CLAUDE_SETTINGS_FILE);
    write_if_changed(
        &path,
        &claude_settings_json(hook_url, session_start_command),
    )?;
    Ok(path)
}

pub fn claude_usage(path: &Path) -> std::io::Result<TokenUsage> {
    let reader = BufReader::new(std::fs::File::open(path)?);
    let mut seen: HashSet<String> = HashSet::new();
    let mut total = TokenUsage::default();
    for line in reader.lines() {
        let Ok(line) = line else { continue };
        if !line.contains("\"usage\"") {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(message) = entry.get("message") else {
            continue;
        };
        let Some(usage) = message.get("usage") else {
            continue;
        };
        let key = format!(
            "{}:{}",
            message
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            entry
                .get("requestId")
                .and_then(Value::as_str)
                .unwrap_or_default()
        );
        if key != ":" && !seen.insert(key) {
            continue;
        }
        total.input_tokens += number(usage, "input_tokens");
        total.output_tokens += number(usage, "output_tokens");
        total.cache_read_tokens += number(usage, "cache_read_input_tokens");
        total.cache_write_tokens += number(usage, "cache_creation_input_tokens");
        total.turns += 1;
        if let Some(model) = message
            .get("model")
            .and_then(Value::as_str)
            .filter(|model| !model.starts_with('<'))
        {
            total.model = Some(model.to_string());
        }
    }
    Ok(total)
}

fn claude_projects_dir() -> Option<PathBuf> {
    let base = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| crate::paths::home_dir().map(|home| home.join(".claude")))?;
    Some(base.join("projects"))
}

pub fn accept_claude_transcript(path: &str, projects: Option<&Path>) -> Option<PathBuf> {
    let projects = projects?.canonicalize().ok()?;
    let path = Path::new(path).canonicalize().ok()?;
    (path.starts_with(&projects) && path.extension().is_some_and(|ext| ext == "jsonl"))
        .then_some(path)
}

pub fn claude_transcript_from_hook(path: &str) -> Option<PathBuf> {
    accept_claude_transcript(path, claude_projects_dir().as_deref())
}

#[cfg(test)]
mod tests {
    use super::super::test_support::temp;
    use super::*;
    use crate::roles::Role;

    #[test]
    fn given_a_claude_command_when_rewriting_then_it_gets_hooks_and_its_config_file_last() {
        let mcp = Path::new("/Users/me/Library/Application Support/x/claude-mcp.json");
        let hooks = Path::new("/Users/me/Library/Application Support/x/claude-hooks.json");
        let registration = Flags {
            mcp_config: Some(mcp),
            settings: Some(hooks),
            ..Flags::default()
        };
        assert_eq!(
            rewrite("claude --continue", &registration, Quoting::Posix),
            "claude --continue --settings '/Users/me/Library/Application Support/x/claude-hooks.json' \
             --mcp-config '/Users/me/Library/Application Support/x/claude-mcp.json'"
        );
        let windows = Flags {
            mcp_config: Some(Path::new("C:\\a b\\c.json")),
            ..Flags::default()
        };
        assert_eq!(
            rewrite("claude", &windows, Quoting::Windows),
            "claude --mcp-config \"C:\\a b\\c.json\""
        );
        let bare = Flags::default();
        assert_eq!(rewrite("claude", &bare, Quoting::Posix), "claude");
        let brief = Role::Tester.brief();
        let role = Flags {
            system_prompt: Some(&brief),
            mcp_config: Some(Path::new("/m.json")),
            ..Flags::default()
        };
        assert_eq!(
            rewrite("claude", &role, Quoting::Posix),
            format!(
                "claude --append-system-prompt '{}' --mcp-config '/m.json'",
                brief
            )
        );
    }

    #[test]
    fn given_claude_hook_settings_when_writing_them_then_they_hold_no_secret() {
        let json: serde_json::Value = serde_json::from_str(&claude_settings_json(
            "http://127.0.0.1:4100/hooks",
            Some("'/Applications/Terra Swarm.app/Contents/MacOS/terra-swarm' hook claude SessionStart"),
        ))
        .unwrap();
        let start = &json["hooks"]["SessionStart"][0]["hooks"][0];
        assert_eq!(start["type"], "command");
        assert!(start["command"]
            .as_str()
            .unwrap()
            .ends_with("hook claude SessionStart"));
        for event in ["UserPromptSubmit", "PreToolUse", "Notification", "Stop"] {
            let handler = &json["hooks"][event][0]["hooks"][0];
            assert_eq!(handler["type"], "http", "{}", event);
            assert_eq!(handler["url"], "http://127.0.0.1:4100/hooks/claude");
            assert_eq!(
                handler["headers"]["Authorization"],
                "Bearer ${TERRA_MCP_TOKEN}"
            );
            assert_eq!(
                handler["allowedEnvVars"],
                serde_json::json!(["TERRA_MCP_TOKEN"])
            );
        }
    }

    #[test]
    fn given_the_claude_config_when_writing_it_then_it_holds_no_secret() {
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
    fn given_claude_replies_when_counting_usage_then_each_message_counts_once() {
        let dir = temp("claude");
        let log = dir.join("s.jsonl");
        let reply = |id: &str, block: &str| {
            format!(
                r#"{{"requestId":"req_{id}","message":{{"id":"{id}","model":"claude-test","role":"assistant","content":[{{"type":"{block}"}}],"usage":{{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":100,"cache_creation_input_tokens":7}}}}}}"#
            )
        };
        let text = [
            r#"{"type":"user","message":{"role":"user","content":"hi"}}"#.to_string(),
            reply("m1", "thinking"),
            reply("m1", "text"),
            "not json".to_string(),
            reply("m2", "text"),
        ]
        .join("\n");
        std::fs::write(&log, text).unwrap();
        let usage = claude_usage(&log).unwrap();
        assert_eq!(
            usage,
            TokenUsage {
                input_tokens: 20,
                output_tokens: 10,
                cache_read_tokens: 200,
                cache_write_tokens: 14,
                turns: 2,
                model: Some("claude-test".into())
            }
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn given_transcript_paths_when_reading_then_only_those_inside_claudes_folder_are_read() {
        let projects = temp("projects");
        let inside = projects.join("p/s.jsonl");
        std::fs::create_dir_all(inside.parent().unwrap()).unwrap();
        std::fs::write(&inside, "").unwrap();
        let outside = projects.with_extension("jsonl");
        std::fs::write(&outside, "").unwrap();
        assert!(accept_claude_transcript(inside.to_str().unwrap(), Some(&projects)).is_some());
        assert!(accept_claude_transcript(outside.to_str().unwrap(), Some(&projects)).is_none());
        assert!(accept_claude_transcript("/etc/passwd", Some(&projects)).is_none());
        let _ = std::fs::remove_dir_all(&projects);
        let _ = std::fs::remove_file(outside);
    }

    #[test]
    fn given_a_config_folder_when_launching_claude_then_both_files_are_written_and_passed() {
        let dir = temp("claude-launch");
        let program = Path::new("/opt/terra-swarm");
        let context = LaunchContext {
            url: "http://127.0.0.1:4100/mcp",
            hook_url: "http://127.0.0.1:4100/hooks",
            hook_program: Some(program),
            config_dir: Some(&dir),
            system_prompt: None,
            quoting: Quoting::Posix,
        };

        let command = Claude.launch_command("claude", &context);

        let settings = std::fs::read_to_string(dir.join(CLAUDE_SETTINGS_FILE)).unwrap();
        assert!(settings.contains("'/opt/terra-swarm' hook claude SessionStart"));
        assert!(dir.join(CLAUDE_CONFIG_FILE).is_file());
        assert_eq!(
            command,
            format!(
                "claude --settings '{}' --mcp-config '{}'",
                dir.join(CLAUDE_SETTINGS_FILE).display(),
                dir.join(CLAUDE_CONFIG_FILE).display()
            )
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
