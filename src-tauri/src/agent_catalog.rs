use serde::Deserialize;
use std::sync::OnceLock;

const AGENT_CATALOG_JSON: &str = include_str!("../../src/domain/agents.json");

#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct CatalogAgent {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub resume: Option<String>,
    #[serde(default)]
    pub integration: Option<String>,
}

#[derive(Deserialize)]
struct Catalog {
    agents: Vec<CatalogAgent>,
}

pub fn catalog() -> &'static [CatalogAgent] {
    static CATALOG: OnceLock<Vec<CatalogAgent>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str::<Catalog>(AGENT_CATALOG_JSON)
            .map(|catalog| catalog.agents)
            .expect("agents.json is compiled in and must parse")
    })
}

pub fn integration_of(agent: &str) -> Option<&'static str> {
    catalog()
        .iter()
        .find(|entry| entry.id == agent)
        .and_then(|entry| entry.integration.as_deref())
}

pub fn is_resume_command(command: &str) -> bool {
    let command = command.split_whitespace().collect::<Vec<_>>().join(" ");
    catalog()
        .iter()
        .any(|entry| entry.resume.as_deref() == Some(command.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn continuation_commands_are_recognised() {
        assert!(is_resume_command("claude --continue"));
        assert!(is_resume_command("codex  resume --last"));
        assert!(!is_resume_command("claude"));
        assert!(!is_resume_command("claude --model opus"));
    }

    #[test]
    fn the_catalog_parses_with_unique_ids() {
        let ids: Vec<&str> = catalog().iter().map(|agent| agent.id.as_str()).collect();
        let mut unique = ids.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), ids.len());
        assert_eq!(ids[0], "claude");
        assert_eq!(integration_of("claude"), Some("claude"));
        assert_eq!(integration_of("codex"), Some("codex"));
        assert_eq!(integration_of("opencode"), None);
        assert_eq!(integration_of("unknown"), None);
    }
}
