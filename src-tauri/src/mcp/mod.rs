//! Embedded MCP server that lets the agent CLIs running in Terra Swarm's
//! terminals share a task board, message each other and keep project notes.
//!
//! - `db`: SQLite connection and migrations (`<app_data_dir>/mcp.db`).
//! - `repo`: the queries, shared by the MCP tools and the Tasks panel.
//! - `auth`: per-terminal bearer tokens.
//! - `tools`: the MCP tool catalogue and its handlers, independent of HTTP.
//! - `server`: Streamable HTTP transport on 127.0.0.1 (rmcp + axum).
//! - `launch`: how a terminal gets its token, environment and CLI flags.
//! - `commands`: Tauri commands used by the Tasks panel and Settings.

pub mod auth;
pub mod commands;
pub mod db;
pub mod hooks;
pub mod launch;
pub mod repo;
pub mod server;
pub mod tools;

use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use auth::TokenRegistry;
pub use auth::{AgentIdentity, McpLease};
use repo::{AgentStatus, Message, Repo, StoreError, StoreResult};

pub const EVENT_TASKS_CHANGED: &str = "mcp-tasks-changed";
pub const EVENT_MESSAGE: &str = "mcp-message";
pub const EVENT_AGENT_STATUS: &str = "mcp-agent-status";

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
    /// Ids of every terminal of the workspace, running or not.
    fn terminals(&self, workspace_id: &str) -> Vec<String>;
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct ServerInfo {
    /// The "Expose Terra MCP to agents" preference.
    pub enabled: bool,
    /// False when `mcp.db` could not be opened or migrated.
    pub available: bool,
    pub running: bool,
    pub url: Option<String>,
    pub port: Option<u16>,
    pub db_path: Option<String>,
    pub error: Option<String>,
}

pub struct McpHub {
    repo: Option<Mutex<Repo>>,
    error: Option<String>,
    db_path: Option<PathBuf>,
    tokens: Mutex<TokenRegistry>,
    port: Mutex<Option<u16>>,
    /// This app's binary, run by Codex as its `notify` hook.
    hook_program: Mutex<Option<PathBuf>>,
    /// Where generated client config files (Claude's `--mcp-config`) live.
    config_dir: Option<PathBuf>,
    host: Box<dyn McpHost>,
}

fn guard<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

impl McpHub {
    /// Open `mcp.db`. When it cannot be opened or migrated the app keeps
    /// running with the MCP server off, and Settings shows why.
    pub fn open(db_path: PathBuf, config_dir: Option<PathBuf>, host: Box<dyn McpHost>) -> Self {
        let (repo, error) = match db::open(&db_path) {
            Ok(conn) => (Some(Mutex::new(Repo::new(conn))), None),
            Err(error) => {
                eprintln!("MCP disabled: cannot open {}: {}", db_path.display(), error);
                (None, Some(error))
            }
        };
        Self {
            repo,
            error,
            db_path: Some(db_path),
            tokens: Mutex::new(TokenRegistry::default()),
            port: Mutex::new(None),
            hook_program: Mutex::new(None),
            config_dir,
            host,
        }
    }

    #[cfg(test)]
    pub fn with_repo(repo: Repo, config_dir: Option<PathBuf>, host: Box<dyn McpHost>) -> Self {
        Self {
            repo: Some(Mutex::new(repo)),
            error: None,
            db_path: None,
            tokens: Mutex::new(TokenRegistry::default()),
            port: Mutex::new(None),
            hook_program: Mutex::new(None),
            config_dir,
            host,
        }
    }

    pub fn available(&self) -> bool {
        self.repo.is_some()
    }

    pub fn repo(&self) -> StoreResult<MutexGuard<'_, Repo>> {
        match &self.repo {
            Some(repo) => Ok(guard(repo)),
            None => Err(StoreError::Unavailable(
                self.error
                    .clone()
                    .unwrap_or_else(|| "not initialized".into()),
            )),
        }
    }

    pub fn set_port(&self, port: u16) {
        *guard(&self.port) = Some(port);
    }

    pub fn port(&self) -> Option<u16> {
        *guard(&self.port)
    }

    pub fn url(&self) -> Option<String> {
        self.port()
            .map(|port| format!("http://127.0.0.1:{}/mcp", port))
    }

    pub fn set_hook_program(&self, program: PathBuf) {
        *guard(&self.hook_program) = Some(program);
    }

    pub fn hook_program(&self) -> Option<PathBuf> {
        guard(&self.hook_program).clone()
    }

    pub fn config_dir(&self) -> Option<&PathBuf> {
        self.config_dir.as_ref()
    }

    pub fn enabled(&self) -> bool {
        self.repo().map(|repo| repo.enabled()).unwrap_or(false)
    }

    pub fn info(&self) -> ServerInfo {
        let port = self.port();
        ServerInfo {
            enabled: self.enabled(),
            available: self.available(),
            running: port.is_some(),
            url: self.url(),
            port,
            db_path: self.db_path.as_ref().map(|path| path.display().to_string()),
            error: self.error.clone(),
        }
    }

    pub fn workspace(&self, workspace_id: &str) -> Option<WorkspaceInfo> {
        self.host.workspace(workspace_id)
    }

    pub fn workspace_terminals(&self, workspace_id: &str) -> Vec<String> {
        self.host.terminals(workspace_id)
    }

    // ----- tokens ---------------------------------------------------------

    pub fn issue(&self, identity: AgentIdentity) -> String {
        guard(&self.tokens).issue(identity)
    }

    pub fn identify(&self, token: &str) -> Option<AgentIdentity> {
        guard(&self.tokens).identify(token)
    }

    /// The terminal's status goes away with its last token.
    pub fn revoke_token(&self, token: &str) {
        let gone = guard(&self.tokens).revoke_token(token);
        if let Some(identity) = gone {
            self.forget_agent(&identity);
        }
    }

    #[cfg(test)]
    pub fn revoke_terminal(&self, terminal_id: &str) {
        let gone = guard(&self.tokens).revoke_terminal(terminal_id);
        if let Some(identity) = gone {
            self.forget_agent(&identity);
        }
    }

    pub fn peers(&self, workspace_id: &str) -> Vec<AgentIdentity> {
        guard(&self.tokens).peers(workspace_id)
    }

    fn forget_agent(&self, identity: &AgentIdentity) {
        if let Ok(mut repo) = self.repo() {
            repo.forget_status(&identity.terminal_id);
        }
        self.host.emit(
            EVENT_AGENT_STATUS,
            serde_json::json!({
                "workspace_id": identity.workspace_id,
                "terminal_id": identity.terminal_id,
                "status": null,
            }),
        );
    }

    // ----- workspace lifecycle --------------------------------------------

    /// Delete a closed workspace's board, messages, notes and statuses.
    pub fn purge_workspace(&self, workspace_id: &str) {
        guard(&self.tokens).revoke_workspace(workspace_id);
        match self.repo() {
            Ok(mut repo) => {
                if let Err(error) = repo.purge_workspace(workspace_id) {
                    eprintln!("failed to purge MCP data of {}: {}", workspace_id, error);
                }
            }
            Err(_) => return,
        }
        self.emit_tasks_changed(workspace_id);
    }

    // ----- events ---------------------------------------------------------

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

    /// An agent is waiting for a human (a permission prompt, a question).
    pub fn emit_attention(&self, status: &AgentStatus) {
        let workspace = self.workspace(&status.workspace_id);
        self.host.emit(
            hooks::EVENT_AGENT_ATTENTION,
            serde_json::json!({
                "workspace_id": status.workspace_id,
                "workspace_name": workspace.map(|info| info.name),
                "terminal_id": status.terminal_id,
                "message": status.summary,
            }),
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

/// Called by `close_workspace`: workspaces live in `workspaces.json`, so
/// their MCP data has no foreign key to cascade from.
pub fn purge_workspace<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str) {
    use tauri::Manager;
    if let Some(hub) = app.try_state::<Arc<McpHub>>() {
        hub.purge_workspace(workspace_id);
    }
}

/// Tauri side of [`McpHost`].
pub struct TauriHost<R: tauri::Runtime> {
    pub app: tauri::AppHandle<R>,
}

impl<R: tauri::Runtime> TauriHost<R> {
    fn with_workspace<T>(
        &self,
        workspace_id: &str,
        read: impl FnOnce(&crate::workspace::Workspace) -> T,
    ) -> Option<T> {
        use tauri::Manager;
        let store = self
            .app
            .try_state::<Mutex<crate::workspace::WorkspaceStore>>()?;
        let store = store.lock().ok()?;
        store.get(workspace_id).map(read)
    }
}

impl<R: tauri::Runtime> McpHost for TauriHost<R> {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        use tauri::Emitter;
        let _ = self.app.emit(event, payload);
    }

    fn workspace(&self, workspace_id: &str) -> Option<WorkspaceInfo> {
        self.with_workspace(workspace_id, |workspace| WorkspaceInfo {
            name: workspace.name.clone(),
            cwd: workspace.cwd.clone(),
        })
    }

    fn terminals(&self, workspace_id: &str) -> Vec<String> {
        self.with_workspace(workspace_id, |workspace| {
            workspace
                .terminals
                .iter()
                .map(|terminal| terminal.id.clone())
                .collect()
        })
        .unwrap_or_default()
    }
}

#[cfg(test)]
pub mod test_support {
    use super::*;

    pub type Events = Arc<Mutex<Vec<(String, serde_json::Value)>>>;

    /// Records emitted events; knows no terminals beyond the live tokens.
    #[derive(Default)]
    pub struct RecordingHost {
        pub events: Events,
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

        fn terminals(&self, _workspace_id: &str) -> Vec<String> {
            Vec::new()
        }
    }

    pub fn hub() -> (Arc<McpHub>, Events) {
        let host = RecordingHost::default();
        let events = Arc::clone(&host.events);
        (
            Arc::new(McpHub::with_repo(Repo::in_memory(), None, Box::new(host))),
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
    fn purge_revokes_tokens_and_clears_data() {
        let (hub, events) = hub();
        let token = hub.issue(identity("t-1", "ws-1", "claude"));
        hub.repo()
            .unwrap()
            .create_task(
                "ws-1",
                "t-1",
                repo::NewTask {
                    title: "x".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        hub.purge_workspace("ws-1");
        assert!(hub.identify(&token).is_none());
        assert!(hub
            .repo()
            .unwrap()
            .list_tasks("ws-1", None, None, None)
            .unwrap()
            .is_empty());
        assert!(events
            .lock()
            .unwrap()
            .iter()
            .any(|(e, p)| e == EVENT_TASKS_CHANGED && p["workspace_id"] == "ws-1"));
    }

    #[test]
    fn an_unreadable_database_turns_the_server_off() {
        let dir = std::env::temp_dir().join(format!("terra-mcp-hub-{}", repo::now_millis()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(db::DB_FILE);
        std::fs::write(&path, b"this is not a sqlite database, not even close").unwrap();
        let hub = Arc::new(McpHub::open(
            path.clone(),
            None,
            Box::new(RecordingHost::default()),
        ));
        hub.set_port(4100);
        let info = hub.info();
        assert!(!info.available);
        assert!(!info.enabled);
        assert!(info.error.is_some());
        assert_eq!(
            info.db_path.as_deref(),
            Some(path.display().to_string().as_str())
        );
        assert!(matches!(hub.repo(), Err(StoreError::Unavailable(_))));
        assert!(hub
            .launch("t-1", "ws-1", "claude", launch::Quoting::Posix)
            .is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}
