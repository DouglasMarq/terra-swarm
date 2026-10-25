//! Agent lifecycle hooks. Agent CLIs call `terra-swarm hook <agent> <event>`
//! (see `crate::cli`), which posts here with the terminal's token, so the
//! board knows whether an agent is working, idle or waiting for a human
//! without the agent having to call `report_status` itself.

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Runtime;

use super::integration;
use super::model::AgentState;
use super::statuses::StatusReport;
use super::{AgentIdentity, McpHub};
use crate::usage::SessionLog;

pub const HOOKS_PATH: &str = "/hooks";
/// Where a Claude Code HTTP hook posts its raw event JSON.
pub const CLAUDE_HOOKS_PATH: &str = "/hooks/claude";
pub const EVENT_AGENT_ATTENTION: &str = "agent-attention";
const MAX_HOOK_BODY: usize = 256 * 1024;

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
pub struct HookCall {
    /// Which CLI sent it ("claude", "codex").
    pub agent: String,
    /// The CLI's event name ("Stop", "Notification", "agent-turn-complete"…).
    pub event: String,
    /// Whatever the CLI passed along, as JSON.
    #[serde(default)]
    pub payload: Value,
}

/// What a hook event says about the agent: its new state and a one-line
/// summary. `None` for events that carry no state change.
pub fn interpret(call: &HookCall) -> Option<(AgentState, String)> {
    integration::by_id(&call.agent)?.interpret(&call.event, &call.payload)
}

/// The session log a hook event points at, for token usage.
pub fn session_log(call: &HookCall) -> Option<SessionLog> {
    integration::by_id(&call.agent)?.session_log(&call.payload)
}

/// Apply a hook call for `who`. Returns the state it set, if any.
pub fn apply<R: Runtime>(
    hub: &McpHub<R>,
    who: &AgentIdentity,
    call: &HookCall,
) -> Option<AgentState> {
    if let Some(log) = session_log(call) {
        hub.set_session_log(&who.terminal_id, log);
    }
    let (state, summary) = interpret(call)?;
    let reported = hub.statuses().and_then(|mut statuses| {
        statuses.report_status(
            &who.actor(),
            &StatusReport {
                state,
                summary: &summary,
            },
        )
    });
    let status = match reported {
        Ok(status) => status,
        Err(error) => {
            eprintln!(
                "cannot record the state hook of {}: {}",
                who.terminal_id, error
            );
            return None;
        }
    };
    hub.emit_agent_status(&status);
    if state == AgentState::NeedsInput {
        hub.emit_attention(&status);
    }
    Some(state)
}

/// `POST /hooks`: `terra-swarm hook` sends `{ agent, event, payload }`.
pub async fn handle<R: Runtime>(State(hub): State<Arc<McpHub<R>>>, request: Request) -> Response {
    receive(hub, request, |body| {
        serde_json::from_slice::<HookCall>(body).ok()
    })
    .await
}

/// `POST /hooks/claude`: a Claude Code HTTP hook posts its event JSON as is.
pub async fn handle_claude<R: Runtime>(
    State(hub): State<Arc<McpHub<R>>>,
    request: Request,
) -> Response {
    receive(hub, request, |body| {
        let payload: Value = serde_json::from_slice(body).ok()?;
        let event = payload.get("hook_event_name")?.as_str()?.to_string();
        Some(HookCall {
            agent: "claude".into(),
            event,
            payload,
        })
    })
    .await
}

/// Both routes sit behind the same token check as the MCP endpoint.
async fn receive<R: Runtime>(
    hub: Arc<McpHub<R>>,
    request: Request,
    parse: impl FnOnce(&[u8]) -> Option<HookCall>,
) -> Response {
    // Hooks come from CLIs, never from a browser page.
    if request.headers().contains_key(header::ORIGIN) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(who) = request.extensions().get::<AgentIdentity>().cloned() else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let Ok(body) = axum::body::to_bytes(request.into_body(), MAX_HOOK_BODY).await else {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    };
    let Some(call) = parse(&body) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    if let Err(error) = tokio::task::spawn_blocking(move || apply(&hub, &who, &call)).await {
        let reason = if error.is_panic() {
            "panicked"
        } else {
            "was cancelled"
        };
        eprintln!("a hook handler {}", reason);
    }
    // An empty body: a Claude hook reads its response as hook output, and an
    // empty one changes nothing about what the agent does.
    StatusCode::OK.into_response()
}

#[cfg(test)]
mod tests {
    use super::super::integration::MAX_SUMMARY_CHARS;
    use super::super::test_support::{app, hub, identity};
    use super::super::EVENT_AGENT_STATUS;
    use super::*;
    use serde_json::json;

    fn call(agent: &str, event: &str, payload: Value) -> HookCall {
        HookCall {
            agent: agent.into(),
            event: event.into(),
            payload,
        }
    }

    #[test]
    fn claude_events_map_to_states() {
        assert_eq!(
            interpret(&call(
                "claude",
                "UserPromptSubmit",
                json!({ "prompt": "fix   the\nbug" })
            )),
            Some((AgentState::Working, "fix the bug".into()))
        );
        assert_eq!(
            interpret(&call(
                "claude",
                "PreToolUse",
                json!({ "tool_name": "Bash" })
            )),
            Some((AgentState::Working, "Bash".into()))
        );
        assert_eq!(
            interpret(&call(
                "claude",
                "Notification",
                json!({ "message": "Claude needs your permission to use Bash" })
            )),
            Some((
                AgentState::NeedsInput,
                "Claude needs your permission to use Bash".into()
            ))
        );
        assert_eq!(
            interpret(&call(
                "claude",
                "Notification",
                json!({ "notification_type": "permission_prompt", "message": "Allow Bash?" })
            )),
            Some((AgentState::NeedsInput, "Allow Bash?".into()))
        );
        // Finishing a turn and sitting quietly is not "needs you".
        assert_eq!(
            interpret(&call(
                "claude",
                "Notification",
                json!({ "notification_type": "idle_prompt", "message": "Claude is waiting for your input" })
            )),
            Some((AgentState::Idle, String::new()))
        );
        assert_eq!(
            interpret(&call(
                "claude",
                "Notification",
                json!({ "notification_type": "auth_success" })
            )),
            None
        );
        assert_eq!(
            interpret(&call("claude", "Stop", json!({}))),
            Some((AgentState::Idle, String::new()))
        );
        assert_eq!(interpret(&call("claude", "PostToolUse", json!({}))), None);
        assert_eq!(interpret(&call("opencode", "Stop", json!({}))), None);
    }

    #[test]
    fn codex_turn_complete_means_idle() {
        let (state, summary) = interpret(&call(
            "codex",
            "notify",
            json!({ "type": "agent-turn-complete", "last-assistant-message": "Done. Tests pass." }),
        ))
        .unwrap();
        assert_eq!(state, AgentState::Idle);
        assert_eq!(summary, "Done. Tests pass.");
        assert_eq!(
            interpret(&call("codex", "notify", json!({ "type": "other" }))),
            None
        );
    }

    #[test]
    fn codex_hooks_name_their_session() {
        let log = session_log(&call(
            "codex",
            "notify",
            json!({ "type": "agent-turn-complete", "thread-id": "0199-abc" }),
        ));
        assert_eq!(
            log,
            Some(SessionLog {
                integration: "codex",
                locator: "0199-abc".into()
            })
        );
        // A Claude transcript outside Claude's own folder is ignored.
        assert_eq!(
            session_log(&call(
                "claude",
                "Stop",
                json!({ "transcript_path": "/etc/passwd" })
            )),
            None
        );
    }

    #[test]
    fn long_summaries_are_cut() {
        let (_, summary) = interpret(&call(
            "claude",
            "Notification",
            json!({ "message": "x".repeat(500) }),
        ))
        .unwrap();
        assert_eq!(summary.chars().count(), MAX_SUMMARY_CHARS);
        assert!(summary.ends_with('…'));
    }

    #[test]
    fn applying_a_hook_updates_status_and_raises_attention() {
        let (hub, events) = hub();
        let who = identity("t-1", "ws-1", "claude");
        let state = apply(
            &hub,
            &who,
            &call("claude", "Notification", json!({ "message": "Approve?" })),
        );
        assert_eq!(state, Some(AgentState::NeedsInput));
        let status = hub.statuses().unwrap().status_of("t-1").cloned().unwrap();
        assert_eq!(status.summary, "Approve?");
        let events = events.lock().unwrap();
        assert!(events.iter().any(|(event, _)| event == EVENT_AGENT_STATUS));
        assert!(events
            .iter()
            .any(|(event, payload)| event == EVENT_AGENT_ATTENTION
                && payload["terminal_id"] == "t-1"));
    }

    #[test]
    fn given_an_unavailable_database_a_hook_records_no_state() {
        let dir =
            std::env::temp_dir().join(format!("terra-mcp-hook-{}", crate::clock::now_millis()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(super::super::db::DB_FILE);
        std::fs::write(&path, b"not a sqlite database").unwrap();
        let hub = McpHub::open(path, None, app());
        let state = apply(
            &hub,
            &identity("t-1", "ws-1", "claude"),
            &call("claude", "Stop", json!({})),
        );
        assert_eq!(state, None);
        let _ = std::fs::remove_dir_all(dir);
    }
}
