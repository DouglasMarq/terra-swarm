pub mod auth;
pub mod commands;
pub mod connect;
pub mod db;
pub mod hooks;
pub mod integration;
pub mod launch;
pub mod messages;
pub mod model;
pub mod notes;
pub mod repo;
pub mod server;
pub mod statuses;
pub mod tasks;
pub mod tools;

use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Emitter, Manager, Runtime, Wry};

use crate::sync::LockExt;
use crate::workspace::{Workspace, WorkspaceStore};
use auth::TokenRegistry;
pub use auth::{AgentIdentity, McpLease};
use model::{AgentStatus, Message, StoreError, StoreResult};
use repo::Repo;
use statuses::StatusRegistry;

pub const EVENT_TASKS_CHANGED: &str = "mcp-tasks-changed";
pub const EVENT_MESSAGE: &str = "mcp-message";
pub const EVENT_AGENT_STATUS: &str = "mcp-agent-status";
pub const EVENT_NUDGE: &str = "mcp-nudge";

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceInfo {
    pub name: String,
    pub cwd: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct ServerInfo {
    pub enabled: bool,
    pub available: bool,
    pub running: bool,
    pub url: Option<String>,
    pub port: Option<u16>,
    pub db_path: Option<String>,
    pub error: Option<String>,
}

pub struct McpHub<R: Runtime = Wry> {
    repo: Option<Mutex<Repo>>,
    statuses: Mutex<StatusRegistry>,
    error: Option<String>,
    db_path: Option<PathBuf>,
    tokens: Mutex<TokenRegistry>,
    port: Mutex<Option<u16>>,
    hook_program: Mutex<Option<PathBuf>>,
    config_dir: Option<PathBuf>,
    session_logs: Mutex<std::collections::HashMap<String, crate::usage::SessionLog>>,
    app: AppHandle<R>,
}

impl<R: Runtime> McpHub<R> {
    pub fn open(db_path: PathBuf, config_dir: Option<PathBuf>, app: AppHandle<R>) -> Self {
        let (repo, error) = match db::open(&db_path) {
            Ok(conn) => (Some(Mutex::new(Repo::new(conn))), None),
            Err(error) => {
                eprintln!("MCP disabled: cannot open {}: {}", db_path.display(), error);
                (None, Some(error))
            }
        };
        Self {
            repo,
            statuses: Mutex::new(StatusRegistry::default()),
            error,
            db_path: Some(db_path),
            tokens: Mutex::new(TokenRegistry::default()),
            port: Mutex::new(None),
            hook_program: Mutex::new(None),
            session_logs: Mutex::new(std::collections::HashMap::new()),
            config_dir,
            app,
        }
    }

    #[cfg(test)]
    pub fn with_repo(repo: Repo, config_dir: Option<PathBuf>, app: AppHandle<R>) -> Self {
        Self {
            repo: Some(Mutex::new(repo)),
            statuses: Mutex::new(StatusRegistry::default()),
            error: None,
            db_path: None,
            tokens: Mutex::new(TokenRegistry::default()),
            port: Mutex::new(None),
            hook_program: Mutex::new(None),
            session_logs: Mutex::new(std::collections::HashMap::new()),
            config_dir,
            app,
        }
    }

    pub fn is_available(&self) -> bool {
        self.repo.is_some()
    }

    pub fn repo(&self) -> StoreResult<MutexGuard<'_, Repo>> {
        match &self.repo {
            Some(repo) => Ok(repo.lock_or_recover()),
            None => Err(self.unavailable()),
        }
    }

    pub fn statuses(&self) -> StoreResult<MutexGuard<'_, StatusRegistry>> {
        if self.repo.is_none() {
            return Err(self.unavailable());
        }
        Ok(self.statuses.lock_or_recover())
    }

    fn unavailable(&self) -> StoreError {
        StoreError::Unavailable(
            self.error
                .clone()
                .unwrap_or_else(|| "not initialized".into()),
        )
    }

    pub fn set_port(&self, port: u16) {
        *self.port.lock_or_recover() = Some(port);
    }

    pub fn port(&self) -> Option<u16> {
        *self.port.lock_or_recover()
    }

    pub fn url(&self) -> Option<String> {
        self.port()
            .map(|port| format!("http://127.0.0.1:{}/mcp", port))
    }

    pub fn set_hook_program(&self, program: PathBuf) {
        *self.hook_program.lock_or_recover() = Some(program);
    }

    pub fn hook_program(&self) -> Option<PathBuf> {
        self.hook_program.lock_or_recover().clone()
    }

    pub fn config_dir(&self) -> Option<&PathBuf> {
        self.config_dir.as_ref()
    }

    pub fn is_enabled(&self) -> bool {
        self.repo().map(|repo| repo.is_enabled()).unwrap_or(false)
    }

    pub fn info(&self) -> ServerInfo {
        let port = self.port();
        ServerInfo {
            enabled: self.is_enabled(),
            available: self.is_available(),
            running: port.is_some(),
            url: self.url(),
            port,
            db_path: self.db_path.as_ref().map(|path| path.display().to_string()),
            error: self.error.clone(),
        }
    }

    fn with_workspace<T>(
        &self,
        workspace_id: &str,
        read: impl FnOnce(&Workspace) -> T,
    ) -> Option<T> {
        let store = self.app.try_state::<Mutex<WorkspaceStore>>()?;
        let store = store.lock_or_recover();
        store.get(workspace_id).map(read)
    }

    pub fn workspace(&self, workspace_id: &str) -> Option<WorkspaceInfo> {
        self.with_workspace(workspace_id, |workspace| WorkspaceInfo {
            name: workspace.name.clone(),
            cwd: workspace.cwd.clone(),
        })
    }

    pub fn workspace_terminals(&self, workspace_id: &str) -> Vec<String> {
        self.with_workspace(workspace_id, |workspace| {
            workspace
                .terminals
                .iter()
                .map(|terminal| terminal.id.clone())
                .collect()
        })
        .unwrap_or_default()
    }

    fn emit(&self, event: &str, payload: serde_json::Value) {
        let _ = self.app.emit(event, payload);
    }

    pub fn issue(&self, identity: AgentIdentity) -> Result<String, getrandom::Error> {
        self.tokens.lock_or_recover().issue(identity)
    }

    pub fn identify(&self, token: &str) -> Option<AgentIdentity> {
        self.tokens.lock_or_recover().identify(token)
    }

    pub fn revoke_token(&self, token: &str) {
        let gone = self.tokens.lock_or_recover().revoke_token(token);
        if let Some(identity) = gone {
            self.forget_agent(&identity);
        }
    }

    #[cfg(test)]
    pub fn revoke_terminal(&self, terminal_id: &str) {
        let gone = self.tokens.lock_or_recover().revoke_terminal(terminal_id);
        if let Some(identity) = gone {
            self.forget_agent(&identity);
        }
    }

    pub fn peers(&self, workspace_id: &str) -> Vec<AgentIdentity> {
        self.tokens.lock_or_recover().peers(workspace_id)
    }

    fn forget_agent(&self, identity: &AgentIdentity) {
        if let Ok(mut statuses) = self.statuses() {
            statuses.forget_status(&identity.terminal_id);
        }
        self.emit(
            EVENT_AGENT_STATUS,
            serde_json::json!({
                "workspace_id": identity.workspace_id,
                "terminal_id": identity.terminal_id,
                "status": null,
            }),
        );
    }

    pub fn purge_workspace(&self, workspace_id: &str) {
        self.tokens.lock_or_recover().revoke_workspace(workspace_id);
        match self.repo() {
            Ok(mut repo) => {
                if let Err(error) = repo.purge_workspace(workspace_id) {
                    eprintln!("failed to purge MCP data of {}: {:?}", workspace_id, error);
                }
            }
            Err(_) => return,
        }
        self.statuses
            .lock_or_recover()
            .forget_workspace(workspace_id);
        self.emit_tasks_changed(workspace_id);
    }

    pub fn emit_tasks_changed(&self, workspace_id: &str) {
        self.emit(
            EVENT_TASKS_CHANGED,
            serde_json::json!({ "workspace_id": workspace_id }),
        );
    }

    pub fn set_session_log(&self, terminal_id: &str, log: crate::usage::SessionLog) {
        self.session_logs
            .lock_or_recover()
            .insert(terminal_id.to_string(), log);
    }

    pub fn session_log(&self, terminal_id: &str) -> Option<crate::usage::SessionLog> {
        self.session_logs
            .lock_or_recover()
            .get(terminal_id)
            .cloned()
    }

    pub fn emit_nudge(&self, workspace_id: &str, terminal_id: &str, prompt: &str) {
        self.emit(
            EVENT_NUDGE,
            serde_json::json!({ "workspace_id": workspace_id, "terminal_id": terminal_id, "prompt": prompt }),
        );
    }

    pub fn emit_message(&self, message: &Message) {
        self.emit(
            EVENT_MESSAGE,
            serde_json::to_value(message).unwrap_or_else(|error| {
                eprintln!("cannot serialize message {}: {}", message.id, error);
                serde_json::Value::Null
            }),
        );
    }

    pub fn emit_attention(&self, status: &AgentStatus) {
        let workspace = self.workspace(&status.workspace_id);
        self.emit(
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
        self.emit(
            EVENT_AGENT_STATUS,
            serde_json::json!({
                "workspace_id": status.workspace_id,
                "terminal_id": status.terminal_id,
                "status": status,
            }),
        );
    }
}

#[cfg(test)]
pub mod test_support {
    use super::*;
    use std::sync::Arc;

    use tauri::test::{mock_app, MockRuntime};
    use tauri::Listener;

    pub type Events = Arc<Mutex<Vec<(String, serde_json::Value)>>>;

    const RECORDED_EVENTS: [&str; 5] = [
        EVENT_TASKS_CHANGED,
        EVENT_MESSAGE,
        EVENT_AGENT_STATUS,
        EVENT_NUDGE,
        hooks::EVENT_AGENT_ATTENTION,
    ];
    const WORKSPACE_IDS: [&str; 2] = ["ws-1", "ws-2"];

    fn workspace(workspace_id: &str) -> Workspace {
        serde_json::from_value(serde_json::json!({
            "id": workspace_id,
            "name": format!("{} project", workspace_id),
            "cwd": format!("/tmp/{}", workspace_id),
        }))
        .unwrap()
    }

    pub fn app() -> AppHandle<MockRuntime> {
        let app = mock_app();
        app.manage(Mutex::new(WorkspaceStore {
            workspaces: WORKSPACE_IDS.map(workspace).to_vec(),
            ..WorkspaceStore::default()
        }));
        app.handle().clone()
    }

    fn record_events(app: &AppHandle<MockRuntime>) -> Events {
        let events = Events::default();
        for event in RECORDED_EVENTS {
            let sink = Arc::clone(&events);
            app.listen_any(event, move |emitted| {
                let payload = serde_json::from_str(emitted.payload()).unwrap();
                sink.lock().unwrap().push((event.to_string(), payload));
            });
        }
        events
    }

    pub fn hub() -> (Arc<McpHub<MockRuntime>>, Events) {
        let app = app();
        let events = record_events(&app);
        (
            Arc::new(McpHub::with_repo(Repo::in_memory(), None, app)),
            events,
        )
    }

    pub fn actor<'a>(workspace_id: &'a str, name: &'a str) -> model::Actor<'a> {
        model::Actor { workspace_id, name }
    }

    pub fn identity(terminal_id: &str, workspace_id: &str, agent: &str) -> AgentIdentity {
        AgentIdentity {
            terminal_id: terminal_id.into(),
            workspace_id: workspace_id.into(),
            agent: agent.into(),
            role: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use std::sync::Arc;

    #[test]
    fn given_two_leases_when_dropping_one_then_only_its_token_is_revoked() {
        let (hub, events) = hub();
        let token = hub.issue(identity("t-1", "ws-1", "claude")).unwrap();
        let lease = McpLease::new(&hub, token.clone());
        let newer = hub.issue(identity("t-1", "ws-1", "claude")).unwrap();
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
    fn given_a_workspace_with_agents_when_purging_it_then_tokens_are_revoked_and_data_cleared() {
        let (hub, events) = hub();
        let token = hub.issue(identity("t-1", "ws-1", "claude")).unwrap();
        tasks::create(
            &mut hub.repo().unwrap(),
            &actor("ws-1", "t-1"),
            model::NewTask {
                title: "x".into(),
                ..Default::default()
            },
        )
        .unwrap();
        hub.statuses()
            .unwrap()
            .report_status(
                &actor("ws-1", "t-1"),
                &statuses::StatusReport {
                    state: model::AgentState::Working,
                    summary: "",
                },
            )
            .unwrap();
        hub.purge_workspace("ws-1");
        assert!(hub.identify(&token).is_none());
        assert!(hub.statuses().unwrap().statuses("ws-1").is_empty());
        assert!(hub
            .repo()
            .unwrap()
            .queries()
            .list_tasks(&repo::TaskQuery::all("ws-1"))
            .unwrap()
            .is_empty());
        assert!(events
            .lock()
            .unwrap()
            .iter()
            .any(|(event, payload)| event == EVENT_TASKS_CHANGED
                && payload["workspace_id"] == "ws-1"));
    }

    #[test]
    fn given_an_unreadable_database_when_starting_then_the_server_is_off() {
        let dir =
            std::env::temp_dir().join(format!("terra-mcp-hub-{}", crate::clock::now_millis()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(db::DB_FILE);
        std::fs::write(&path, b"this is not a sqlite database, not even close").unwrap();
        let hub = Arc::new(McpHub::open(path.clone(), None, app()));
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
            .launch(connect::LaunchRequest {
                terminal_id: "t-1",
                workspace_id: "ws-1",
                command: "claude",
                role: None,
                quoting: launch::Quoting::Posix,
            })
            .is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}
