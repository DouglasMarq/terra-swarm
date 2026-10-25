use serde::Serialize;
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

const HOSTS: [&str; 4] = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"];
const OWN_PATHS: [&str; 2] = ["/mcp", "/hooks"];
const MAX_PROBED_PORTS: usize = 32;
const PROBE_TIMEOUT: Duration = Duration::from_millis(150);

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct DevServerPayload {
    pub id: String,
    pub workspace_id: String,
    pub url: String,
}

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
                .take_while(|character| {
                    !character.is_whitespace()
                        && !matches!(character, '"' | '\'' | ')' | '>' | '\u{1b}')
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

#[tauri::command(async)]
pub fn probe_dev_servers(ports: Vec<u16>) -> Vec<u16> {
    let mut ports = ports;
    ports.sort_unstable();
    ports.dedup();
    ports.truncate(MAX_PROBED_PORTS);
    probe(&ports, PROBE_TIMEOUT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn given_a_dev_server_banner_when_scanning_then_its_loopback_url_is_found() {
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
    fn given_remote_hosts_bad_ports_or_terra_itself_when_scanning_then_they_are_ignored() {
        assert!(
            detect_dev_server_urls("see https://example.com:443/x and http://localhost:99999")
                .is_empty()
        );
        assert!(detect_dev_server_urls("TERRA_MCP_URL=http://127.0.0.1:4100/mcp").is_empty());
        assert!(detect_dev_server_urls("http://localhost:/nope http://localhost").is_empty());
    }

    #[test]
    fn given_candidate_ports_when_probing_then_only_ports_that_answer_are_kept() {
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
