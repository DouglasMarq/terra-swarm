pub mod claude;
pub mod codex;

use serde_json::Value;
use std::ffi::OsStr;
use std::path::Path;

use super::launch::Quoting;
use super::model::AgentState;
use crate::usage::{SessionLog, TokenUsage};

pub(super) const MAX_SUMMARY_CHARS: usize = 200;

pub struct LaunchContext<'a> {
    pub url: &'a str,
    pub hook_url: &'a str,
    pub hook_program: Option<&'a Path>,
    pub config_dir: Option<&'a Path>,
    pub system_prompt: Option<&'a str>,
    pub quoting: Quoting,
}

pub trait AgentIntegration: Sync {
    fn id(&self) -> &'static str;
    fn launch_command(&self, command: &str, context: &LaunchContext<'_>) -> String;
    fn interpret(&self, event: &str, payload: &Value) -> Option<(AgentState, String)>;
    fn session_log(&self, payload: &Value) -> Option<SessionLog>;
    fn usage(&self, locator: &OsStr) -> Option<std::io::Result<TokenUsage>>;
}

const INTEGRATIONS: [&dyn AgentIntegration; 2] = [&claude::Claude, &codex::Codex];

pub fn by_id(id: &str) -> Option<&'static dyn AgentIntegration> {
    INTEGRATIONS
        .into_iter()
        .find(|integration| integration.id() == id)
}

pub fn of_agent(agent: &str) -> Option<&'static dyn AgentIntegration> {
    by_id(crate::agent_catalog::integration_of(agent)?)
}

pub fn usage_of(log: &SessionLog) -> Option<TokenUsage> {
    by_id(log.integration)?
        .usage(&log.locator)?
        .map_err(|error| eprintln!("failed to read an agent session log: {}", error))
        .ok()
}

fn text_field(payload: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| payload.get(*key).and_then(Value::as_str))
        .map(|text| text.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|text| !text.is_empty())
        .map(|text| {
            if text.chars().count() > MAX_SUMMARY_CHARS {
                let mut cut: String = text.chars().take(MAX_SUMMARY_CHARS - 1).collect();
                cut.push('…');
                cut
            } else {
                text
            }
        })
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::path::PathBuf;

    pub fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "terra-usage-{}-{}-{}",
            name,
            std::process::id(),
            crate::clock::now_millis()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn given_the_agent_catalog_when_resolving_each_integration_then_one_implements_it() {
        for agent in crate::agent_catalog::catalog() {
            let Some(integration) = agent.integration.as_deref() else {
                continue;
            };
            assert_eq!(
                by_id(integration).map(|found| found.id()),
                Some(integration),
                "{}",
                agent.id
            );
        }
    }

    #[test]
    fn given_an_agent_without_integration_when_resolving_it_then_none_is_found() {
        assert!(of_agent("opencode").is_none());
        assert!(of_agent("unknown").is_none());
        assert_eq!(of_agent("codex").map(|found| found.id()), Some("codex"));
    }
}
