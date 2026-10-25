mod http;
mod stdio;

use std::io::{IsTerminal, Read};
use std::time::Duration;

const MAX_PAYLOAD_BYTES: u64 = 256 * 1024;
const MAX_HOOK_RESPONSE_BYTES: u64 = 4096;
const TIMEOUT: Duration = Duration::from_secs(2);

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
        return;
    };
    let body =
        serde_json::json!({ "agent": agent, "event": event, "payload": payload }).to_string();
    if let Err(error) = post_hook(&url, &token, &body) {
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

pub fn loopback_authority(url: &str) -> Option<String> {
    let rest = url.strip_prefix("http://")?;
    let authority = rest.split('/').next()?;
    let (host, port) = authority.rsplit_once(':')?;
    let port: u16 = port.parse().ok()?;
    matches!(host, "127.0.0.1" | "localhost").then(|| format!("127.0.0.1:{}", port))
}

fn post_hook(url: &str, token: &str, body: &str) -> Result<(), String> {
    let authority = loopback_authority(url).ok_or("TERRA_MCP_URL is not a loopback address")?;
    let post = http::Post {
        authority: &authority,
        path: crate::mcp::hooks::HOOKS_PATH,
        token,
        headers: &[],
        body,
    };
    let limits = http::Limits {
        connect_timeout: TIMEOUT,
        io_timeout: TIMEOUT,
        max_response_bytes: MAX_HOOK_RESPONSE_BYTES,
    };
    let raw = http::post(&post, &limits)?;
    let response = String::from_utf8_lossy(&raw.bytes);
    let status = response.split_whitespace().nth(1).unwrap_or("");
    match (status, raw.read) {
        (status, _) if status.parse() == Ok(http::HTTP_OK) => Ok(()),
        ("", Err(error)) => Err(format!("could not read the server's answer: {}", error)),
        ("", Ok(())) => Err("server answered nothing".to_string()),
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
        let token = hub.issue(identity("t-1", "ws-1", "claude")).unwrap();
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
        assert!(post_hook(&url, "nope", &body).unwrap_err().contains("401"));
    }
}
