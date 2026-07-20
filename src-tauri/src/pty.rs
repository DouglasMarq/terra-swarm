use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::workspace::{TerminalMeta, WorkspaceStore};

static NEXT_TERMINAL_ID: AtomicU64 = AtomicU64::new(1);
static SPAWN_SEQ: AtomicU64 = AtomicU64::new(1);

pub fn bump_next_terminal_id(id: &str) {
    if let Some(n) = id.strip_prefix("t-").and_then(|s| s.parse::<u64>().ok()) {
        NEXT_TERMINAL_ID.fetch_max(n.saturating_add(1), Ordering::SeqCst);
    }
}

const BACKLOG_CAP: usize = 256 * 1024;

/// Per-terminal ring of recently emitted output plus the cumulative count of
/// bytes ever emitted. The frontend fetches a snapshot on mount and uses
/// `total` to drop live events that are already contained in the snapshot,
/// giving exactly-once delivery across listener attach.
pub struct Backlog {
    buf: Vec<u8>,
    total: u64,
}

impl Backlog {
    fn new() -> Self {
        Self {
            buf: Vec::new(),
            total: 0,
        }
    }

    fn push(&mut self, s: &str) {
        self.buf.extend_from_slice(s.as_bytes());
        if self.buf.len() > BACKLOG_CAP {
            let cut = self.buf.len() - BACKLOG_CAP;
            self.buf.drain(..cut);
        }
        self.total += s.len() as u64;
    }
}

#[cfg_attr(windows, allow(dead_code))]
pub struct PtyEntry {
    pub input: std::sync::mpsc::SyncSender<Vec<u8>>,
    pub master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    pub killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
    pub pid: Option<u32>,
    pub last_size: Arc<Mutex<(u16, u16)>>,
    pub seq: u64,
    pub reaped: Arc<AtomicBool>,
    pub backlog: Arc<Mutex<Backlog>>,
}

fn kill_entry(entry: PtyEntry) {
    #[cfg(unix)]
    if let Some(pid) = entry.pid {
        // Only signal the process group if the child has not been reaped yet.
        // After reaping, the pid (== pgid for a session leader) may already
        // have been recycled by an unrelated process.
        if !entry.reaped.load(Ordering::SeqCst) {
            unsafe {
                libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
            }
        }
    }
    if let Ok(mut killer) = entry.killer.lock() {
        let _ = killer.kill();
    }
}

#[derive(Default)]
pub struct PtyManager {
    terminals: HashMap<String, PtyEntry>,
}

#[derive(Serialize, Clone)]
pub struct ExitPayload {
    pub id: String,
    pub workspace_id: String,
    pub code: Option<u32>,
    pub seq: u64,
}

#[derive(Serialize, Clone)]
pub struct OutputChunk {
    pub data: String,
    pub total: u64,
}

#[derive(Serialize, Clone)]
pub struct SpawnedTerminal {
    pub meta: TerminalMeta,
    pub seq: u64,
}

#[derive(Serialize, Clone)]
pub struct RunningTerminal {
    pub id: String,
    pub seq: u64,
}

#[derive(Serialize, Clone)]
pub struct BacklogSnapshot {
    pub data: String,
    pub total: u64,
}

#[derive(Serialize, Clone)]
pub struct NotificationPayload {
    pub id: String,
    pub workspace_id: String,
    pub count: usize,
    pub messages: Vec<String>,
}

/// Counts attention signals in a terminal output chunk and extracts a
/// human-readable message for each: BEL characters and OSC 9 / 99 / 777
/// notification sequences (ESC ] N ; ... terminated by BEL or ST). OSC bodies
/// carry the text; for bare BELs the last non-empty line of recent output
/// (`tail`) is used as the message. A BEL burst yields a single fallback
/// message even though every BEL counts.
fn extract_notifications(data: &[u8], tail: &[u8]) -> (usize, Vec<String>) {
    let mut count = 0;
    let mut messages: Vec<String> = Vec::new();
    let mut bels = 0;
    let mut i = 0;
    while i < data.len() {
        if data[i] == 0x1b && i + 1 < data.len() && data[i + 1] == b']' {
            let mut j = i + 2;
            let mut num: u32 = 0;
            let mut digits = 0;
            while j < data.len() && data[j].is_ascii_digit() {
                num = num.saturating_mul(10).saturating_add((data[j] - b'0') as u32);
                digits += 1;
                j += 1;
            }
            if j < data.len() && data[j] == b';' && digits > 0 {
                let body_start = j + 1;
                let mut end = data.len();
                let mut k = body_start;
                while k < data.len() {
                    if data[k] == 0x07 {
                        end = k;
                        k += 1;
                        break;
                    }
                    if data[k] == 0x1b && k + 1 < data.len() && data[k + 1] == b'\\' {
                        end = k;
                        k += 2;
                        break;
                    }
                    k += 1;
                }
                if num == 9 || num == 99 || num == 777 {
                    count += 1;
                    let body = String::from_utf8_lossy(&data[body_start..end])
                        .trim()
                        .to_string();
                    let msg = match num {
                        // urxvt: OSC 777 ; notify ; title ; body
                        777 => {
                            let mut parts = body.splitn(3, ';');
                            let _proto = parts.next();
                            let title = parts.next().unwrap_or("").trim();
                            let text = parts.next().unwrap_or("").trim();
                            if !title.is_empty() && !text.is_empty() {
                                format!("{}: {}", title, text)
                            } else {
                                text.to_string()
                            }
                        }
                        // kitty: OSC 99 ; metadata ; payload
                        99 => match body.split_once(';') {
                            Some((_, payload)) => payload.trim().to_string(),
                            None => String::new(),
                        },
                        _ => body,
                    };
                    if !msg.is_empty() {
                        messages.push(msg.chars().take(200).collect());
                    }
                }
                i = k;
                continue;
            }
            i += 2;
        } else {
            if data[i] == 0x07 {
                count += 1;
                bels += 1;
            }
            i += 1;
        }
    }
    if bels > 0 && messages.is_empty() {
        let plain = strip_ansi(&String::from_utf8_lossy(tail));
        let fallback = plain
            .lines()
            .rev()
            .map(|l| l.chars().filter(|c| !c.is_control()).collect::<String>())
            .map(|l| l.trim().to_string())
            .find(|l| !l.is_empty())
            .map(|l| l.chars().take(200).collect::<String>())
            .unwrap_or_else(|| "Terminal notification".to_string());
        messages.push(fallback);
    }
    (count, messages)
}

#[derive(Serialize, Clone)]
pub struct ContextPayload {
    pub id: String,
    pub workspace_id: String,
    pub used: u8,
}

#[derive(Serialize, Clone)]
pub struct TitlePayload {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
}

/// Scans `buf` for OSC 0/1/2 window-title sequences (ESC ] N ; text, ended by
/// BEL or ST) and pushes any titles found onto `out`. Consumed bytes are
/// drained; a trailing partial sequence is kept for the next chunk. Sequences
/// that grow past 4 KB without a terminator are assumed malformed and skipped.
fn scan_titles(buf: &mut Vec<u8>, out: &mut Vec<String>) {
    let mut i = 0;
    while i < buf.len() {
        if buf[i] == 0x1b && i + 1 < buf.len() && buf[i + 1] == b']' {
            let mut j = i + 2;
            let mut term: Option<(usize, usize)> = None;
            while j < buf.len() {
                if buf[j] == 0x07 {
                    term = Some((j, 1));
                    break;
                }
                if buf[j] == 0x1b && j + 1 < buf.len() && buf[j + 1] == b'\\' {
                    term = Some((j, 2));
                    break;
                }
                j += 1;
            }
            let Some((end, tlen)) = term else {
                if buf.len() - i > 4096 {
                    i += 2;
                    continue;
                }
                break;
            };
            let content = &buf[i + 2..end];
            if let Some(sep) = content.iter().position(|&b| b == b';') {
                let code = &content[..sep];
                if code == b"0" || code == b"1" || code == b"2" {
                    let text = String::from_utf8_lossy(&content[sep + 1..])
                        .trim()
                        .to_string();
                    if !text.is_empty() {
                        out.push(text);
                    }
                }
            }
            i = end + tlen;
        } else {
            i += 1;
        }
    }
    buf.drain(..i);
}

/// Strips ANSI escape sequences (CSI, OSC, charset selects) from a chunk so
/// that status text printed by agent TUIs becomes plain searchable text.
fn strip_ansi(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == 0x1b && i + 1 < bytes.len() {
            match bytes[i + 1] {
                b'[' => {
                    i += 2;
                    while i < bytes.len() {
                        let b = bytes[i];
                        i += 1;
                        if (0x40..=0x7e).contains(&b) {
                            break;
                        }
                    }
                }
                b']' => {
                    i += 2;
                    while i < bytes.len() {
                        if bytes[i] == 0x07 {
                            i += 1;
                            break;
                        }
                        if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'\\' {
                            i += 2;
                            break;
                        }
                        i += 1;
                    }
                }
                b'(' | b')' | b'#' => {
                    i = (i + 3).min(bytes.len());
                }
                _ => {
                    i = (i + 2).min(bytes.len());
                }
            }
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn parse_trailing_number(s: &str) -> Option<f64> {
    let t = s.trim_end();
    let bytes = t.as_bytes();
    let mut end = bytes.len();
    let mut mult = 1.0;
    if end > 0 {
        match bytes[end - 1] {
            b'k' | b'K' => {
                mult = 1_000.0;
                end -= 1;
            }
            b'm' | b'M' => {
                mult = 1_000_000.0;
                end -= 1;
            }
            _ => {}
        }
    }
    let mut start = end;
    while start > 0
        && (bytes[start - 1].is_ascii_digit() || bytes[start - 1] == b'.' || bytes[start - 1] == b',')
    {
        start -= 1;
    }
    if start == end {
        return None;
    }
    let cleaned: String = t[start..end].chars().filter(|c| *c != ',').collect();
    cleaned.parse::<f64>().ok().map(|v| v * mult)
}

fn parse_leading_number(s: &str) -> Option<f64> {
    let t = s.trim_start();
    let bytes = t.as_bytes();
    let mut i = 0;
    while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'.' || bytes[i] == b',') {
        i += 1;
    }
    if i == 0 {
        return None;
    }
    let cleaned: String = t[..i].chars().filter(|c| *c != ',').collect();
    let mut v = cleaned.parse::<f64>().ok()?;
    if i < bytes.len() {
        match bytes[i] {
            b'k' | b'K' => v *= 1_000.0,
            b'm' | b'M' => v *= 1_000_000.0,
            _ => {}
        }
    }
    Some(v)
}

/// Largest index <= i that lies on a char boundary (clamped to s.len()).
fn floor_boundary(s: &str, i: usize) -> usize {
    let mut i = i.min(s.len());
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// Smallest index >= i that lies on a char boundary (clamped to s.len()).
fn ceil_boundary(s: &str, i: usize) -> usize {
    let mut i = i.min(s.len());
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// Best-effort detection of context-window usage in agent output. Understands
/// "N% context left/remaining" (Claude), "N% (of) context used/full",
/// "a / b tokens" ratios (Codex), and "12.3K (42%)" footer counts (OpenCode).
/// Returns percent *used* (0-100). When several indicators are present, the
/// most recent one wins.
fn detect_context_used(text: &str) -> Option<u8> {
    let lower = text.to_lowercase();
    let mut best: Option<(usize, f64)> = None;
    let consider = |pos: usize, used: f64, best: &mut Option<(usize, f64)>| {
        if used.is_finite() && (0.0..=100.0).contains(&used) {
            if best.map_or(true, |(p, _)| pos >= p) {
                *best = Some((pos, used));
            }
        }
    };

    let mut start = 0;
    while let Some(off) = lower[start..].find("context") {
        let idx = start + off;
        let lo = floor_boundary(&lower, idx.saturating_sub(48));
        let hi = ceil_boundary(&lower, idx + 48);
        let window = &lower[lo..hi];
        // The percent belongs to the keyword, so take the one closest before
        // it; an earlier '%' in the window may belong to a stale indicator.
        let koff = idx - lo;
        if let Some(pct) = window[..koff].rfind('%') {
            if let Some(v) = parse_trailing_number(&window[..pct]) {
                let used = if window.contains("left")
                    || window.contains("remain")
                    || window.contains("free")
                {
                    100.0 - v
                } else {
                    v
                };
                consider(idx, used, &mut best);
            }
        }
        start = idx + 7;
    }

    let mut start = 0;
    while let Some(off) = lower[start..].find("token") {
        let idx = start + off;
        let lo = floor_boundary(&lower, idx.saturating_sub(90));
        let window = &lower[lo..idx];
        if let Some(slash) = window.rfind('/') {
            if let (Some(a), Some(b)) = (
                parse_trailing_number(&window[..slash]),
                parse_leading_number(&window[slash + 1..]),
            ) {
                if b > 0.0 {
                    consider(idx, a / b * 100.0, &mut best);
                }
            }
        }
        start = idx + 5;
    }

    // OpenCode footer: "12.3K (42%)" - a bare parenthesized percent right
    // after a token count, with no "context"/"token" keyword nearby.
    let mut start = 0;
    while let Some(off) = lower[start..].find("%)") {
        let pct = start + off;
        if let Some(open) = lower[..pct].rfind('(') {
            if pct - open <= 5 {
                let inside = &lower[open + 1..pct];
                if !inside.is_empty() && inside.bytes().all(|b| b.is_ascii_digit()) {
                    let before = lower[..open].trim_end();
                    if parse_trailing_number(before).is_some() {
                        consider(pct, inside.parse::<f64>().unwrap(), &mut best);
                    }
                }
            }
        }
        start = pct + 2;
    }

    best.map(|(_, v)| v.round() as u8)
}

#[derive(Serialize, Clone)]
pub struct AgentInfo {
    pub id: String,
    pub label: String,
    pub available: bool,
}

/// Drains one decodable chunk from `pending`, replacing invalid bytes with
/// U+FFFD so a single bad byte can never wedge the output pipeline. Returns
/// None when the buffer holds only an incomplete trailing sequence (wait for
/// more bytes) or is empty.
fn take_decodable(pending: &mut Vec<u8>) -> Option<String> {
    if pending.is_empty() {
        return None;
    }
    match std::str::from_utf8(pending) {
        Ok(_) => String::from_utf8(std::mem::take(pending)).ok(),
        Err(e) => {
            let valid = e.valid_up_to();
            match e.error_len() {
                Some(bad) => {
                    let head: Vec<u8> = pending.drain(..valid).collect();
                    pending.drain(..bad);
                    let mut s = String::from_utf8(head).unwrap_or_default();
                    s.push('\u{FFFD}');
                    Some(s)
                }
                None => {
                    if valid == 0 {
                        None
                    } else {
                        String::from_utf8(pending.drain(..valid).collect()).ok()
                    }
                }
            }
        }
    }
}

#[cfg(unix)]
fn login_shell() -> Option<String> {
    unsafe {
        let pw = libc::getpwuid(libc::getuid());
        if pw.is_null() || (*pw).pw_shell.is_null() {
            return None;
        }
        let shell = std::ffi::CStr::from_ptr((*pw).pw_shell)
            .to_string_lossy()
            .into_owned();
        if shell.is_empty() || !std::path::Path::new(&shell).exists() {
            None
        } else {
            Some(shell)
        }
    }
}

#[cfg(unix)]
fn valid_shell(shell: &str) -> bool {
    shell.starts_with('/') && std::path::Path::new(shell).exists()
}

#[cfg(windows)]
fn valid_shell(shell: &str) -> bool {
    let path = std::path::Path::new(shell);
    path.is_absolute() && path.exists()
}

#[cfg(windows)]
fn find_on_path(exe: &str) -> Option<String> {
    let output = std::process::Command::new("where.exe")
        .arg(exe)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout)
        .ok()
        .and_then(|s| s.lines().next().map(|l| l.trim().to_string()))
        .filter(|p| !p.is_empty() && std::path::Path::new(p).exists())
}

#[cfg(windows)]
fn find_git_bash() -> Option<String> {
    if let Some(git) = find_on_path("git.exe") {
        let path = std::path::Path::new(&git);
        if let Some(root) = path.parent().and_then(|p| p.parent()) {
            let bash = root.join("bin").join("bash.exe");
            if bash.exists() {
                return Some(bash.to_string_lossy().into_owned());
            }
        }
    }
    let mut candidates: Vec<std::path::PathBuf> = vec![
        std::path::PathBuf::from(r"C:\Program Files\Git\bin\bash.exe"),
        std::path::PathBuf::from(r"C:\Program Files (x86)\Git\bin\bash.exe"),
    ];
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        candidates.push(
            std::path::Path::new(&local)
                .join("Programs")
                .join("Git")
                .join("bin")
                .join("bash.exe"),
        );
    }
    candidates
        .into_iter()
        .find(|p| p.exists())
        .map(|p| p.to_string_lossy().into_owned())
}

#[cfg(windows)]
#[derive(Clone, Copy, PartialEq, Eq)]
enum ShellFlavor {
    PowerShell,
    Cmd,
    Posix,
}

#[cfg(windows)]
fn shell_flavor(shell: &str) -> ShellFlavor {
    let name = std::path::Path::new(shell)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(shell)
        .to_lowercase();
    if name.starts_with("pwsh") || name.starts_with("powershell") {
        ShellFlavor::PowerShell
    } else if name.starts_with("cmd") {
        ShellFlavor::Cmd
    } else {
        ShellFlavor::Posix
    }
}

#[cfg(unix)]
fn user_shell() -> String {
    if let Some(shell) = login_shell() {
        return shell;
    }
    if let Ok(shell) = std::env::var("SHELL") {
        if valid_shell(&shell) {
            return shell;
        }
    }
    "/bin/zsh".to_string()
}

#[cfg(windows)]
fn user_shell() -> String {
    if let Some(pwsh) = find_on_path("pwsh.exe") {
        return pwsh;
    }
    if let Some(ps) = find_on_path("powershell.exe") {
        return ps;
    }
    if let Ok(comspec) = std::env::var("COMSPEC") {
        if valid_shell(&comspec) {
            return comspec;
        }
    }
    r"C:\Windows\System32\cmd.exe".to_string()
}

fn resolve_shell(preferred: Option<&str>) -> String {
    match preferred.map(str::trim) {
        Some(shell) if valid_shell(shell) => shell.to_string(),
        _ => user_shell(),
    }
}

#[tauri::command(async)]
pub fn list_available_shells() -> Vec<String> {
    let mut shells: Vec<String> = Vec::new();
    let mut add = |shell: String| {
        if valid_shell(&shell) && !shells.contains(&shell) {
            shells.push(shell);
        }
    };
    #[cfg(unix)]
    {
        if let Some(shell) = login_shell() {
            add(shell);
        }
        if let Ok(contents) = std::fs::read_to_string("/etc/shells") {
            for line in contents.lines() {
                let line = line.trim();
                if line.starts_with('#') {
                    continue;
                }
                add(line.to_string());
            }
        }
        if let Ok(shell) = std::env::var("SHELL") {
            add(shell);
        }
    }
    #[cfg(windows)]
    {
        if let Some(pwsh) = find_on_path("pwsh.exe") {
            add(pwsh);
        }
        if let Some(ps) = find_on_path("powershell.exe") {
            add(ps);
        }
        if let Some(bash) = find_git_bash() {
            add(bash);
        }
        if let Ok(comspec) = std::env::var("COMSPEC") {
            add(comspec);
        }
        add(r"C:\Windows\System32\cmd.exe".to_string());
    }
    shells
}

pub fn spawn_terminal_inner(
    app: &AppHandle,
    manager: &Mutex<PtyManager>,
    store: &Mutex<WorkspaceStore>,
    workspace_id: &str,
    command: &str,
    cols: u16,
    rows: u16,
    force_id: Option<&str>,
    preferred_shell: Option<&str>,
) -> Result<SpawnedTerminal, String> {
    let workspace_id = workspace_id.to_string();
    let cwd = {
        let store = store.lock().map_err(|e| e.to_string())?;
        store
            .get(&workspace_id)
            .map(|ws| ws.cwd.clone())
            .ok_or_else(|| format!("workspace {} not found", workspace_id))?
    };

    let id = match force_id {
        Some(fid) => {
            bump_next_terminal_id(fid);
            fid.to_string()
        }
        None => format!("t-{}", NEXT_TERMINAL_ID.fetch_add(1, Ordering::SeqCst)),
    };
    let command = command.trim().to_string();
    let seq = SPAWN_SEQ.fetch_add(1, Ordering::SeqCst);

    {
        let manager = manager.lock().map_err(|e| e.to_string())?;
        if manager.terminals.contains_key(&id) {
            return Err(format!("terminal {} already running", id));
        }
    }

    let shell = resolve_shell(preferred_shell);
    let mut cmd = CommandBuilder::new(&shell);
    let interactive = command.is_empty() || command == "shell";
    #[cfg(unix)]
    {
        if interactive {
            cmd.args(["-l", "-i"]);
        } else {
            cmd.args(["-l", "-c", &format!("exec {}", command)]);
        }
    }
    #[cfg(windows)]
    match shell_flavor(&shell) {
        ShellFlavor::PowerShell => {
            if interactive {
                cmd.args(["-NoLogo"]);
            } else {
                cmd.args(["-NoLogo", "-Command", &command]);
            }
        }
        ShellFlavor::Cmd => {
            if !interactive {
                cmd.args(["/C", &command]);
            }
        }
        ShellFlavor::Posix => {
            if interactive {
                cmd.args(["-l", "-i"]);
            } else {
                cmd.args(["-l", "-c", &format!("exec {}", command)]);
            }
        }
    }
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "terra-swarm");

    let pair = native_pty_system()
        .openpty(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("failed to spawn `{}`: {}", command, e))?;
    drop(pair.slave);

    let pid = child.process_id();
    let killer = Arc::new(Mutex::new(child.clone_killer()));
    let reaped = Arc::new(AtomicBool::new(false));
    let backlog = Arc::new(Mutex::new(Backlog::new()));
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let (input_tx, input_rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(256);
    std::thread::spawn(move || {
        while let Ok(data) = input_rx.recv() {
            if writer.write_all(&data).and_then(|_| writer.flush()).is_err() {
                break;
            }
        }
    });

    {
        // Reader thread: drains the PTY as fast as the child produces data so
        // the kernel buffer never fills and the child never blocks on write().
        let (chunk_tx, chunk_rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let reader_id = id.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 16384];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if chunk_tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        eprintln!("pty reader for {} failed: {}", reader_id, e);
                        break;
                    }
                }
            }
        });

        // Flusher thread: coalesces chunks into rate-limited emits (~60/s).
        // Bursts larger than FORCE_FLUSH bypass the pacing so throughput
        // scales with output volume; emit failures never kill the thread.
        let output_event = format!("pty-output-{}", id);
        let notif_id = id.clone();
        let notif_ws = workspace_id.clone();
        let app = app.clone();
        let backlog = Arc::clone(&backlog);
        std::thread::spawn(move || {
            let mut pending: Vec<u8> = Vec::new();
            let mut raw_tail: Vec<u8> = Vec::new();
            let mut title_buf: Vec<u8> = Vec::new();
            let mut title_last: Option<String> = None;
            let mut ctx_last: Option<u8> = None;
            let mut ctx_last_check = std::time::Instant::now();
            let flush_interval = std::time::Duration::from_millis(16);
            let ctx_interval = std::time::Duration::from_millis(250);
            const FORCE_FLUSH: usize = 65536;
            let mut last_flush = std::time::Instant::now() - flush_interval;

            // Side-channel scan shared by the paced path and the final flush.
            let mut process = |s: &str| {
                raw_tail.extend_from_slice(s.as_bytes());
                if raw_tail.len() > 8192 {
                    let cut = raw_tail.len() - 8192;
                    raw_tail.drain(..cut);
                }
                let (notifs, messages) = extract_notifications(s.as_bytes(), &raw_tail);
                if notifs > 0 {
                    let _ = app.emit(
                        "terminal-notification",
                        NotificationPayload {
                            id: notif_id.clone(),
                            workspace_id: notif_ws.clone(),
                            count: notifs,
                            messages,
                        },
                    );
                }
                title_buf.extend_from_slice(s.as_bytes());
                let mut titles: Vec<String> = Vec::new();
                scan_titles(&mut title_buf, &mut titles);
                if let Some(title) = titles.into_iter().last() {
                    if title_last.as_deref() != Some(title.as_str()) {
                        title_last = Some(title.clone());
                        let _ = app.emit(
                            "terminal-title",
                            TitlePayload {
                                id: notif_id.clone(),
                                workspace_id: notif_ws.clone(),
                                title,
                            },
                        );
                    }
                }
                if ctx_last_check.elapsed() >= ctx_interval {
                    ctx_last_check = std::time::Instant::now();
                    let plain = strip_ansi(&String::from_utf8_lossy(&raw_tail));
                    if let Some(used) = detect_context_used(&plain) {
                        if ctx_last != Some(used) {
                            ctx_last = Some(used);
                            let _ = app.emit(
                                "terminal-context",
                                ContextPayload {
                                    id: notif_id.clone(),
                                    workspace_id: notif_ws.clone(),
                                    used,
                                },
                            );
                        }
                    }
                }
            };

            let emit_output = |s: String| {
                let total = {
                    let mut b = backlog.lock().unwrap_or_else(|e| e.into_inner());
                    b.push(&s);
                    b.total
                };
                let _ = app.emit(&output_event, OutputChunk { data: s, total });
            };

            enum In {
                Chunk(Vec<u8>),
                Tick,
                Closed,
            }
            loop {
                let input = if pending.is_empty() {
                    match chunk_rx.recv() {
                        Ok(c) => In::Chunk(c),
                        Err(_) => In::Closed,
                    }
                } else {
                    let wait = flush_interval.saturating_sub(last_flush.elapsed());
                    if wait.is_zero() {
                        match chunk_rx.try_recv() {
                            Ok(c) => In::Chunk(c),
                            Err(std::sync::mpsc::TryRecvError::Empty) => In::Tick,
                            Err(std::sync::mpsc::TryRecvError::Disconnected) => In::Closed,
                        }
                    } else {
                        match chunk_rx.recv_timeout(wait) {
                            Ok(c) => In::Chunk(c),
                            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => In::Tick,
                            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => In::Closed,
                        }
                    }
                };
                match input {
                    In::Chunk(c) => {
                        pending.extend_from_slice(&c);
                        if pending.len() < FORCE_FLUSH
                            && last_flush.elapsed() < flush_interval
                        {
                            continue;
                        }
                    }
                    In::Tick => {}
                    In::Closed => {
                        // Final flush: emit whatever remains (lossy) and exit.
                        if !pending.is_empty() {
                            let s = String::from_utf8_lossy(&pending).into_owned();
                            pending.clear();
                            process(&s);
                            emit_output(s);
                        }
                        break;
                    }
                }
                let Some(s) = take_decodable(&mut pending) else {
                    // Incomplete UTF-8 char at the tail; wait for more bytes.
                    last_flush = std::time::Instant::now();
                    continue;
                };
                process(&s);
                emit_output(s);
                last_flush = std::time::Instant::now();
            }
        });
    }

    {
        let app = app.clone();
        let exit_id = id.clone();
        let exit_ws = workspace_id.clone();
        let entry_killer = Arc::clone(&killer);
        let reaped = Arc::clone(&reaped);
        std::thread::spawn(move || {
            let code = child.wait().ok().map(|s| s.exit_code());
            // Mark reaped immediately so kill_entry never signals a pid that
            // the OS may already have recycled.
            reaped.store(true, Ordering::SeqCst);
            // Remove from the manager BEFORE notifying the frontend, so a
            // concurrent running_terminals never reports this id as alive.
            if let Some(manager) = app.try_state::<Mutex<PtyManager>>() {
                if let Ok(mut manager) = manager.lock() {
                    let is_current = manager
                        .terminals
                        .get(&exit_id)
                        .map_or(false, |e| Arc::ptr_eq(&e.killer, &entry_killer));
                    if is_current {
                        manager.terminals.remove(&exit_id);
                    }
                }
            }
            // Clean up descendants that survive the child: while any of them
            // lives, the group still owns this pgid, so the signal cannot hit
            // a recycled group. Dropping the entry also closes the master,
            // which delivers SIGHUP to the session.
            #[cfg(unix)]
            if let Some(pid) = pid {
                unsafe {
                    libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
                }
            }
            let _ = app.emit(
                "terminal-exit",
                ExitPayload {
                    id: exit_id.clone(),
                    workspace_id: exit_ws,
                    code,
                    seq,
                },
            );
        });
    }

    let entry = PtyEntry {
        input: input_tx,
        master: Arc::new(Mutex::new(pair.master)),
        killer,
        pid,
        last_size: Arc::new(Mutex::new((cols.max(2), rows.max(2)))),
        seq,
        reaped,
        backlog,
    };
    manager
        .lock()
        .map_err(|e| e.to_string())?
        .terminals
        .insert(id.clone(), entry);

    let meta = TerminalMeta {
        id: id.clone(),
        command: if command.is_empty() { "shell".into() } else { command },
        width: None,
    };
    let added = store
        .lock()
        .map_err(|e| e.to_string())?
        .add_terminal(&workspace_id, meta.clone());
    if !added {
        // The workspace was closed while we were spawning; don't leak the
        // process or leave it running untracked.
        kill_terminal_inner(manager, &id);
        return Err(format!("workspace {} not found", workspace_id));
    }

    Ok(SpawnedTerminal { meta, seq })
}

#[tauri::command(async)]
pub fn spawn_terminal(
    app: AppHandle,
    manager: State<'_, Mutex<PtyManager>>,
    store: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    command: String,
    cols: u16,
    rows: u16,
    terminal_id: Option<String>,
    shell: Option<String>,
) -> Result<SpawnedTerminal, String> {
    spawn_terminal_inner(
        &app,
        &manager,
        &store,
        &workspace_id,
        &command,
        cols,
        rows,
        terminal_id.as_deref(),
        shell.as_deref(),
    )
}

pub fn demo_seed(app: &AppHandle) {
    let store = app.state::<Mutex<WorkspaceStore>>();
    let manager = app.state::<Mutex<PtyManager>>();
    let mut picked: Vec<&str> = Vec::new();
    for c in ["claude", "codex", "opencode", "kimi"] {
        if command_available(c) {
            picked.push(c);
        }
        if picked.len() == 2 {
            break;
        }
    }
    let ws1 = store
        .lock()
        .map(|mut s| s.create("agents".into(), String::new()));
    if let Ok(ws1) = ws1 {
        for c in picked {
            let _ = spawn_terminal_inner(app, &manager, &store, &ws1.id, c, 100, 30, None, None);
        }
    }
    let ws2 = store
        .lock()
        .map(|mut s| s.create("scratch".into(), String::new()));
    if let Ok(ws2) = ws2 {
        #[cfg(unix)]
        let _ = spawn_terminal_inner(app, &manager, &store, &ws2.id, "top", 100, 30, None, None);
        let _ = spawn_terminal_inner(app, &manager, &store, &ws2.id, "shell", 100, 30, None, None);
    }
    let _ = app.emit("workspaces-changed", ());
}

#[tauri::command(async)]
pub fn write_terminal(
    manager: State<'_, Mutex<PtyManager>>,
    id: String,
    data: String,
) -> Result<(), String> {
    let input = {
        let manager = manager.lock().map_err(|e| e.to_string())?;
        manager
            .terminals
            .get(&id)
            .map(|e| e.input.clone())
            .ok_or_else(|| format!("terminal {} not found", id))?
    };
    match input.try_send(data.into_bytes()) {
        Ok(()) => Ok(()),
        Err(std::sync::mpsc::TrySendError::Full(_)) => {
            Err(format!("terminal {} input busy", id))
        }
        Err(std::sync::mpsc::TrySendError::Disconnected(_)) => {
            Err(format!("terminal {} input closed", id))
        }
    }
}

#[tauri::command(async)]
pub fn resize_terminal(
    manager: State<'_, Mutex<PtyManager>>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let (master, last_size) = {
        let manager = manager.lock().map_err(|e| e.to_string())?;
        let entry = manager
            .terminals
            .get(&id)
            .ok_or_else(|| format!("terminal {} not found", id))?;
        (Arc::clone(&entry.master), Arc::clone(&entry.last_size))
    };
    let cols = cols.max(2);
    let rows = rows.max(2);
    {
        let mut last = last_size.lock().map_err(|e| e.to_string())?;
        if *last == (cols, rows) {
            return Ok(());
        }
        *last = (cols, rows);
    }
    let guard = master.lock().map_err(|e| e.to_string())?;
    guard
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

pub fn kill_terminal_inner(manager: &Mutex<PtyManager>, id: &str) {
    let entry = {
        let mut manager = match manager.lock() {
            Ok(m) => m,
            Err(_) => return,
        };
        manager.terminals.remove(id)
    };
    if let Some(entry) = entry {
        kill_entry(entry);
    }
}

pub fn kill_all(manager: &Mutex<PtyManager>) {
    let entries: Vec<PtyEntry> = match manager.lock() {
        Ok(mut m) => m.terminals.drain().map(|(_, e)| e).collect(),
        Err(_) => return,
    };
    for entry in entries {
        kill_entry(entry);
    }
}

#[tauri::command(async)]
pub fn kill_terminal(
    app: AppHandle,
    id: String,
) -> Result<(), String> {
    let manager = app.state::<Mutex<PtyManager>>();
    kill_terminal_inner(&manager, &id);
    let store = app.state::<Mutex<WorkspaceStore>>();
    store
        .lock()
        .map_err(|e| e.to_string())?
        .remove_terminal(&id);
    Ok(())
}

/// Kills the PTY process but keeps the workspace store entry, so a respawn
/// with the same id (restart) preserves the terminal's position and width.
#[tauri::command(async)]
pub fn stop_terminal(app: AppHandle, id: String) -> Result<(), String> {
    let manager = app.state::<Mutex<PtyManager>>();
    kill_terminal_inner(&manager, &id);
    Ok(())
}

#[tauri::command(async)]
pub fn terminal_backlog(
    manager: State<'_, Mutex<PtyManager>>,
    id: String,
) -> Result<BacklogSnapshot, String> {
    let backlog = {
        let manager = manager.lock().map_err(|e| e.to_string())?;
        manager
            .terminals
            .get(&id)
            .map(|e| Arc::clone(&e.backlog))
            .ok_or_else(|| format!("terminal {} not found", id))?
    };
    let b = backlog.lock().unwrap_or_else(|e| e.into_inner());
    Ok(BacklogSnapshot {
        data: String::from_utf8_lossy(&b.buf).into_owned(),
        total: b.total,
    })
}

#[tauri::command(async)]
pub fn running_terminals(
    manager: State<'_, Mutex<PtyManager>>,
) -> Result<Vec<RunningTerminal>, String> {
    let manager = manager.lock().map_err(|e| e.to_string())?;
    Ok(manager
        .terminals
        .iter()
        .map(|(id, e)| RunningTerminal {
            id: id.clone(),
            seq: e.seq,
        })
        .collect())
}

#[cfg(unix)]
fn command_available(id: &str) -> bool {
    std::process::Command::new(user_shell())
        .args(["-l", "-c", &format!("command -v {}", id)])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(windows)]
fn command_available(id: &str) -> bool {
    find_on_path(id).is_some()
}

#[tauri::command(async)]
pub fn detect_agents() -> Vec<AgentInfo> {
    let candidates: [(&str, &str); 6] = [
        ("claude", "Claude"),
        ("codex", "Codex"),
        ("opencode", "OpenCode"),
        ("kimi", "Kimi"),
        ("gemini", "Gemini"),
        ("aider", "Aider"),
    ];
    let mut handles = Vec::new();
    for (id, label) in candidates {
        handles.push(std::thread::spawn(move || {
            let available = command_available(id);
            AgentInfo {
                id: id.to_string(),
                label: label.to_string(),
                available,
            }
        }));
    }
    let mut agents: Vec<AgentInfo> = handles.into_iter().filter_map(|h| h.join().ok()).collect();
    agents.push(AgentInfo {
        id: "shell".into(),
        label: "Shell".into(),
        available: true,
    });
    agents
}

#[cfg(test)]
mod notif_tests {
    use super::extract_notifications;

    #[test]
    fn bel_uses_last_output_line() {
        let (count, messages) = extract_notifications(b"\x07", b"12 passed, 0 failed\r\n\x07");
        assert_eq!(count, 1);
        assert_eq!(messages, vec!["12 passed, 0 failed".to_string()]);
    }

    #[test]
    fn bel_burst_yields_single_message() {
        let (count, messages) = extract_notifications(b"\x07\x07\x07", b"done\r\n");
        assert_eq!(count, 3);
        assert_eq!(messages.len(), 1);
    }

    #[test]
    fn osc9_carries_message() {
        let (count, messages) = extract_notifications(b"\x1b]9;Build finished\x07", b"");
        assert_eq!(count, 1);
        assert_eq!(messages, vec!["Build finished".to_string()]);
    }

    #[test]
    fn osc777_splits_title_and_body() {
        let (count, messages) =
            extract_notifications(b"\x1b]777;notify;Tests;12 passed\x1b\\", b"");
        assert_eq!(count, 1);
        assert_eq!(messages, vec!["Tests: 12 passed".to_string()]);
    }

    #[test]
    fn osc99_uses_payload_after_metadata() {
        let (count, messages) = extract_notifications(b"\x1b]99;i=1:d=0;Hello\x07", b"");
        assert_eq!(count, 1);
        assert_eq!(messages, vec!["Hello".to_string()]);
    }

    #[test]
    fn title_osc_terminator_bel_is_not_counted() {
        let (count, messages) = extract_notifications(b"\x1b]0;my title\x07", b"");
        assert_eq!(count, 0);
        assert!(messages.is_empty());
    }

    #[test]
    fn empty_tail_falls_back_to_generic_text() {
        let (count, messages) = extract_notifications(b"\x07", b"\r\n");
        assert_eq!(count, 1);
        assert_eq!(messages, vec!["Terminal notification".to_string()]);
    }
}

#[cfg(test)]
mod ctx_tests {
    use super::detect_context_used;

    #[test]
    fn opencode_footer() {
        assert_eq!(detect_context_used("some output 12.3K (42%) $0.05"), Some(42));
        assert_eq!(detect_context_used("999 (100%)"), Some(100));
        assert_eq!(detect_context_used("0 (0%)"), Some(0));
        assert_eq!(detect_context_used("hello (95%) no number"), None);
        assert_eq!(detect_context_used("42% context left"), Some(58));
        assert_eq!(detect_context_used("12.0k / 200k tokens"), Some(6));
        assert_eq!(detect_context_used("random 50% nothing"), None);
        // most recent indicator wins
        assert_eq!(detect_context_used("10% context left then 5K (33%)"), Some(33));
        assert_eq!(detect_context_used("5K (33%) then 10% context left"), Some(90));
    }

    #[test]
    fn unicode_near_keywords_does_not_panic() {
        // Box-drawing / emoji / CJK around the keyword must not panic on
        // char-boundary slicing.
        assert_eq!(detect_context_used("╭─░▒▓ 42% context left ▓▒░─╮"), Some(58));
        assert_eq!(detect_context_used("🚀🚀 12.0k / 200k tokens 🚀"), Some(6));
        assert_eq!(detect_context_used("コンテキスト 30% context used"), Some(30));
        assert_eq!(detect_context_used("│ 88% context left │"), Some(12));
        assert_eq!(detect_context_used("no indicators ░░░"), None);
    }
}
