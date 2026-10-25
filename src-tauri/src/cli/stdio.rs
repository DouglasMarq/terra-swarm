use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::time::Duration;

use super::{http, loopback_authority, TIMEOUT as CONNECT_TIMEOUT};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_RESPONSE_BYTES: u64 = 16 * 1024 * 1024;
const HEADER_END: &[u8] = b"\r\n\r\n";
const CRLF: &[u8] = b"\r\n";
const HEX_RADIX: u32 = 16;

const JSONRPC_PARSE_ERROR: i64 = -32700;
const JSONRPC_INTERNAL_ERROR: i64 = -32603;

pub struct Endpoint {
    authority: String,
    path: String,
    token: String,
    protocol_version: Option<String>,
}

impl Endpoint {
    pub fn new(url: &str, token: &str) -> Result<Self, String> {
        let authority = loopback_authority(url).ok_or("TERRA_MCP_URL is not a loopback address")?;
        let path = url
            .strip_prefix("http://")
            .and_then(|rest| rest.find('/').map(|slash| rest[slash..].to_string()))
            .unwrap_or_else(|| "/".into());
        Ok(Self {
            authority,
            path,
            token: token.into(),
            protocol_version: None,
        })
    }

    pub fn send(&self, message: &Value) -> Result<Vec<Value>, String> {
        let body = message.to_string();
        let mut headers = vec![("Accept", "application/json, text/event-stream")];
        if let Some(version) = self.protocol_version.as_deref() {
            headers.push(("MCP-Protocol-Version", version));
        }
        let post = http::Post {
            authority: &self.authority,
            path: &self.path,
            token: &self.token,
            headers: &headers,
            body: &body,
        };
        let limits = http::Limits {
            connect_timeout: CONNECT_TIMEOUT,
            io_timeout: REQUEST_TIMEOUT,
            max_response_bytes: MAX_RESPONSE_BYTES,
        };
        let response = http::post(&post, &limits)?;
        response.read?;
        let raw = response.bytes;
        let (status, headers, body) = split_response(&raw)?;
        if status == http::HTTP_ACCEPTED || (status == http::HTTP_OK && body.trim().is_empty()) {
            return Ok(Vec::new());
        }
        if status != http::HTTP_OK {
            return Err(format!(
                "the Terra MCP server answered {}: {}",
                status,
                body.trim()
            ));
        }
        parse_messages(&body, headers.contains("text/event-stream"))
    }

    pub fn remember_protocol_version(&mut self, replies: &[Value]) {
        for reply in replies {
            if let Some(version) = reply
                .pointer("/result/protocolVersion")
                .and_then(Value::as_str)
            {
                self.protocol_version = Some(version.to_string());
            }
        }
    }
}

fn split_response(raw: &[u8]) -> Result<(u16, String, String), String> {
    let end = raw
        .windows(HEADER_END.len())
        .position(|window| window == HEADER_END)
        .ok_or("incomplete HTTP response")?;
    let head = String::from_utf8_lossy(&raw[..end]).to_string();
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .ok_or("no HTTP status")?;
    let headers = head.to_lowercase();
    let mut body = raw[end + HEADER_END.len()..].to_vec();
    if headers.contains("transfer-encoding: chunked") {
        body = dechunk(&body);
    }
    Ok((status, headers, String::from_utf8_lossy(&body).to_string()))
}

fn dechunk(mut data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(line_end) = data.windows(CRLF.len()).position(|window| window == CRLF) {
        let size = usize::from_str_radix(
            String::from_utf8_lossy(&data[..line_end])
                .trim()
                .split(';')
                .next()
                .unwrap_or("0"),
            HEX_RADIX,
        )
        .unwrap_or(0);
        data = &data[line_end + CRLF.len()..];
        if size == 0 || data.len() < size {
            break;
        }
        out.extend_from_slice(&data[..size]);
        data = data.get(size + CRLF.len()..).unwrap_or(&[]);
    }
    out
}

fn parse_messages(body: &str, event_stream: bool) -> Result<Vec<Value>, String> {
    if !event_stream {
        return match serde_json::from_str::<Value>(body) {
            Ok(Value::Array(items)) => Ok(items),
            Ok(value) => Ok(vec![value]),
            Err(error) => Err(format!("the Terra MCP server sent invalid JSON: {}", error)),
        };
    }
    body.lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim)
        .filter(|data| !data.is_empty())
        .map(|data| {
            serde_json::from_str::<Value>(data)
                .map_err(|error| format!("the Terra MCP server sent invalid JSON: {}", error))
        })
        .collect()
}

pub fn bridge(
    endpoint: &mut Endpoint,
    input: impl BufRead,
    mut output: impl Write,
) -> std::io::Result<()> {
    for line in input.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let message: Value = match serde_json::from_str(&line) {
            Ok(message) => message,
            Err(error) => {
                writeln!(
                    output,
                    "{}",
                    json!({ "jsonrpc": "2.0", "id": null, "error": { "code": JSONRPC_PARSE_ERROR, "message": format!("parse error: {}", error) } })
                )?;
                output.flush()?;
                continue;
            }
        };
        let replies = match endpoint.send(&message) {
            Ok(replies) => {
                endpoint.remember_protocol_version(&replies);
                replies
            }
            Err(error) => match message.get("id") {
                Some(id) if !id.is_null() => vec![
                    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": JSONRPC_INTERNAL_ERROR, "message": error } }),
                ],
                _ => {
                    eprintln!("terra-swarm mcp-stdio: {}", error);
                    Vec::new()
                }
            },
        };
        for reply in replies {
            writeln!(output, "{}", reply)?;
        }
        output.flush()?;
    }
    Ok(())
}

pub fn run() -> i32 {
    let (Ok(url), Ok(token)) = (
        std::env::var(crate::mcp::launch::ENV_URL),
        std::env::var(crate::mcp::launch::ENV_TOKEN),
    ) else {
        eprintln!("terra-swarm mcp-stdio: run it inside a Terra Swarm terminal with agent coordination on (TERRA_MCP_URL and TERRA_MCP_TOKEN are missing)");
        return 1;
    };
    let mut endpoint = match Endpoint::new(&url, &token) {
        Ok(endpoint) => endpoint,
        Err(error) => {
            eprintln!("terra-swarm mcp-stdio: {}", error);
            return 1;
        }
    };
    let stdin = std::io::stdin();
    match bridge(&mut endpoint, stdin.lock(), std::io::stdout().lock()) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("terra-swarm mcp-stdio: {}", error);
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::test_support::{hub, identity};
    use std::io::Read;
    use std::sync::Arc;

    #[test]
    fn decodes_chunked_and_event_stream_bodies() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n5\r\ndata:\r\n12\r\n {\"id\":1,\"a\":true}\r\n0\r\n\r\n";
        let (status, headers, body) = split_response(raw).unwrap();
        assert_eq!(status, 200);
        assert_eq!(
            parse_messages(&body, headers.contains("text/event-stream")).unwrap(),
            vec![json!({ "id": 1, "a": true })]
        );
    }

    fn serve_once(response: &'static str) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
            let mut body_length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    body_length = value.trim().parse().unwrap();
                }
            }
            reader.read_exact(&mut vec![0; body_length]).unwrap();
            stream.write_all(response.as_bytes()).unwrap();
        });
        format!("http://127.0.0.1:{}/mcp", port)
    }

    #[test]
    fn given_a_reply_that_is_not_json_answers_the_request_with_an_error() {
        let url = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 8\r\nConnection: close\r\n\r\nnot json",
        );
        let ask = json!({ "jsonrpc": "2.0", "id": 9, "method": "tools/list" }).to_string();
        let mut output = Vec::new();

        bridge(
            &mut Endpoint::new(&url, "token-1").unwrap(),
            ask.as_bytes(),
            &mut output,
        )
        .unwrap();

        let reply: Value = serde_json::from_slice(output.trim_ascii()).unwrap();
        assert_eq!(reply["id"], 9);
        assert_eq!(reply["error"]["code"], JSONRPC_INTERNAL_ERROR);
        assert!(reply["error"]["message"]
            .as_str()
            .unwrap()
            .contains("invalid JSON"));
    }

    #[test]
    fn given_an_event_stream_with_invalid_data_reports_an_error() {
        assert!(parse_messages("data: {\"id\":1}\n\ndata: oops\n", true).is_err());
        assert_eq!(
            parse_messages("data:\n\ndata: {\"id\":1}\n", true).unwrap(),
            vec![json!({ "id": 1 })]
        );
    }

    #[test]
    fn a_stdio_client_talks_to_the_real_server() {
        let (hub, _) = hub();
        let token = hub.issue(identity("t-4", "ws-1", "opencode")).unwrap();
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        runtime.spawn(crate::mcp::server::serve(listener, Arc::clone(&hub)));
        let url = format!("http://127.0.0.1:{}/mcp", port);

        let input = [
            json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "stdio-test", "version": "1" } } }),
            json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
            json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "whoami", "arguments": {} } }),
        ]
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
            + "\nnot json\n";
        let mut output = Vec::new();
        bridge(
            &mut Endpoint::new(&url, &token).unwrap(),
            input.as_bytes(),
            &mut output,
        )
        .unwrap();
        let replies: Vec<Value> = String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(replies.len(), 3, "{:?}", replies);
        assert_eq!(replies[0]["id"], 1);
        assert!(replies[0]["result"]["serverInfo"].is_object());
        assert_eq!(replies[1]["id"], 2);
        let text = replies[1]["result"]["content"][0]["text"].as_str().unwrap();
        assert!(
            text.contains("\"terminal_id\": \"t-4\"") || text.contains("\"terminal_id\":\"t-4\""),
            "{}",
            text
        );
        assert_eq!(replies[2]["error"]["code"], JSONRPC_PARSE_ERROR);

        let mut output = Vec::new();
        let ask = json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/list" }).to_string();
        bridge(
            &mut Endpoint::new(&url, "nope").unwrap(),
            ask.as_bytes(),
            &mut output,
        )
        .unwrap();
        let reply: Value = serde_json::from_slice(output.trim_ascii()).unwrap();
        assert_eq!(reply["id"], 7);
        assert!(reply["error"]["message"].as_str().unwrap().contains("401"));
    }
}
