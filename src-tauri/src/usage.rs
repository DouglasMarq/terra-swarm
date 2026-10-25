use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionLog {
    pub integration: &'static str,
    pub locator: std::ffi::OsString,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub turns: u64,
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
