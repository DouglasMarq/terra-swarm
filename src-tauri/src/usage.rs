//! Token usage per agent, read from the session logs the agent CLIs keep on
//! disk: Claude Code's `~/.claude/projects/**/<session>.jsonl` and Codex's
//! `~/.codex/sessions/**/rollout-*-<thread>.jsonl`. Hooks tell Terra which log
//! belongs to which terminal; only token counts are ever read out of them.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

/// The session log of a terminal, as its hooks reported it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionLog {
    Claude(PathBuf),
    Codex(String),
}

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Prompt tokens served from the cache.
    pub cache_read_tokens: u64,
    /// Prompt tokens written to the cache (Claude only).
    pub cache_write_tokens: u64,
    /// Model replies counted.
    pub turns: u64,
    /// The model of the latest reply.
    pub model: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct AgentUsage {
    pub terminal_id: String,
    pub agent: String,
    #[serde(flatten)]
    pub usage: TokenUsage,
}

/// How deep the Codex sessions folder is searched (`YYYY/MM/DD/<log>`).
const MAX_CODEX_LOG_DEPTH: usize = 4;

fn number(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

/// Sum the assistant replies of a Claude Code transcript. A reply with
/// several content blocks is logged once per block, so replies are counted
/// once per message id.
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

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn claude_projects_dir() -> Option<PathBuf> {
    let base = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| home().map(|home| home.join(".claude")))?;
    Some(base.join("projects"))
}

fn codex_sessions_dir() -> Option<PathBuf> {
    let base = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| home().map(|home| home.join(".codex")))?;
    Some(base.join("sessions"))
}

/// A transcript path from a hook is accepted only inside Claude's own
/// projects folder: the hook payload comes from the agent.
pub fn accept_claude_transcript(path: &str, projects: Option<&Path>) -> Option<PathBuf> {
    let projects = projects?.canonicalize().ok()?;
    let path = Path::new(path).canonicalize().ok()?;
    (path.starts_with(&projects) && path.extension().is_some_and(|ext| ext == "jsonl"))
        .then_some(path)
}

pub fn claude_transcript_from_hook(path: &str) -> Option<PathBuf> {
    accept_claude_transcript(path, claude_projects_dir().as_deref())
}

pub fn usage_of(log: &SessionLog) -> Option<TokenUsage> {
    let usage = match log {
        SessionLog::Claude(path) => claude_usage(path),
        SessionLog::Codex(thread) => codex_usage(&find_codex_log(&codex_sessions_dir()?, thread)?),
    };
    usage
        .map_err(|error| eprintln!("failed to read an agent session log: {}", error))
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "terra-usage-{}-{}-{}",
            name,
            std::process::id(),
            crate::mcp::repo::now_millis()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn claude_replies_count_once_per_message() {
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

    #[test]
    fn only_transcripts_inside_claudes_folder_are_read() {
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
}
