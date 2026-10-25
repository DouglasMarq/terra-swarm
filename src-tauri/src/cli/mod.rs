//! Command-line entry points of the app binary, used by the agent CLIs that
//! run inside Terra Swarm terminals. They never open a window.
//!
//! - `terra-swarm hook <agent> <event> [payload-json]`: report an agent
//!   lifecycle event (Claude Code hooks, Codex `notify`) to the running app.
//!   Reads the payload from the last argument, else from stdin. Always exits
//!   0 and prints nothing, so it can never block or alter the agent.
//! - `terra-swarm mcp-stdio`: the Terra MCP server as a stdio server, for
//!   agents that only start MCP servers as subprocesses (see `stdio`).

mod stdio;

use std::io::{IsTerminal, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

const MAX_PAYLOAD_BYTES: u64 = 256 * 1024;
/// Only the status line of the hook route's answer is read.
const MAX_HOOK_RESPONSE_BYTES: u64 = 4096;
const TIMEOUT: Duration = Duration::from_secs(2);

/// Run a CLI subcommand when the arguments name one; `None` starts the app.
pub fn run(args: &[String]) -> Option<i32> {
    match args.get(1).map(String::as_str) {
        Some("hook") => {
            hook(&args[2..]);
            Some(0)
        }
        Some("mcp-stdio") => Some(stdio::run()),
        _ => None,
    }
}

fn hook(args: &[String]) {
    let (Some(agent), Some(event)) = (args.first(), args.get(1)) else {
        return;
    };
    let payload = match args.get(2) {
        Some(json) => serde_json::from_str(json).unwrap_or(serde_json::Value::Null),
        None => read_stdin_json(),
    };
    let (Ok(url), Ok(token)) = (
        std::env::var(crate::mcp::launch::ENV_URL),
        std::env::var(crate::mcp::launch::ENV_TOKEN),
    ) else {
        // Not started by Terra Swarm (or MCP is off): nothing to report.
        return;
    };
    let body =
        serde_json::json!({ "agent": agent, "event": event, "payload": payload }).to_string();
    if let Err(error) = post_hook(&url, &token, &body) {
        // stderr only: a failed report must not change what the agent does.
        eprintln!("terra-swarm hook: {}", error);
    }
}

fn read_stdin_json() -> serde_json::Value {
    let stdin = std::io::stdin();
    if stdin.is_terminal() {
        return serde_json::Value::Null;
    }
    let mut text = String::new();
    if stdin
        .lock()
        .take(MAX_PAYLOAD_BYTES)
        .read_to_string(&mut text)
        .is_err()
    {
        return serde_json::Value::Null;
    }
    serde_json::from_str(&text).unwrap_or(serde_json::Value::Null)
}

/// `http://127.0.0.1:<port>/mcp` → `127.0.0.1:<port>`. Only loopback HTTP
/// is accepted: the token must never travel anywhere else.
pub fn loopback_authority(url: &str) -> Option<String> {
    let rest = url.strip_prefix("http://")?;
    let authority = rest.split('/').next()?;
    let (host, port) = authority.rsplit_once(':')?;
    let port: u16 = port.parse().ok()?;
    matches!(host, "127.0.0.1" | "localhost").then(|| format!("127.0.0.1:{}", port))
}

fn post_hook(url: &str, token: &str, body: &str) -> Result<(), String> {
    let authority = loopback_authority(url).ok_or("TERRA_MCP_URL is not a loopback address")?;
    let address = authority
        .parse()
        .map_err(|error| format!("bad address {}: {}", authority, error))?;
    let mut stream =
        TcpStream::connect_timeout(&address, TIMEOUT).map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(TIMEOUT))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(TIMEOUT))
        .map_err(|error| error.to_string())?;
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n{body}",
        path = crate::mcp::hooks::HOOKS_PATH,
        host = authority,
        token = token,
        length = body.len(),
        body = body,
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| error.to_string())?;
    let mut response = String::new();
    let read = stream
        .take(MAX_HOOK_RESPONSE_BYTES)
        .read_to_string(&mut response);
    let status = response.split_whitespace().nth(1).unwrap_or("");
    match (status, read) {
        ("200", _) => Ok(()),
        ("", Err(error)) => Err(format!("could not read the server's answer: {}", error)),
        ("", Ok(_)) => Err("server answered nothing".to_string()),
        (status, _) => Err(format!("server answered {}", status)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::model::AgentState;
    use crate::mcp::test_support::{hub, identity};
    use std::sync::Arc;

    #[test]
    fn only_loopback_urls_are_used() {
        assert_eq!(
            loopback_authority("http://127.0.0.1:4100/mcp").as_deref(),
            Some("127.0.0.1:4100")
        );
        assert_eq!(
            loopback_authority("http://localhost:9/mcp").as_deref(),
            Some("127.0.0.1:9")
        );
        assert_eq!(loopback_authority("https://127.0.0.1:4100/mcp"), None);
        assert_eq!(loopback_authority("http://evil.example:4100/mcp"), None);
        assert_eq!(loopback_authority("http://127.0.0.1/mcp"), None);
    }

    #[test]
    fn non_cli_arguments_start_the_app() {
        assert_eq!(run(&["terra-swarm".to_string()]), None);
        assert_eq!(
            run(&["terra-swarm".to_string(), "--flag".to_string()]),
            None
        );
    }

    #[test]
    fn a_hook_post_reaches_the_server_and_sets_the_state() {
        let (hub, _) = hub();
        let token = hub.issue(identity("t-1", "ws-1", "claude"));
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        runtime.spawn(crate::mcp::server::serve(listener, Arc::clone(&hub)));
        let url = format!("http://127.0.0.1:{}/mcp", port);
        let body = serde_json::json!({ "agent": "claude", "event": "Notification", "payload": { "message": "Allow Bash?" } }).to_string();
        post_hook(&url, &token, &body).expect("hook accepted");
        let status = hub.statuses().unwrap().status_of("t-1").cloned().unwrap();
        assert_eq!(status.state, AgentState::NeedsInput);
        assert_eq!(status.summary, "Allow Bash?");
        // A wrong token is refused.
        assert!(post_hook(&url, "nope", &body).unwrap_err().contains("401"));
    }
}
