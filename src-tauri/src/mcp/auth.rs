//! Per-terminal bearer tokens. They live only in memory: a restart issues
//! new ones to the terminals it respawns.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Weak};

use super::model::Actor;
use super::McpHub;
use tauri::{Runtime, Wry};

/// Who is calling: resolved from the bearer token, never from the request.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct AgentIdentity {
    pub terminal_id: String,
    pub workspace_id: String,
    pub agent: String,
    /// The team role the agent was started with, if any.
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

pub fn new_token() -> String {
    let mut bytes = [0u8; TOKEN_BYTES];
    // getrandom only fails when the OS has no entropy source at all; a
    // guessable token is worse than not starting the terminal's access.
    getrandom::fill(&mut bytes).expect("no OS randomness available for MCP tokens");
    bytes.iter().map(|byte| format!("{:02x}", byte)).collect()
}

/// `t-2` sorts before `t-10`.
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
    /// A fresh token for a terminal; any older token of it stops working.
    pub fn issue(&mut self, identity: AgentIdentity) -> String {
        let token = new_token();
        self.by_token
            .retain(|_, existing| existing.terminal_id != identity.terminal_id);
        self.by_token.insert(token.clone(), identity);
        token
    }

    pub fn identify(&self, token: &str) -> Option<AgentIdentity> {
        self.by_token.get(token).cloned()
    }

    /// Revoke one token; returns its identity if the terminal now has none.
    pub fn revoke_token(&mut self, token: &str) -> Option<AgentIdentity> {
        let identity = self.by_token.remove(token)?;
        let still_connected = self
            .by_token
            .values()
            .any(|other| other.terminal_id == identity.terminal_id);
        (!still_connected).then_some(identity)
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

    /// Terminals of a workspace that hold a token, in terminal order.
    pub fn peers(&self, workspace_id: &str) -> Vec<AgentIdentity> {
        let mut peers: Vec<AgentIdentity> = self
            .by_token
            .values()
            .filter(|identity| identity.workspace_id == workspace_id)
            .cloned()
            .collect();
        peers.sort_by_key(|a| terminal_order(&a.terminal_id));
        peers.dedup_by(|a, b| a.terminal_id == b.terminal_id);
        peers
    }
}

/// Revokes its token when dropped. A PTY entry owns one, so every way a
/// terminal goes away (kill, stop, exit, app shutdown) also closes its
/// access to the MCP server.
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
    fn tokens_are_unique_and_replaced_per_terminal() {
        let mut registry = TokenRegistry::default();
        let first = registry.issue(identity("t-1", "ws-1"));
        let second = registry.issue(identity("t-1", "ws-1"));
        assert_ne!(first, second);
        assert_eq!(first.len(), 64);
        assert!(registry.identify(&first).is_none());
        assert_eq!(registry.identify(&second).unwrap().terminal_id, "t-1");
        // Revoking a token that was already replaced reports nothing.
        assert!(registry.revoke_token(&first).is_none());
        assert_eq!(registry.revoke_token(&second).unwrap().terminal_id, "t-1");
    }

    #[test]
    fn peers_are_per_workspace_and_ordered() {
        let mut registry = TokenRegistry::default();
        registry.issue(identity("t-10", "ws-1"));
        registry.issue(identity("t-2", "ws-1"));
        registry.issue(identity("t-3", "ws-2"));
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
