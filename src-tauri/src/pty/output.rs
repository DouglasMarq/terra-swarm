//! Moves a terminal's output from the PTY to the window: one thread drains
//! the PTY, another coalesces chunks into paced `pty-output-<id>` events and
//! runs the side-channel scans (notifications, titles, context usage).

use serde::Serialize;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Runtime};

use super::output_scan::{detect_context_used, extract_notifications, scan_titles, strip_ansi, take_decodable};
use super::Backlog;
use crate::scrollback::ScrollbackStore;

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

#[allow(clippy::too_many_arguments)]
pub(super) fn spawn_output_pump<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    workspace_id: &str,
    mut reader: Box<dyn Read + Send>,
    backlog: Arc<Mutex<Backlog>>,
    scrollback: Arc<ScrollbackStore>,
    scrollback_enabled: Arc<AtomicBool>,
    durable_scrollback_enabled: Arc<AtomicBool>,
) {
    // Reader thread: drains the PTY as fast as the child produces data so
    // the kernel buffer never fills and the child never blocks on write().
    let (chunk_tx, chunk_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let reader_id = id.to_string();
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
    let notif_id = id.to_string();
    let notif_ws = workspace_id.to_string();
    let app = app.clone();
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
            if scrollback_enabled.load(Ordering::SeqCst)
                && durable_scrollback_enabled.load(Ordering::SeqCst)
            {
                if let Err(error) = scrollback.append(&notif_id, s.as_bytes()) {
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
                    if pending.len() < FORCE_FLUSH && last_flush.elapsed() < flush_interval {
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
