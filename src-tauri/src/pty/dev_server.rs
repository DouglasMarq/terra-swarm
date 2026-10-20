//! Finding a project's local dev server, for the preview panel: URLs that
//! terminals print ("Local: http://localhost:5173/") and ports that answer
//! on the loopback interface. Only loopback addresses are ever reported.

use serde::Serialize;
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

const HOSTS: [&str; 4] = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"];
/// Paths that belong to Terra's own MCP server, never to a dev server.
const OWN_PATHS: [&str; 2] = ["/mcp", "/hooks"];

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct DevServerPayload {
    pub id: String,
    pub workspace_id: String,
    pub url: String,
}

/// Loopback URLs in `text`, normalised to `http(s)://localhost:<port>/`, in
/// the order they appear and without repeats.
pub fn detect_dev_server_urls(text: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for scheme in ["http://", "https://"] {
        let mut start = 0;
        while let Some(offset) = text[start..].find(scheme) {
            let at = start + offset;
            start = at + scheme.len();
            let rest = &text[start..];
            let Some(host) = HOSTS
                .iter()
                .find(|host| rest.starts_with(&format!("{}:", host)))
            else {
                continue;
            };
            let after = &rest[host.len() + 1..];
            let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
            let Ok(port) = digits.parse::<u16>() else {
                continue;
            };
            if port == 0 {
                continue;
            }
            let path: String = after[digits.len()..]
                .chars()
                .take_while(|c| {
                    !c.is_whitespace() && !matches!(c, '"' | '\'' | ')' | '>' | '\u{1b}')
                })
                .collect();
            if OWN_PATHS.iter().any(|own| path.starts_with(own)) {
                continue;
            }
            let url = format!("{}localhost:{}/", scheme, port);
            if !found.contains(&url) {
                found.push(url);
            }
        }
    }
    found
}

/// Ports among `ports` that accept a TCP connection on 127.0.0.1.
pub fn probe(ports: &[u16], timeout: Duration) -> Vec<u16> {
    ports
        .iter()
        .copied()
        .filter(|port| *port != 0)
        .filter(|port| {
            TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], *port)), timeout).is_ok()
        })
        .collect()
}

/// Which of the given ports have a server listening on 127.0.0.1. Capped,
/// so the panel cannot be used to sweep the machine.
#[tauri::command(async)]
pub fn probe_dev_servers(ports: Vec<u16>) -> Vec<u16> {
    let mut ports = ports;
    ports.sort_unstable();
    ports.dedup();
    ports.truncate(32);
    probe(&ports, Duration::from_millis(150))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_loopback_urls_in_dev_server_banners() {
        let vite = "  VITE v7.0.0  ready in 180 ms\n\n  ➜  Local:   http://localhost:5173/\n  ➜  Network: use --host to expose";
        assert_eq!(detect_dev_server_urls(vite), vec!["http://localhost:5173/"]);
        let next = "- Local:        http://127.0.0.1:3000\n- Network:      http://192.168.1.4:3000";
        assert_eq!(detect_dev_server_urls(next), vec!["http://localhost:3000/"]);
        let many = "Serving on http://0.0.0.0:8000/docs and https://[::1]:8443, again http://localhost:8000";
        assert_eq!(
            detect_dev_server_urls(many),
            vec!["http://localhost:8000/", "https://localhost:8443/"]
        );
    }

    #[test]
    fn ignores_remote_hosts_bad_ports_and_terra_itself() {
        assert!(
            detect_dev_server_urls("see https://example.com:443/x and http://localhost:99999")
                .is_empty()
        );
        assert!(detect_dev_server_urls("TERRA_MCP_URL=http://127.0.0.1:4100/mcp").is_empty());
        assert!(detect_dev_server_urls("http://localhost:/nope http://localhost").is_empty());
    }

    #[test]
    fn probes_only_ports_that_answer() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let open = listener.local_addr().unwrap().port();
        let closed = {
            let spare = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            spare.local_addr().unwrap().port()
        };
        assert_eq!(
            probe(&[closed, open, 0], Duration::from_millis(200)),
            vec![open]
        );
    }
}
