//! Streamable HTTP transport: rmcp's tower service behind an axum router
//! that only accepts requests carrying a valid terminal token.
//!
//! The server listens on 127.0.0.1 only, answers in plain JSON without
//! sessions (stateless mode), rejects foreign `Host` headers (DNS rebinding)
//! and any request that carries a browser `Origin`.

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
    ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
    ToolAnnotations,
};
use rmcp::service::RequestContext;
use rmcp::transport::streamable_http_server::session::never::NeverSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ErrorData, RoleServer, ServerHandler};

use super::tools::{self, ToolError};
use super::{AgentIdentity, McpHub};

pub const MCP_PATH: &str = "/mcp";
const MAX_BODY_BYTES: usize = 256 * 1024;

#[derive(Clone)]
struct TerraServer {
    hub: Arc<McpHub>,
}

fn tool_list() -> Vec<Tool> {
    tools::definitions()
        .into_iter()
        .map(|def| {
            let schema = match def.schema {
                serde_json::Value::Object(map) => map,
                _ => serde_json::Map::new(),
            };
            let mut tool = Tool::new(def.name, def.description, schema);
            tool.title = Some(def.title.to_string());
            tool.annotations = Some(ToolAnnotations::from_raw(
                Some(def.title.to_string()),
                Some(def.read_only),
                Some(false),
                None,
                Some(false),
            ));
            tool
        })
        .collect()
}

impl ServerHandler for TerraServer {
    fn get_info(&self) -> ServerConfig {
        let mut implementation = Implementation::default();
        implementation.name = "terra-swarm".into();
        implementation.title = Some("Terra Swarm".into());
        implementation.version = env!("CARGO_PKG_VERSION").into();
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(implementation)
            .with_instructions(tools::SERVER_INSTRUCTIONS)
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let mut result = ListToolsResult::default();
        result.tools = tool_list();
        Ok(result)
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        tool_list().into_iter().find(|tool| tool.name == name)
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let identity = context
            .extensions
            .get::<axum::http::request::Parts>()
            .and_then(|parts| parts.extensions.get::<AgentIdentity>())
            .cloned()
            .ok_or_else(|| ErrorData::invalid_request("missing caller identity", None))?;
        let args = request
            .arguments
            .map(serde_json::Value::Object)
            .unwrap_or(serde_json::Value::Null);
        let hub = Arc::clone(&self.hub);
        let name = request.name.to_string();
        // Tool handlers take blocking locks and run SQLite queries.
        let outcome =
            tokio::task::spawn_blocking(move || tools::call(&hub, &identity, &name, args))
                .await
                .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        Ok(match outcome {
            Ok(value) => CallToolResult::success(vec![ContentBlock::text(
                serde_json::to_string_pretty(&value).unwrap_or_default(),
            )]),
            Err(ToolError::UnknownTool(name)) => {
                return Err(ErrorData::invalid_params(
                    format!("unknown tool `{}`", name),
                    None,
                ))
            }
            Err(error) => CallToolResult::error(vec![ContentBlock::text(error.to_string())]),
        }
        .into())
    }
}

fn bearer(request: &Request) -> Option<&str> {
    let value = request
        .headers()
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?;
    let (scheme, token) = value.split_once(' ')?;
    scheme.eq_ignore_ascii_case("bearer").then(|| token.trim())
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(header::WWW_AUTHENTICATE, "Bearer realm=\"terra-swarm\"")],
        "missing or invalid Terra Swarm MCP token",
    )
        .into_response()
}

/// Resolve the token to an identity and attach it to the request; rmcp
/// hands the request parts (with this extension) to `call_tool`.
async fn authenticate(
    State(hub): State<Arc<McpHub>>,
    mut request: Request,
    next: Next,
) -> Response {
    let Some(identity) = bearer(&request).and_then(|token| hub.identify(token)) else {
        return unauthorized();
    };
    request.extensions_mut().insert(identity);
    next.run(request).await
}

pub fn router(hub: Arc<McpHub>) -> axum::Router {
    let factory_hub = Arc::clone(&hub);
    let service = StreamableHttpService::new(
        move || {
            Ok(TerraServer {
                hub: Arc::clone(&factory_hub),
            })
        },
        Arc::new(NeverSessionManager::default()),
        StreamableHttpServerConfig::default()
            .with_legacy_session_mode(false)
            .with_json_response(true)
            .with_sse_keep_alive(None)
            .with_max_request_body_bytes(MAX_BODY_BYTES)
            .enforce_origin_validation(),
    );
    axum::Router::new()
        .nest_service(MCP_PATH, service)
        .route(super::hooks::HOOKS_PATH, axum::routing::post(super::hooks::handle))
        .route("/hooks/claude", axum::routing::post(super::hooks::handle_claude))
        .with_state(Arc::clone(&hub))
        .layer(middleware::from_fn_with_state(hub, authenticate))
}

/// Serve on an already bound listener until the runtime shuts down.
pub async fn serve(listener: std::net::TcpListener, hub: Arc<McpHub>) -> std::io::Result<()> {
    listener.set_nonblocking(true)?;
    let listener = tokio::net::TcpListener::from_std(listener)?;
    axum::serve(listener, router(hub)).await
}

/// Bind 127.0.0.1 on a free port and run the server on its own tokio
/// runtime thread. The port is recorded on the hub before this returns, so
/// terminals spawned right after startup already get the URL.
pub fn start(hub: Arc<McpHub>) -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
    let port = listener.local_addr()?.port();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("terra-mcp")
        .enable_all()
        .build()?;
    hub.set_port(port);
    let server_hub = Arc::clone(&hub);
    std::thread::Builder::new()
        .name("terra-mcp-server".into())
        .spawn(move || {
            if let Err(error) = runtime.block_on(serve(listener, server_hub)) {
                eprintln!("MCP server stopped: {}", error);
            }
        })?;
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{hub, identity};
    use super::*;
    use serde_json::{json, Value};

    struct TestServer {
        url: String,
        client: reqwest::Client,
        runtime: tokio::runtime::Runtime,
    }

    impl TestServer {
        fn start(hub: Arc<McpHub>) -> Self {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .unwrap();
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            runtime.spawn(serve(listener, hub));
            Self {
                url: format!("http://127.0.0.1:{}{}", port, MCP_PATH),
                client: reqwest::Client::new(),
                runtime,
            }
        }

        fn post(&self, token: Option<&str>, body: Value) -> (u16, String) {
            self.post_with(token, body, &[])
        }

        fn post_with(
            &self,
            token: Option<&str>,
            body: Value,
            extra: &[(&str, &str)],
        ) -> (u16, String) {
            self.runtime.block_on(async {
                let mut request = self
                    .client
                    .post(&self.url)
                    .header("content-type", "application/json")
                    .header("accept", "application/json, text/event-stream")
                    .header("mcp-protocol-version", "2025-06-18")
                    .body(body.to_string());
                if let Some(token) = token {
                    request = request.header("authorization", format!("Bearer {}", token));
                }
                for (name, value) in extra {
                    request = request.header(*name, *value);
                }
                let response = request.send().await.unwrap();
                let status = response.status().as_u16();
                (status, response.text().await.unwrap())
            })
        }

        /// Parse a JSON-RPC reply sent either as JSON or as one SSE event.
        fn rpc(&self, token: &str, id: u64, method: &str, params: Value) -> Value {
            let (status, body) = self.post(
                Some(token),
                json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
            );
            assert_eq!(status, 200, "{} -> {}", method, body);
            parse_rpc(&body)
        }
    }

    fn parse_rpc(body: &str) -> Value {
        if let Ok(value) = serde_json::from_str::<Value>(body) {
            return value;
        }
        body.lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .filter_map(|data| serde_json::from_str::<Value>(data.trim()).ok())
            .find(|value| value.get("id").is_some())
            .unwrap_or_else(|| panic!("no JSON-RPC response in {:?}", body))
    }

    fn initialize(server: &TestServer, token: &str) -> Value {
        let reply = server.rpc(
            token,
            1,
            "initialize",
            json!({
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": { "name": "terra-test", "version": "1.0" }
            }),
        );
        let (status, _) = server.post(
            Some(token),
            json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
        );
        assert!(status == 202 || status == 200, "initialized -> {}", status);
        reply
    }

    fn tool_json(reply: &Value) -> Value {
        let text = reply["result"]["content"][0]["text"].as_str().unwrap();
        serde_json::from_str(text).unwrap_or(Value::String(text.to_string()))
    }

    #[test]
    fn initialize_list_and_call_over_http() {
        let (hub, _) = hub();
        let token = hub.issue(identity("t-1", "ws-1", "claude"));
        let server = TestServer::start(Arc::clone(&hub));

        let init = initialize(&server, &token);
        assert_eq!(init["result"]["serverInfo"]["name"], "terra-swarm");
        assert!(init["result"]["capabilities"]["tools"].is_object());
        assert!(init["result"]["instructions"]
            .as_str()
            .unwrap()
            .contains("whoami"));

        let list = server.rpc(&token, 2, "tools/list", json!({}));
        let names: Vec<&str> = list["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"whoami"));
        assert!(names.contains(&"claim_task"));
        assert_eq!(names.len(), 13);

        let created = server.rpc(
            &token,
            3,
            "tools/call",
            json!({ "name": "create_task", "arguments": { "title": "Ship it" } }),
        );
        assert_eq!(created["result"]["isError"], false);
        assert_eq!(tool_json(&created)["id"], "T-1");

        let me = server.rpc(
            &token,
            4,
            "tools/call",
            json!({ "name": "whoami", "arguments": {} }),
        );
        assert_eq!(tool_json(&me)["terminal_id"], "t-1");

        // A failing tool is a tool-level error the agent can read.
        let failed = server.rpc(
            &token,
            5,
            "tools/call",
            json!({ "name": "get_task", "arguments": { "id": "T-99" } }),
        );
        assert_eq!(failed["result"]["isError"], true);
        assert!(failed["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("not found"));
    }

    #[test]
    fn requests_without_a_valid_token_get_401() {
        let (hub, _) = hub();
        let token = hub.issue(identity("t-1", "ws-1", "claude"));
        let server = TestServer::start(Arc::clone(&hub));
        let ping = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {} });

        assert_eq!(server.post(None, ping.clone()).0, 401);
        assert_eq!(server.post(Some("not-a-token"), ping.clone()).0, 401);

        hub.revoke_terminal("t-1");
        assert_eq!(server.post(Some(&token), ping.clone()).0, 401);

        // A killed terminal drops its PTY entry, and with it the lease.
        let lease_token = hub.issue(identity("t-2", "ws-1", "claude"));
        let lease = crate::mcp::McpLease::new(&hub, lease_token.clone());
        assert_eq!(server.post(Some(&lease_token), ping.clone()).0, 200);
        drop(lease);
        assert_eq!(server.post(Some(&lease_token), ping).0, 401);
    }

    #[test]
    fn a_token_only_sees_its_own_workspace() {
        let (hub, _) = hub();
        let mine = hub.issue(identity("t-1", "ws-1", "claude"));
        let theirs = hub.issue(identity("t-7", "ws-2", "codex"));
        let server = TestServer::start(Arc::clone(&hub));
        initialize(&server, &mine);
        server.rpc(
            &mine,
            2,
            "tools/call",
            json!({ "name": "create_task", "arguments": { "title": "ws-1 only" } }),
        );
        let listed = server.rpc(
            &theirs,
            3,
            "tools/call",
            json!({ "name": "list_tasks", "arguments": {} }),
        );
        assert_eq!(tool_json(&listed)["tasks"], json!([]));
    }

    #[test]
    fn browser_origins_are_rejected() {
        let (hub, _) = hub();
        let token = hub.issue(identity("t-1", "ws-1", "claude"));
        let server = TestServer::start(Arc::clone(&hub));
        let (status, _) = server.post_with(
            Some(&token),
            json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {} }),
            &[("origin", "https://evil.example")],
        );
        assert_eq!(status, 403);
    }
}
