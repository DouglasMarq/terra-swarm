use serde::{Deserialize, Deserializer};
use std::sync::Arc;
use tauri::State;

use super::model::{Actor, AgentStatus, NewTask, Task, TaskPatch, TaskPriority, TaskStatus};
use super::repo::TaskQuery;
use super::tasks::{self, TaskUpdate};
use super::{McpHub, ServerInfo};

pub const USER_ACTOR: &str = "user";
const PANEL_EVENTS: usize = 20;
const COMMAND_FAILED: &str = "MCP command failed";
const MAX_BOARD_TASKS: usize = 500;

type Hub<'a> = State<'a, Arc<McpHub>>;

fn user(workspace_id: &str) -> Actor<'_> {
    Actor {
        workspace_id,
        name: USER_ACTOR,
    }
}

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

#[tauri::command(async)]
pub fn mcp_set_enabled(hub: Hub<'_>, is_enabled: bool) -> Result<ServerInfo, String> {
    hub.repo()
        .and_then(|repo| repo.set_enabled(is_enabled))
        .inspect_err(|error| error.log_internal(COMMAND_FAILED))
        .map_err(|error| error.to_string())?;
    Ok(hub.info())
}

#[tauri::command(async)]
pub fn mcp_list_tasks(hub: Hub<'_>, workspace_id: String) -> Result<Vec<Task>, String> {
    hub.repo()
        .and_then(|repo| {
            repo.queries().list_tasks(&TaskQuery {
                events: Some(PANEL_EVENTS),
                limit: MAX_BOARD_TASKS,
                ..TaskQuery::all(&workspace_id)
            })
        })
        .inspect_err(|error| error.log_internal(COMMAND_FAILED))
        .map_err(|error| error.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewTaskRequest {
    pub workspace_id: String,
    pub title: String,
    pub description: Option<String>,
    pub priority: Option<TaskPriority>,
    pub assignee: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskUpdateRequest {
    pub workspace_id: String,
    pub id: String,
    pub patch: TaskPatchInput,
}

#[tauri::command(async)]
pub fn mcp_create_task(hub: Hub<'_>, request: NewTaskRequest) -> Result<Task, String> {
    let workspace_id = request.workspace_id;
    let task = hub
        .repo()
        .and_then(|mut repo| {
            tasks::create(
                &mut repo,
                &user(&workspace_id),
                NewTask {
                    title: request.title,
                    description: request.description,
                    priority: request.priority,
                    assignee: request.assignee,
                    ..NewTask::default()
                },
            )
        })
        .inspect_err(|error| error.log_internal(COMMAND_FAILED))
        .map_err(|error| error.to_string())?;
    hub.emit_tasks_changed(&workspace_id);
    Ok(task)
}

#[tauri::command(async)]
pub fn mcp_update_task(hub: Hub<'_>, request: TaskUpdateRequest) -> Result<Task, String> {
    let TaskUpdateRequest {
        workspace_id,
        id,
        patch,
    } = request;
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
        .inspect_err(|error| error.log_internal(COMMAND_FAILED))
        .map_err(|error| error.to_string())?;
    hub.emit_tasks_changed(&workspace_id);
    Ok(task)
}

#[tauri::command(async)]
pub fn mcp_delete_task(hub: Hub<'_>, workspace_id: String, id: String) -> Result<(), String> {
    hub.repo()
        .and_then(|repo| tasks::delete(&repo, &workspace_id, &id))
        .inspect_err(|error| error.log_internal(COMMAND_FAILED))
        .map_err(|error| error.to_string())?;
    hub.emit_tasks_changed(&workspace_id);
    Ok(())
}

#[tauri::command(async)]
pub fn mcp_agent_statuses(hub: Hub<'_>, workspace_id: String) -> Vec<AgentStatus> {
    hub.statuses()
        .map(|statuses| statuses.statuses(&workspace_id))
        .unwrap_or_else(|error| {
            eprintln!("cannot list agent statuses: {:?}", error);
            Vec::new()
        })
}

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
    fn given_a_patch_with_a_missing_or_null_assignee_when_parsing_then_the_two_are_distinguished() {
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
