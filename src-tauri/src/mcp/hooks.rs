use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, Request, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Runtime;

use super::integration;
use super::model::AgentState;
use super::statuses::StatusReport;
use super::{AgentIdentity, McpHub};
use crate::usage::SessionLog;

pub const HOOKS_PATH: &str = "/hooks";
pub const INTEGRATION_HOOKS_PATH: &str = "/hooks/{integration}";
pub const EVENT_AGENT_ATTENTION: &str = "agent-attention";
const MAX_HOOK_BODY: usize = 256 * 1024;

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
pub struct HookCall {
    pub agent: String,
    pub event: String,
    #[serde(default)]
    pub payload: Value,
}

pub fn interpret(call: &HookCall) -> Option<(AgentState, String)> {
    integration::by_id(&call.agent)?.interpret(&call.event, &call.payload)
}

pub fn session_log(call: &HookCall) -> Option<SessionLog> {
    integration::by_id(&call.agent)?.session_log(&call.payload)
}

pub fn apply<R: Runtime>(hub: &McpHub<R>, who: &AgentIdentity, call: &HookCall) {
    if let Some(log) = session_log(call) {
        hub.set_session_log(&who.terminal_id, log);
    }
    let Some((state, summary)) = interpret(call) else {
        return;
    };
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
                "cannot record the state hook of {}: {:?}",
                who.terminal_id, error
            );
            return;
        }
    };
    hub.emit_agent_status(&status);
    if state == AgentState::NeedsInput {
        hub.emit_attention(&status);
    }
}

pub async fn handle<R: Runtime>(State(hub): State<Arc<McpHub<R>>>, request: Request) -> Response {
    receive(hub, request, |body| {
        serde_json::from_slice::<HookCall>(body).ok()
    })
    .await
}

pub async fn handle_integration<R: Runtime>(
    State(hub): State<Arc<McpHub<R>>>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    let Some(integration) = integration::by_id(&id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !integration.has_http_hooks() {
        return StatusCode::NOT_FOUND.into_response();
    }
    receive(hub, request, |body| {
        let payload: Value = serde_json::from_slice(body).ok()?;
        let event = integration.http_hook_event(&payload)?;
        Some(HookCall {
            agent: integration.id().into(),
            event,
            payload,
        })
    })
    .await
}

async fn receive<R: Runtime>(
    hub: Arc<McpHub<R>>,
    request: Request,
    parse: impl FnOnce(&[u8]) -> Option<HookCall>,
) -> Response {
    let is_from_browser_page = request.headers().contains_key(header::ORIGIN);
    if is_from_browser_page {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(who) = request.extensions().get::<AgentIdentity>().cloned() else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let body = match read_body(request.into_body()).await {
        Ok(body) => body,
        Err(status) => return status.into_response(),
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
    StatusCode::OK.into_response()
}

async fn read_body(body: Body) -> Result<Vec<u8>, StatusCode> {
    let mut chunks = body.into_data_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk.map_err(|error| {
            eprintln!("cannot read a hook body: {}", error);
            StatusCode::BAD_REQUEST
        })?;
        if bytes.len() + chunk.len() > MAX_HOOK_BODY {
            return Err(StatusCode::PAYLOAD_TOO_LARGE);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::super::integration::MAX_SUMMARY_CHARS;
    use super::super::test_support::{app, hub, identity};
    use super::super::EVENT_AGENT_STATUS;
    use super::*;
    use crate::sync::LockExt;
    use serde_json::json;

    fn call(agent: &str, event: &str, payload: Value) -> HookCall {
        HookCall {
            agent: agent.into(),
            event: event.into(),
            payload,
        }
    }

    #[test]
    fn given_claude_hook_events_when_interpreting_then_they_map_to_states() {
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
    fn given_a_codex_turn_complete_when_interpreting_then_the_agent_is_idle() {
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
    fn given_a_codex_hook_when_reading_its_session_log_then_it_names_its_session() {
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
    fn given_a_long_message_when_interpreting_then_the_summary_is_cut() {
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
    fn given_a_hook_when_applying_it_then_the_status_is_updated_and_attention_raised() {
        let (hub, events) = hub();
        let who = identity("t-1", "ws-1", "claude");
        apply(
            &hub,
            &who,
            &call("claude", "Notification", json!({ "message": "Approve?" })),
        );
        let status = hub.statuses().unwrap().status_of("t-1").cloned().unwrap();
        assert_eq!(status.state, AgentState::NeedsInput);
        assert_eq!(status.summary, "Approve?");
        let events = events.lock().unwrap();
        assert!(events.iter().any(|(event, _)| event == EVENT_AGENT_STATUS));
        assert!(events
            .iter()
            .any(|(event, payload)| event == EVENT_AGENT_ATTENTION
                && payload["terminal_id"] == "t-1"));
    }

    #[test]
    fn given_an_unavailable_database_when_applying_a_hook_then_no_state_is_recorded() {
        let dir =
            std::env::temp_dir().join(format!("terra-mcp-hook-{}", crate::clock::now_millis()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(super::super::db::DB_FILE);
        std::fs::write(&path, b"not a sqlite database").unwrap();
        let hub = McpHub::open(path, None, app());
        apply(
            &hub,
            &identity("t-1", "ws-1", "claude"),
            &call("claude", "Stop", json!({})),
        );
        assert!(hub.statuses.lock_or_recover().status_of("t-1").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    fn hook_request(body: axum::body::Body) -> Request {
        let mut request = Request::new(body);
        request
            .extensions_mut()
            .insert(identity("t-1", "ws-1", "claude"));
        request
    }

    fn receive_status(request: Request) -> StatusCode {
        let (hub, _) = hub();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let response = runtime.block_on(receive(hub, request, |body| {
            serde_json::from_slice::<HookCall>(body).ok()
        }));
        response.status()
    }

    #[test]
    fn given_a_body_that_breaks_off_when_receiving_a_hook_then_it_answers_400() {
        let chunks: Vec<Result<&'static str, std::io::Error>> = vec![
            Ok("{\"agent\":"),
            Err(std::io::Error::other("connection reset")),
        ];
        let body = axum::body::Body::from_stream(futures_util::stream::iter(chunks));

        assert_eq!(receive_status(hook_request(body)), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn given_a_body_over_the_limit_when_receiving_a_hook_then_it_answers_413() {
        let body = axum::body::Body::from(vec![b' '; MAX_HOOK_BODY + 1]);

        assert_eq!(
            receive_status(hook_request(body)),
            StatusCode::PAYLOAD_TOO_LARGE
        );
    }
}
