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

use super::repo::AgentState;
use super::{AgentIdentity, McpHub};
use crate::usage::SessionLog;

pub const HOOKS_PATH: &str = "/hooks";
pub const EVENT_AGENT_ATTENTION: &str = "agent-attention";
const MAX_HOOK_BODY: usize = 256 * 1024;
const MAX_SUMMARY_CHARS: usize = 200;

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

/// What a hook event says about the agent: its new state and a one-line
/// summary. `None` for events that carry no state change.
pub fn interpret(call: &HookCall) -> Option<(AgentState, String)> {
    let payload = &call.payload;
    match (call.agent.as_str(), call.event.as_str()) {
        ("claude", "UserPromptSubmit") => Some((
            AgentState::Working,
            text_field(payload, &["prompt"]).unwrap_or_default(),
        )),
        ("claude", "PreToolUse") => Some((
            AgentState::Working,
            text_field(payload, &["tool_name"]).unwrap_or_default(),
        )),
        ("claude", "Notification") => {
            let message = text_field(payload, &["message"]).unwrap_or_default();
            // `idle_prompt` only means the turn ended a minute ago; it is not
            // a question, and treating it as one would keep the orchestrator
            // from waking an agent that finished. Older versions send no type.
            match payload.get("notification_type").and_then(Value::as_str) {
                None
                | Some("permission_prompt")
                | Some("elicitation_dialog")
                | Some("elicitation_url_dialog")
                | Some("agent_needs_input") => Some((AgentState::NeedsInput, message)),
                Some("idle_prompt") => Some((AgentState::Idle, String::new())),
                Some(_) => None,
            }
        }
        ("claude", "Stop") | ("claude", "SessionStart") => Some((AgentState::Idle, String::new())),
        ("codex", _) => match payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or(call.event.as_str())
        {
            "agent-turn-complete" => Some((
                AgentState::Idle,
                text_field(
                    payload,
                    &["last-assistant-message", "last_assistant_message"],
                )
                .unwrap_or_default(),
            )),
            _ => None,
        },
        _ => None,
    }
}

/// The session log a hook event points at, for token usage.
pub fn session_log(call: &HookCall) -> Option<SessionLog> {
    match call.agent.as_str() {
        "claude" => call
            .payload
            .get("transcript_path")
            .and_then(Value::as_str)
            .and_then(crate::usage::claude_transcript_from_hook)
            .map(SessionLog::Claude),
        "codex" => call
            .payload
            .get("thread-id")
            .or_else(|| call.payload.get("thread_id"))
            .and_then(Value::as_str)
            .filter(|thread| !thread.is_empty())
            .map(|thread| SessionLog::Codex(thread.to_string())),
        _ => None,
    }
}

/// Apply a hook call for `who`. Returns the state it set, if any.
pub fn apply(hub: &McpHub, who: &AgentIdentity, call: &HookCall) -> Option<AgentState> {
    if let Some(log) = session_log(call) {
        hub.set_session_log(&who.terminal_id, log);
    }
    let (state, summary) = interpret(call)?;
    let status = hub
        .repo()
        .ok()?
        .report_status(&who.workspace_id, &who.terminal_id, state, &summary)
        .ok()?;
    hub.emit_agent_status(&status);
    if state == AgentState::NeedsInput {
        hub.emit_attention(&status);
    }
    Some(state)
}

/// `POST /hooks`: `terra-swarm hook` sends `{ agent, event, payload }`.
pub async fn handle(State(hub): State<Arc<McpHub>>, request: Request) -> Response {
    receive(hub, request, |body| {
        serde_json::from_slice::<HookCall>(body).ok()
    })
    .await
}

/// `POST /hooks/claude`: a Claude Code HTTP hook posts its event JSON as is.
pub async fn handle_claude(State(hub): State<Arc<McpHub>>, request: Request) -> Response {
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
async fn receive(
    hub: Arc<McpHub>,
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
    let _ = tokio::task::spawn_blocking(move || apply(&hub, &who, &call)).await;
    // An empty body: a Claude hook reads its response as hook output, and an
    // empty one changes nothing about what the agent does.
    StatusCode::OK.into_response()
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{hub, identity};
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
        assert_eq!(log, Some(SessionLog::Codex("0199-abc".into())));
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
        let status = hub.repo().unwrap().status_of("t-1").cloned().unwrap();
        assert_eq!(status.summary, "Approve?");
        let events = events.lock().unwrap();
        assert!(events.iter().any(|(event, _)| event == EVENT_AGENT_STATUS));
        assert!(events
            .iter()
            .any(|(event, payload)| event == EVENT_AGENT_ATTENTION
                && payload["terminal_id"] == "t-1"));
    }
}
