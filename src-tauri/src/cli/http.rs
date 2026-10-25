use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

pub const HTTP_OK: u16 = 200;
pub const HTTP_ACCEPTED: u16 = 202;

pub struct Post<'a> {
    pub authority: &'a str,
    pub path: &'a str,
    pub token: &'a str,
    pub headers: &'a [(&'a str, &'a str)],
    pub body: &'a str,
}

pub struct Limits {
    pub connect_timeout: Duration,
    pub io_timeout: Duration,
    pub max_response_bytes: u64,
}

pub struct RawResponse {
    pub bytes: Vec<u8>,
    pub read: Result<(), String>,
}

fn request_text(post: &Post<'_>) -> String {
    let headers: String = post
        .headers
        .iter()
        .map(|(name, value)| format!("{}: {}\r\n", name, value))
        .collect();
    format!(
        "POST {path} HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\n{headers}Content-Length: {length}\r\nConnection: close\r\n\r\n{body}",
        path = post.path,
        host = post.authority,
        token = post.token,
        headers = headers,
        length = post.body.len(),
        body = post.body,
    )
}

fn connect(authority: &str, limits: &Limits) -> Result<TcpStream, String> {
    let address = authority
        .parse()
        .map_err(|error| format!("bad address {}: {}", authority, error))?;
    let stream = TcpStream::connect_timeout(&address, limits.connect_timeout)
        .map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(limits.io_timeout))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(limits.io_timeout))
        .map_err(|error| error.to_string())?;
    Ok(stream)
}

pub fn post(post: &Post<'_>, limits: &Limits) -> Result<RawResponse, String> {
    let mut stream = connect(post.authority, limits)?;
    stream
        .write_all(request_text(post).as_bytes())
        .map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    let read = stream
        .take(limits.max_response_bytes)
        .read_to_end(&mut bytes)
        .map(drop)
        .map_err(|error| error.to_string());
    Ok(RawResponse { bytes, read })
}
