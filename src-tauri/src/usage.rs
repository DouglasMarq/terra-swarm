//! Token usage per agent, read from the session logs the agent CLIs keep on
//! disk: Claude Code's `~/.claude/projects/**/<session>.jsonl` and Codex's
//! `~/.codex/sessions/**/rollout-*-<thread>.jsonl`. Hooks tell Terra which log
//! belongs to which terminal; only token counts are ever read out of them.

use serde::Serialize;
use serde_json::Value;

/// The session log of a terminal, as its hooks reported it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionLog {
    pub integration: &'static str,
    pub locator: std::ffi::OsString,
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

pub(crate) fn number(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}
