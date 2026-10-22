//! Moves a terminal's output from the PTY to the window: one thread drains
//! the PTY, another coalesces chunks into paced `pty-output-<id>` events and
//! runs the side-channel scans (notifications, titles, context usage, dev
//! server URLs).

use serde::Serialize;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Runtime};

use super::dev_server::{detect_dev_server_urls, DevServerPayload};
use super::output_scan::{
    detect_context_used, extract_notifications, scan_titles, strip_ansi, take_decodable,
};
use super::Backlog;
use crate::scrollback::ScrollbackStore;
use crate::sync::LockExt;

/// Size of one read from the PTY.
const READ_BUFFER_BYTES: usize = 16 * 1024;
/// Pacing of output events (about 60 per second).
const FLUSH_INTERVAL: Duration = Duration::from_millis(16);
/// Pending output this large is emitted without waiting for the pacing.
const FORCE_FLUSH_BYTES: usize = 64 * 1024;
/// How often the recent output is scanned for dev servers and context usage.
const SCAN_INTERVAL: Duration = Duration::from_millis(250);
/// Recent output kept for the notification fallback and the periodic scans.
const RAW_TAIL_BYTES: usize = 8 * 1024;

#[derive(Serialize, Clone)]
pub struct OutputChunk {
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

/// Where a terminal's output is persisted, and the two switches (this
/// terminal's and the app-wide one) that must both be on for it to be.
pub(super) struct DurableScrollback {
    pub store: Arc<ScrollbackStore>,
    pub is_terminal_enabled: Arc<AtomicBool>,
    pub is_app_enabled: Arc<AtomicBool>,
}

pub(super) fn spawn_output_pump<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    workspace_id: &str,
    mut reader: Box<dyn Read + Send>,
    backlog: Arc<Mutex<Backlog>>,
    scrollback: DurableScrollback,
) {
    let (chunk_tx, chunk_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let reader_id = id.to_string();
    std::thread::spawn(move || {
        let mut buf = [0u8; READ_BUFFER_BYTES];
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

    let output_event = format!("pty-output-{}", id);
    let notif_id = id.to_string();
    let notif_ws = workspace_id.to_string();
    let app = app.clone();
    std::thread::spawn(move || {
        let mut pending: Vec<u8> = Vec::new();
        let mut raw_tail: Vec<u8> = Vec::new();
        let mut title_buf: Vec<u8> = Vec::new();
        let mut title_last: Option<String> = None;
        let mut ctx_last: Option<u8> = None;
        let mut dev_servers_seen: Vec<String> = Vec::new();
        let mut ctx_last_check = Instant::now();
        let mut last_flush = Instant::now()
            .checked_sub(FLUSH_INTERVAL)
            .unwrap_or_else(Instant::now);
        let mut process = |s: &str| {
            raw_tail.extend_from_slice(s.as_bytes());
            if raw_tail.len() > RAW_TAIL_BYTES {
                let cut = raw_tail.len() - RAW_TAIL_BYTES;
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
            if ctx_last_check.elapsed() >= SCAN_INTERVAL {
                ctx_last_check = Instant::now();
                let plain = strip_ansi(&String::from_utf8_lossy(&raw_tail));
                for url in detect_dev_server_urls(&plain) {
                    if !dev_servers_seen.contains(&url) {
                        dev_servers_seen.push(url.clone());
                        let _ = app.emit(
                            "terminal-dev-server",
                            DevServerPayload {
                                id: notif_id.clone(),
                                workspace_id: notif_ws.clone(),
                                url,
                            },
                        );
                    }
                }
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
                let mut b = backlog.lock_or_recover();
                b.push(&s);
                b.total
            };
            if scrollback.is_terminal_enabled.load(Ordering::SeqCst)
                && scrollback.is_app_enabled.load(Ordering::SeqCst)
            {
                if let Err(error) = scrollback.store.append(&notif_id, s.as_bytes()) {
                    eprintln!("failed to persist scrollback for {}: {}", notif_id, error);
                }
            }
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
                let wait = FLUSH_INTERVAL.saturating_sub(last_flush.elapsed());
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
                    if pending.len() < FORCE_FLUSH_BYTES && last_flush.elapsed() < FLUSH_INTERVAL {
                        continue;
                    }
                }
                In::Tick => {}
                In::Closed => {
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
                last_flush = Instant::now();
                continue;
            };
            process(&s);
            emit_output(s);
            last_flush = Instant::now();
        }
    });
}
