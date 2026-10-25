//! Tauri commands behind the Tasks panel and the Settings toggle. They use
//! the same `repo` as the MCP tools, log changes as the human ("user") and
//! emit the same events, so every window refreshes the same way.

use serde::{Deserialize, Deserializer};
use std::sync::Arc;
use tauri::State;

use super::model::{Actor, AgentStatus, NewTask, Task, TaskPatch, TaskPriority, TaskStatus};
use super::tasks::{self, TaskUpdate};
use super::{McpHub, ServerInfo};

pub const USER_ACTOR: &str = "user";
/// History shown on each card of the Tasks panel.
const PANEL_EVENTS: usize = 20;

type Hub<'a> = State<'a, Arc<McpHub>>;

fn user(workspace_id: &str) -> Actor<'_> {
    Actor {
        workspace_id,
        name: USER_ACTOR,
    }
}

/// Tells "field absent" (`None`) apart from "field is null" (`Some(None)`).
fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Deserialize, Default)]
pub struct TaskPatchInput {
    pub title: Option<String>,
    pub description: Option<String>,
    pub status: Option<TaskStatus>,
    pub priority: Option<TaskPriority>,
    #[serde(default, deserialize_with = "double_option")]
    pub assignee: Option<Option<String>>,
    pub position: Option<f64>,
    pub note: Option<String>,
}

#[tauri::command(async)]
pub fn mcp_server_info(hub: Hub<'_>) -> ServerInfo {
    hub.info()
}

/// Turn the injection on or off. Running terminals keep their connection;
/// the setting applies to terminals started afterwards.
#[tauri::command(async)]
pub fn mcp_set_enabled(hub: Hub<'_>, enabled: bool) -> Result<ServerInfo, String> {
    hub.repo()
        .and_then(|repo| repo.set_enabled(enabled))
        .map_err(|e| e.to_string())?;
    Ok(hub.info())
}

#[tauri::command(async)]
pub fn mcp_list_tasks(hub: Hub<'_>, workspace_id: String) -> Result<Vec<Task>, String> {
    hub.repo()
        .and_then(|repo| {
            repo.queries()
                .list_tasks(&workspace_id, None, None, Some(PANEL_EVENTS))
        })
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn mcp_create_task(
    hub: Hub<'_>,
    workspace_id: String,
    title: String,
    description: Option<String>,
    priority: Option<TaskPriority>,
    assignee: Option<String>,
) -> Result<Task, String> {
    let task = hub
        .repo()
        .and_then(|mut repo| {
            tasks::create(
                &mut repo,
                &user(&workspace_id),
                NewTask {
                    title,
                    description,
                    priority,
                    assignee,
                    ..NewTask::default()
                },
            )
        })
        .map_err(|e| e.to_string())?;
    hub.emit_tasks_changed(&workspace_id);
    Ok(task)
}

#[tauri::command(async)]
pub fn mcp_update_task(
    hub: Hub<'_>,
    workspace_id: String,
    id: String,
    patch: TaskPatchInput,
) -> Result<Task, String> {
    let task = hub
        .repo()
        .and_then(|mut repo| {
            tasks::update(
                &mut repo,
                &user(&workspace_id),
                TaskUpdate {
                    id: &id,
                    patch: TaskPatch {
                        title: patch.title,
                        description: patch.description,
                        status: patch.status,
                        priority: patch.priority,
                        assignee: patch.assignee,
                        position: patch.position,
                        note: patch.note,
                    },
                },
            )
        })
        .map_err(|e| e.to_string())?;
    hub.emit_tasks_changed(&workspace_id);
    Ok(task)
}

#[tauri::command(async)]
pub fn mcp_delete_task(hub: Hub<'_>, workspace_id: String, id: String) -> Result<(), String> {
    hub.repo()
        .and_then(|repo| tasks::delete(&repo, &workspace_id, &id))
        .map_err(|e| e.to_string())?;
    hub.emit_tasks_changed(&workspace_id);
    Ok(())
}

#[tauri::command(async)]
pub fn mcp_agent_statuses(hub: Hub<'_>, workspace_id: String) -> Vec<AgentStatus> {
    hub.statuses()
        .map(|statuses| statuses.statuses(&workspace_id))
        .unwrap_or_else(|error| {
            eprintln!("cannot list agent statuses: {}", error);
            Vec::new()
        })
}

/// Tokens used by each agent of the workspace whose session log is known
/// (reported by its hooks), read from the agent CLI's own log files.
#[tauri::command(async)]
pub fn agent_usage(hub: Hub<'_>, workspace_id: String) -> Vec<crate::usage::AgentUsage> {
    hub.workspace_terminals(&workspace_id)
        .into_iter()
        .filter_map(|terminal_id| {
            let log = hub.session_log(&terminal_id)?;
            let usage = super::integration::usage_of(&log)?;
            Some(crate::usage::AgentUsage {
                terminal_id,
                agent: log.integration.into(),
                usage,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patch_distinguishes_missing_and_null_assignee() {
        let missing: TaskPatchInput =
            serde_json::from_str(r#"{"status":"done","position":2.5}"#).unwrap();
        assert_eq!(missing.assignee, None);
        assert_eq!(missing.status, Some(TaskStatus::Done));
        assert_eq!(missing.position, Some(2.5));
        let cleared: TaskPatchInput = serde_json::from_str(r#"{"assignee":null}"#).unwrap();
        assert_eq!(cleared.assignee, Some(None));
        let set: TaskPatchInput =
            serde_json::from_str(r#"{"assignee":"t-2","priority":"urgent"}"#).unwrap();
        assert_eq!(set.assignee, Some(Some("t-2".into())));
        assert_eq!(set.priority, Some(TaskPriority::Urgent));
    }
}
