//! Embedded MCP server that lets the agent CLIs running in Terra Swarm's
//! terminals share a task board, message each other and keep project notes.
//!
//! - `store`: SQLite persistence (`<app_data_dir>/mcp.sqlite`).
//! - `tools`: the MCP tool catalogue and its handlers, independent of HTTP.
//! - `server`: Streamable HTTP transport on 127.0.0.1 (rmcp + axum) with
//!   per-terminal bearer tokens.
//! - `launch`: how a terminal gets its token, environment and CLI flags.
//! - `commands`: Tauri commands used by the Tasks panel and Settings.

pub mod commands;
pub mod launch;
pub mod server;
pub mod store;
pub mod tools;

use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use store::{AgentStatus, McpStore, Message};

pub const EVENT_TASKS_CHANGED: &str = "mcp-tasks-changed";
pub const EVENT_MESSAGE: &str = "mcp-message";
pub const EVENT_AGENT_STATUS: &str = "mcp-agent-status";

/// Who is calling: resolved from the bearer token, never from the request.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct AgentIdentity {
    pub terminal_id: String,
    pub workspace_id: String,
    pub agent: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceInfo {
    pub name: String,
    pub cwd: String,
}

/// What the hub needs from the app around it. The Tauri implementation
/// emits window events and reads the workspace store; tests record calls.
pub trait McpHost: Send + Sync {
    fn emit(&self, event: &str, payload: serde_json::Value);
    fn workspace(&self, workspace_id: &str) -> Option<WorkspaceInfo>;
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct ServerInfo {
    pub enabled: bool,
    pub running: bool,
    pub url: Option<String>,
    pub port: Option<u16>,
}

pub struct McpHub {
    store: Mutex<McpStore>,
    tokens: Mutex<HashMap<String, AgentIdentity>>,
    port: Mutex<Option<u16>>,
    /// Where generated client config files (Claude's `--mcp-config`) live.
    config_dir: Option<PathBuf>,
    host: Box<dyn McpHost>,
}

fn new_token() -> String {
    let mut bytes = [0u8; 32];
    if getrandom::fill(&mut bytes).is_err() {
        // getrandom only fails when the OS has no entropy source at all;
        // refuse to hand out a guessable token in that case.
        panic!("no OS randomness available for MCP tokens");
    }
    bytes.iter().map(|byte| format!("{:02x}", byte)).collect()
}

impl McpHub {
    pub fn new(store: McpStore, config_dir: Option<PathBuf>, host: Box<dyn McpHost>) -> Self {
        Self {
            store: Mutex::new(store),
            tokens: Mutex::new(HashMap::new()),
            port: Mutex::new(None),
            config_dir,
            host,
        }
    }

    pub fn store(&self) -> MutexGuard<'_, McpStore> {
        self.store.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn tokens(&self) -> MutexGuard<'_, HashMap<String, AgentIdentity>> {
        self.tokens.lock().unwrap_or_else(|error| error.into_inner())
    }

    pub fn set_port(&self, port: u16) {
        *self.port.lock().unwrap_or_else(|error| error.into_inner()) = Some(port);
    }

    pub fn port(&self) -> Option<u16> {
        *self.port.lock().unwrap_or_else(|error| error.into_inner())
    }

    pub fn url(&self) -> Option<String> {
        self.port().map(|port| format!("http://127.0.0.1:{}/mcp", port))
    }

    pub fn config_dir(&self) -> Option<&PathBuf> {
        self.config_dir.as_ref()
    }

    pub fn enabled(&self) -> bool {
        self.store().enabled()
    }

    pub fn info(&self) -> ServerInfo {
        let port = self.port();
        ServerInfo {
            enabled: self.enabled(),
            running: port.is_some(),
            url: self.url(),
            port,
        }
    }

    pub fn workspace(&self, workspace_id: &str) -> Option<WorkspaceInfo> {
        self.host.workspace(workspace_id)
    }

    /// Hand out a fresh token for a terminal. Any older token of the same
    /// terminal stops working, so a restarted pane never keeps two.
    pub fn issue(&self, identity: AgentIdentity) -> String {
        let token = new_token();
        let mut tokens = self.tokens();
        tokens.retain(|_, existing| existing.terminal_id != identity.terminal_id);
        tokens.insert(token.clone(), identity);
        token
    }

    pub fn identify(&self, token: &str) -> Option<AgentIdentity> {
        self.tokens().get(token).cloned()
    }

    /// Revoke one token. The terminal's status goes away with its last token.
    pub fn revoke_token(&self, token: &str) {
        let removed = {
            let mut tokens = self.tokens();
            tokens.remove(token).filter(|identity| {
                !tokens
                    .values()
                    .any(|other| other.terminal_id == identity.terminal_id)
            })
        };
        if let Some(identity) = removed {
            self.forget_agent(&identity);
        }
    }

    #[cfg(test)]
    pub fn revoke_terminal(&self, terminal_id: &str) {
        let removed: Vec<AgentIdentity> = {
            let mut tokens = self.tokens();
            let removed = tokens
                .values()
                .filter(|identity| identity.terminal_id == terminal_id)
                .cloned()
                .collect();
            tokens.retain(|_, identity| identity.terminal_id != terminal_id);
            removed
        };
        if let Some(identity) = removed.into_iter().next() {
            self.forget_agent(&identity);
        }
    }

    fn forget_agent(&self, identity: &AgentIdentity) {
        self.store().forget_status(&identity.terminal_id);
        self.host.emit(
            EVENT_AGENT_STATUS,
            serde_json::json!({
                "workspace_id": identity.workspace_id,
                "terminal_id": identity.terminal_id,
                "status": null,
            }),
        );
    }

    /// Terminals of a workspace that currently hold a token, by id.
    pub fn peers(&self, workspace_id: &str) -> Vec<AgentIdentity> {
        let mut peers: Vec<AgentIdentity> = self
            .tokens()
            .values()
            .filter(|identity| identity.workspace_id == workspace_id)
            .cloned()
            .collect();
        peers.sort_by(|a, b| terminal_order(&a.terminal_id).cmp(&terminal_order(&b.terminal_id)));
        peers.dedup_by(|a, b| a.terminal_id == b.terminal_id);
        peers
    }

    pub fn emit_tasks_changed(&self, workspace_id: &str) {
        self.host.emit(
            EVENT_TASKS_CHANGED,
            serde_json::json!({ "workspace_id": workspace_id }),
        );
    }

    pub fn emit_message(&self, message: &Message) {
        self.host.emit(
            EVENT_MESSAGE,
            serde_json::to_value(message).unwrap_or(serde_json::Value::Null),
        );
    }

    pub fn emit_agent_status(&self, status: &AgentStatus) {
        self.host.emit(
            EVENT_AGENT_STATUS,
            serde_json::json!({
                "workspace_id": status.workspace_id,
                "terminal_id": status.terminal_id,
                "status": status,
            }),
        );
    }
}

/// `t-2` sorts before `t-10`.
fn terminal_order(id: &str) -> (u64, String) {
    let number = id
        .strip_prefix("t-")
        .and_then(|rest| rest.parse::<u64>().ok())
        .unwrap_or(u64::MAX);
    (number, id.to_string())
}

/// Revokes its token when dropped. A PTY entry owns one, so every way a
/// terminal goes away (kill, stop, exit, app shutdown) also closes its
/// access to the MCP server.
pub struct McpLease {
    hub: std::sync::Weak<McpHub>,
    token: String,
}

impl McpLease {
    pub fn new(hub: &Arc<McpHub>, token: String) -> Self {
        Self {
            hub: Arc::downgrade(hub),
            token,
        }
    }
}

impl Drop for McpLease {
    fn drop(&mut self) {
        if let Some(hub) = self.hub.upgrade() {
            hub.revoke_token(&self.token);
        }
    }
}

/// Tauri side of [`McpHost`].
pub struct TauriHost<R: tauri::Runtime> {
    pub app: tauri::AppHandle<R>,
}

impl<R: tauri::Runtime> McpHost for TauriHost<R> {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        use tauri::Emitter;
        let _ = self.app.emit(event, payload);
    }

    fn workspace(&self, workspace_id: &str) -> Option<WorkspaceInfo> {
        use tauri::Manager;
        let store = self
            .app
            .try_state::<Mutex<crate::workspace::WorkspaceStore>>()?;
        let store = store.lock().ok()?;
        store.get(workspace_id).map(|workspace| WorkspaceInfo {
            name: workspace.name.clone(),
            cwd: workspace.cwd.clone(),
        })
    }
}

#[cfg(test)]
pub mod test_support {
    use super::*;

    /// Records emitted events and serves a fixed workspace list.
    #[derive(Default)]
    pub struct RecordingHost {
        pub events: Arc<Mutex<Vec<(String, serde_json::Value)>>>,
    }

    impl McpHost for RecordingHost {
        fn emit(&self, event: &str, payload: serde_json::Value) {
            self.events
                .lock()
                .unwrap()
                .push((event.to_string(), payload));
        }

        fn workspace(&self, workspace_id: &str) -> Option<WorkspaceInfo> {
            Some(WorkspaceInfo {
                name: format!("{} project", workspace_id),
                cwd: format!("/tmp/{}", workspace_id),
            })
        }
    }

    pub fn hub() -> (Arc<McpHub>, Arc<Mutex<Vec<(String, serde_json::Value)>>>) {
        let host = RecordingHost::default();
        let events = Arc::clone(&host.events);
        (
            Arc::new(McpHub::new(McpStore::in_memory(), None, Box::new(host))),
            events,
        )
    }

    pub fn identity(terminal_id: &str, workspace_id: &str, agent: &str) -> AgentIdentity {
        AgentIdentity {
            terminal_id: terminal_id.into(),
            workspace_id: workspace_id.into(),
            agent: agent.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    #[test]
    fn tokens_are_unique_and_replaced_per_terminal() {
        let (hub, _) = hub();
        let first = hub.issue(identity("t-1", "ws-1", "claude"));
        let second = hub.issue(identity("t-1", "ws-1", "claude"));
        assert_ne!(first, second);
        assert_eq!(first.len(), 64);
        assert!(hub.identify(&first).is_none());
        assert_eq!(hub.identify(&second).unwrap().terminal_id, "t-1");
    }

    #[test]
    fn dropping_a_lease_revokes_its_token_only() {
        let (hub, events) = hub();
        let token = hub.issue(identity("t-1", "ws-1", "claude"));
        let lease = McpLease::new(&hub, token.clone());
        let newer = hub.issue(identity("t-1", "ws-1", "claude"));
        // The stale lease belongs to a replaced token: dropping it must not
        // log the restarted terminal out.
        drop(lease);
        assert!(hub.identify(&newer).is_some());
        drop(McpLease::new(&hub, newer.clone()));
        assert!(hub.identify(&newer).is_none());
        assert!(events
            .lock()
            .unwrap()
            .iter()
            .any(|(event, _)| event == EVENT_AGENT_STATUS));
    }

    #[test]
    fn peers_are_per_workspace_and_ordered() {
        let (hub, _) = hub();
        hub.issue(identity("t-10", "ws-1", "codex"));
        hub.issue(identity("t-2", "ws-1", "claude"));
        hub.issue(identity("t-3", "ws-2", "claude"));
        let peers: Vec<String> = hub
            .peers("ws-1")
            .into_iter()
            .map(|peer| peer.terminal_id)
            .collect();
        assert_eq!(peers, vec!["t-2", "t-10"]);
        hub.revoke_terminal("t-2");
        assert_eq!(hub.peers("ws-1").len(), 1);
    }
}
