use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Weak};

use super::model::Actor;
use super::McpHub;
use tauri::{Runtime, Wry};

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct AgentIdentity {
    pub terminal_id: String,
    pub workspace_id: String,
    pub agent: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<crate::roles::Role>,
}

impl AgentIdentity {
    pub fn actor(&self) -> Actor<'_> {
        Actor {
            workspace_id: &self.workspace_id,
            name: &self.terminal_id,
        }
    }
}

const TOKEN_BYTES: usize = 32;

pub fn new_token() -> Result<String, getrandom::Error> {
    let mut bytes = [0u8; TOKEN_BYTES];
    getrandom::fill(&mut bytes)?;
    Ok(bytes.iter().map(|byte| format!("{:02x}", byte)).collect())
}

fn terminal_order(id: &str) -> (u64, String) {
    let number = id
        .strip_prefix("t-")
        .and_then(|rest| rest.parse::<u64>().ok())
        .unwrap_or(u64::MAX);
    (number, id.to_string())
}

#[derive(Default)]
pub struct TokenRegistry {
    by_token: HashMap<String, AgentIdentity>,
}

impl TokenRegistry {
    pub fn issue(&mut self, identity: AgentIdentity) -> Result<String, getrandom::Error> {
        let token = new_token()?;
        self.by_token
            .retain(|_, existing| existing.terminal_id != identity.terminal_id);
        self.by_token.insert(token.clone(), identity);
        Ok(token)
    }

    pub fn identify(&self, token: &str) -> Option<AgentIdentity> {
        self.by_token.get(token).cloned()
    }

    pub fn revoke_token(&mut self, token: &str) -> Option<AgentIdentity> {
        let identity = self.by_token.remove(token)?;
        let is_still_connected = self
            .by_token
            .values()
            .any(|other| other.terminal_id == identity.terminal_id);
        (!is_still_connected).then_some(identity)
    }

    #[cfg(test)]
    pub fn revoke_terminal(&mut self, terminal_id: &str) -> Option<AgentIdentity> {
        let identity = self
            .by_token
            .values()
            .find(|identity| identity.terminal_id == terminal_id)
            .cloned();
        self.by_token
            .retain(|_, identity| identity.terminal_id != terminal_id);
        identity
    }

    pub fn revoke_workspace(&mut self, workspace_id: &str) {
        self.by_token
            .retain(|_, identity| identity.workspace_id != workspace_id);
    }

    pub fn peers(&self, workspace_id: &str) -> Vec<AgentIdentity> {
        let mut peers: Vec<AgentIdentity> = self
            .by_token
            .values()
            .filter(|identity| identity.workspace_id == workspace_id)
            .cloned()
            .collect();
        peers.sort_by_key(|peer| terminal_order(&peer.terminal_id));
        peers.dedup_by(|peer, previous| peer.terminal_id == previous.terminal_id);
        peers
    }
}

pub struct McpLease<R: Runtime = Wry> {
    hub: Weak<McpHub<R>>,
    token: String,
}

impl<R: Runtime> McpLease<R> {
    pub fn new(hub: &Arc<McpHub<R>>, token: String) -> Self {
        Self {
            hub: Arc::downgrade(hub),
            token,
        }
    }
}

impl<R: Runtime> Drop for McpLease<R> {
    fn drop(&mut self) {
        if let Some(hub) = self.hub.upgrade() {
            hub.revoke_token(&self.token);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(terminal_id: &str, workspace_id: &str) -> AgentIdentity {
        AgentIdentity {
            terminal_id: terminal_id.into(),
            workspace_id: workspace_id.into(),
            agent: "claude".into(),
            role: None,
        }
    }

    #[test]
    fn given_a_terminal_when_issuing_tokens_then_they_are_unique_and_replace_the_previous_one() {
        let mut registry = TokenRegistry::default();
        let first = registry.issue(identity("t-1", "ws-1")).unwrap();
        let second = registry.issue(identity("t-1", "ws-1")).unwrap();
        assert_ne!(first, second);
        assert_eq!(first.len(), 64);
        assert!(registry.identify(&first).is_none());
        assert_eq!(registry.identify(&second).unwrap().terminal_id, "t-1");
        assert!(registry.revoke_token(&first).is_none());
        assert_eq!(registry.revoke_token(&second).unwrap().terminal_id, "t-1");
    }

    #[test]
    fn given_agents_in_several_workspaces_when_listing_peers_then_they_are_per_workspace_and_ordered(
    ) {
        let mut registry = TokenRegistry::default();
        registry.issue(identity("t-10", "ws-1")).unwrap();
        registry.issue(identity("t-2", "ws-1")).unwrap();
        registry.issue(identity("t-3", "ws-2")).unwrap();
        let peers: Vec<String> = registry
            .peers("ws-1")
            .into_iter()
            .map(|peer| peer.terminal_id)
            .collect();
        assert_eq!(peers, vec!["t-2", "t-10"]);
        registry.revoke_terminal("t-2");
        assert_eq!(registry.peers("ws-1").len(), 1);
        registry.revoke_workspace("ws-1");
        assert!(registry.peers("ws-1").is_empty());
        assert_eq!(registry.peers("ws-2").len(), 1);
    }
}
