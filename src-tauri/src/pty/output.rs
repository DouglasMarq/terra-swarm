use serde::Serialize;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, TryRecvError};
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

const READ_BUFFER_BYTES: usize = 16 * 1024;
const FLUSH_INTERVAL: Duration = Duration::from_millis(16);
const FORCE_FLUSH_BYTES: usize = 64 * 1024;
const SCAN_INTERVAL: Duration = Duration::from_millis(250);
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

pub(super) struct DurableScrollback {
    pub store: Arc<ScrollbackStore>,
    pub is_terminal_enabled: Arc<AtomicBool>,
    pub is_app_enabled: Arc<AtomicBool>,
}

#[derive(Clone, Copy)]
pub(super) struct TerminalIds<'a> {
    pub id: &'a str,
    pub workspace_id: &'a str,
}

pub(super) struct OutputPipe {
    pub reader: Box<dyn Read + Send>,
    pub backlog: Arc<Mutex<Backlog>>,
    pub scrollback: DurableScrollback,
}

pub(super) fn spawn_output_pump<R: Runtime>(
    app: &AppHandle<R>,
    terminal: TerminalIds<'_>,
    pipe: OutputPipe,
) {
    let chunk_rx = spawn_reader(pipe.reader, terminal.id.to_string());
    let mut scanner = SideChannelScanner::new(app.clone(), terminal);
    let sink = OutputSink {
        app: app.clone(),
        event: format!("pty-output-{}", terminal.id),
        id: terminal.id.to_string(),
        backlog: pipe.backlog,
        scrollback: pipe.scrollback,
    };
    std::thread::spawn(move || {
        pace_chunks(&chunk_rx, |text| {
            scanner.scan(&text);
            sink.emit(text);
        });
    });
}

fn spawn_reader(mut reader: Box<dyn Read + Send>, id: String) -> Receiver<Vec<u8>> {
    let (chunk_tx, chunk_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buffer = [0u8; READ_BUFFER_BYTES];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read_bytes) => {
                    if chunk_tx.send(buffer[..read_bytes].to_vec()).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    eprintln!("pty reader for {} failed: {}", id, error);
                    break;
                }
            }
        }
    });
    chunk_rx
}

enum Paced {
    Chunk(Vec<u8>),
    Tick,
    Closed,
}

fn pace_chunks(chunk_rx: &Receiver<Vec<u8>>, mut flush: impl FnMut(String)) {
    let mut pending: Vec<u8> = Vec::new();
    let mut last_flush = Instant::now()
        .checked_sub(FLUSH_INTERVAL)
        .unwrap_or_else(Instant::now);
    loop {
        let wait =
            (!pending.is_empty()).then(|| FLUSH_INTERVAL.saturating_sub(last_flush.elapsed()));
        match next_input(chunk_rx, wait) {
            Paced::Chunk(chunk) => {
                pending.extend_from_slice(&chunk);
                if pending.len() < FORCE_FLUSH_BYTES && last_flush.elapsed() < FLUSH_INTERVAL {
                    continue;
                }
            }
            Paced::Tick => {}
            Paced::Closed => {
                if !pending.is_empty() {
                    flush(String::from_utf8_lossy(&pending).into_owned());
                }
                return;
            }
        }
        if let Some(text) = take_decodable(&mut pending) {
            flush(text);
        }
        last_flush = Instant::now();
    }
}

fn next_input(chunk_rx: &Receiver<Vec<u8>>, wait: Option<Duration>) -> Paced {
    let Some(wait) = wait else {
        return chunk_rx.recv().map_or(Paced::Closed, Paced::Chunk);
    };
    if wait.is_zero() {
        return match chunk_rx.try_recv() {
            Ok(chunk) => Paced::Chunk(chunk),
            Err(TryRecvError::Empty) => Paced::Tick,
            Err(TryRecvError::Disconnected) => Paced::Closed,
        };
    }
    match chunk_rx.recv_timeout(wait) {
        Ok(chunk) => Paced::Chunk(chunk),
        Err(RecvTimeoutError::Timeout) => Paced::Tick,
        Err(RecvTimeoutError::Disconnected) => Paced::Closed,
    }
}

struct OutputSink<R: Runtime> {
    app: AppHandle<R>,
    event: String,
    id: String,
    backlog: Arc<Mutex<Backlog>>,
    scrollback: DurableScrollback,
}

impl<R: Runtime> OutputSink<R> {
    fn emit(&self, text: String) {
        let total = {
            let mut backlog = self.backlog.lock_or_recover();
            backlog.push(&text);
            backlog.total
        };
        self.persist(&text);
        let _ = self
            .app
            .emit(&self.event, OutputChunk { data: text, total });
    }

    fn persist(&self, text: &str) {
        let is_enabled = self.scrollback.is_terminal_enabled.load(Ordering::SeqCst)
            && self.scrollback.is_app_enabled.load(Ordering::SeqCst);
        if !is_enabled {
            return;
        }
        if let Err(error) = self.scrollback.store.append(&self.id, text.as_bytes()) {
            eprintln!("failed to persist scrollback for {}: {}", self.id, error);
        }
    }
}

struct SideChannelScanner<R: Runtime> {
    app: AppHandle<R>,
    id: String,
    workspace_id: String,
    raw_tail: Vec<u8>,
    title_buf: Vec<u8>,
    title_last: Option<String>,
    ctx_last: Option<u8>,
    dev_servers_seen: Vec<String>,
    last_scan: Instant,
}

impl<R: Runtime> SideChannelScanner<R> {
    fn new(app: AppHandle<R>, terminal: TerminalIds<'_>) -> Self {
        Self {
            app,
            id: terminal.id.to_string(),
            workspace_id: terminal.workspace_id.to_string(),
            raw_tail: Vec::new(),
            title_buf: Vec::new(),
            title_last: None,
            ctx_last: None,
            dev_servers_seen: Vec::new(),
            last_scan: Instant::now(),
        }
    }

    fn scan(&mut self, text: &str) {
        self.raw_tail.extend_from_slice(text.as_bytes());
        if self.raw_tail.len() > RAW_TAIL_BYTES {
            let cut = self.raw_tail.len() - RAW_TAIL_BYTES;
            self.raw_tail.drain(..cut);
        }
        self.scan_notifications(text);
        self.scan_title(text);
        if self.last_scan.elapsed() >= SCAN_INTERVAL {
            self.last_scan = Instant::now();
            let plain = strip_ansi(&String::from_utf8_lossy(&self.raw_tail));
            self.scan_dev_servers(&plain);
            self.scan_context(&plain);
        }
    }

    fn scan_notifications(&self, text: &str) {
        let (count, messages) = extract_notifications(text.as_bytes(), &self.raw_tail);
        if count == 0 {
            return;
        }
        let _ = self.app.emit(
            "terminal-notification",
            NotificationPayload {
                id: self.id.clone(),
                workspace_id: self.workspace_id.clone(),
                count,
                messages,
            },
        );
    }

    fn scan_title(&mut self, text: &str) {
        self.title_buf.extend_from_slice(text.as_bytes());
        let mut titles: Vec<String> = Vec::new();
        scan_titles(&mut self.title_buf, &mut titles);
        let Some(title) = titles.into_iter().last() else {
            return;
        };
        if self.title_last.as_deref() == Some(title.as_str()) {
            return;
        }
        self.title_last = Some(title.clone());
        let _ = self.app.emit(
            "terminal-title",
            TitlePayload {
                id: self.id.clone(),
                workspace_id: self.workspace_id.clone(),
                title,
            },
        );
    }

    fn scan_dev_servers(&mut self, plain: &str) {
        for url in detect_dev_server_urls(plain) {
            if self.dev_servers_seen.contains(&url) {
                continue;
            }
            self.dev_servers_seen.push(url.clone());
            let _ = self.app.emit(
                "terminal-dev-server",
                DevServerPayload {
                    id: self.id.clone(),
                    workspace_id: self.workspace_id.clone(),
                    url,
                },
            );
        }
    }

    fn scan_context(&mut self, plain: &str) {
        let Some(used) = detect_context_used(plain) else {
            return;
        };
        if self.ctx_last == Some(used) {
            return;
        }
        self.ctx_last = Some(used);
        let _ = self.app.emit(
            "terminal-context",
            ContextPayload {
                id: self.id.clone(),
                workspace_id: self.workspace_id.clone(),
                used,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::mpsc;
    use tauri::test::MockRuntime;
    use tauri::Listener;

    const PACING_TOLERANCE: Duration = Duration::from_millis(2);
    const EVENT_DEADLINE: Duration = Duration::from_secs(5);
    const TERMINAL: TerminalIds<'static> = TerminalIds {
        id: "t-pump",
        workspace_id: "w-pump",
    };

    fn queued(chunks: &[&[u8]]) -> Receiver<Vec<u8>> {
        let (chunk_tx, chunk_rx) = mpsc::channel();
        for chunk in chunks {
            chunk_tx.send(chunk.to_vec()).expect("queue chunk");
        }
        chunk_rx
    }

    fn flushed(chunk_rx: &Receiver<Vec<u8>>) -> Vec<String> {
        let mut flushes = Vec::new();
        pace_chunks(chunk_rx, |text| flushes.push(text));
        flushes
    }

    fn payloads_of(app: &tauri::App<MockRuntime>, event: &str) -> Receiver<serde_json::Value> {
        let (payload_tx, payload_rx) = mpsc::channel();
        app.listen(event.to_string(), move |event| {
            if let Ok(payload) = serde_json::from_str(event.payload()) {
                let _ = payload_tx.send(payload);
            }
        });
        payload_rx
    }

    fn scrollback(store: ScrollbackStore, is_enabled: bool) -> DurableScrollback {
        DurableScrollback {
            store: Arc::new(store),
            is_terminal_enabled: Arc::new(AtomicBool::new(is_enabled)),
            is_app_enabled: Arc::new(AtomicBool::new(true)),
        }
    }

    fn pump(
        app: &tauri::App<MockRuntime>,
        output: &[u8],
        scrollback: DurableScrollback,
    ) -> Arc<Mutex<Backlog>> {
        let backlog = Arc::new(Mutex::new(Backlog::from_bytes(Vec::new())));
        spawn_output_pump(
            app.handle(),
            TERMINAL,
            OutputPipe {
                reader: Box::new(std::io::Cursor::new(output.to_vec())),
                backlog: Arc::clone(&backlog),
                scrollback,
            },
        );
        backlog
    }

    #[test]
    fn given_a_burst_of_chunks_when_pacing_then_they_are_coalesced_without_losing_bytes() {
        let chunks: [&[u8]; 6] = [b"a", b"b", b"c", b"d", b"e", b"f"];

        let flushes = flushed(&queued(&chunks));

        assert_eq!(flushes.concat(), "abcdef");
        assert!(flushes.len() < chunks.len());
    }

    #[test]
    fn given_pending_output_reaching_the_force_threshold_when_pacing_then_it_is_flushed_at_once() {
        let large = vec![b'x'; FORCE_FLUSH_BYTES];

        let flushes = flushed(&queued(&[b"a", &large, b"z"]));

        assert_eq!(
            flushes,
            vec![
                "a".to_string(),
                String::from_utf8(large).expect("ascii"),
                "z".to_string()
            ]
        );
    }

    #[test]
    fn given_a_character_split_across_chunks_when_pacing_then_it_is_emitted_whole() {
        let flushes = flushed(&queued(&[&[0xC3], &[0xA9, b'!']]));

        assert_eq!(flushes.concat(), "é!");
    }

    #[test]
    fn given_output_right_after_a_flush_when_pacing_then_it_waits_for_the_flush_interval() {
        let (chunk_tx, chunk_rx) = mpsc::channel();
        let (flush_tx, flush_rx) = mpsc::channel();
        let pacer = std::thread::spawn(move || {
            pace_chunks(&chunk_rx, |text| {
                let _ = flush_tx.send((Instant::now(), text));
            })
        });

        chunk_tx.send(b"first".to_vec()).expect("send first");
        let (first_at, first) = flush_rx.recv_timeout(EVENT_DEADLINE).expect("first flush");
        chunk_tx.send(b"second".to_vec()).expect("send second");
        let (second_at, second) = flush_rx.recv_timeout(EVENT_DEADLINE).expect("second flush");
        drop(chunk_tx);
        pacer.join().expect("pacer thread");

        assert_eq!((first.as_str(), second.as_str()), ("first", "second"));
        assert!(second_at - first_at >= FLUSH_INTERVAL - PACING_TOLERANCE);
    }

    #[test]
    fn given_terminal_output_when_pumping_then_the_window_gets_the_output_and_its_title() {
        let app = tauri::test::mock_app();
        let outputs = payloads_of(&app, "pty-output-t-pump");
        let titles = payloads_of(&app, "terminal-title");
        let output = b"hello \x1b]0;Build\x07world";

        let backlog = pump(&app, output, scrollback(ScrollbackStore::default(), false));

        assert_eq!(
            outputs.recv_timeout(EVENT_DEADLINE).expect("output event"),
            json!({ "data": "hello \u{1b}]0;Build\u{7}world", "total": output.len() })
        );
        assert_eq!(
            titles.recv_timeout(EVENT_DEADLINE).expect("title event"),
            json!({ "id": "t-pump", "workspace_id": "w-pump", "title": "Build" })
        );
        assert_eq!(backlog.lock_or_recover().retained, output.to_vec());
    }

    #[test]
    fn given_durable_scrollback_on_when_pumping_then_the_output_is_persisted() {
        let root = std::env::temp_dir().join(format!(
            "terra-output-pump-{}-{}",
            std::process::id(),
            crate::clock::now_millis()
        ));
        std::fs::create_dir_all(&root).expect("scrollback root");
        let store = ScrollbackStore::from_root(root.clone());
        let app = tauri::test::mock_app();
        let outputs = payloads_of(&app, "pty-output-t-pump");

        pump(&app, b"persist me", scrollback(store.clone(), true));
        outputs.recv_timeout(EVENT_DEADLINE).expect("output event");

        assert_eq!(
            store.read("t-pump").expect("read scrollback"),
            b"persist me"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn given_durable_scrollback_off_for_the_terminal_when_pumping_then_nothing_is_persisted() {
        let root = std::env::temp_dir().join(format!(
            "terra-output-pump-off-{}-{}",
            std::process::id(),
            crate::clock::now_millis()
        ));
        std::fs::create_dir_all(&root).expect("scrollback root");
        let store = ScrollbackStore::from_root(root.clone());
        let app = tauri::test::mock_app();
        let outputs = payloads_of(&app, "pty-output-t-pump");

        pump(&app, b"keep me off disk", scrollback(store.clone(), false));
        outputs.recv_timeout(EVENT_DEADLINE).expect("output event");

        assert!(store.read("t-pump").expect("read scrollback").is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    struct FailingReader;

    impl Read for FailingReader {
        fn read(&mut self, _buffer: &mut [u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("pty closed"))
        }
    }

    fn due_scanner(app: &tauri::App<MockRuntime>) -> SideChannelScanner<MockRuntime> {
        let mut scanner = SideChannelScanner::new(app.handle().clone(), TERMINAL);
        scanner.last_scan = Instant::now()
            .checked_sub(SCAN_INTERVAL)
            .unwrap_or_else(Instant::now);
        scanner
    }

    #[test]
    fn given_a_reader_that_fails_when_reading_then_the_channel_closes_without_chunks() {
        let chunk_rx = spawn_reader(Box::new(FailingReader), "t-failing".into());

        assert!(chunk_rx.recv_timeout(EVENT_DEADLINE).is_err());
    }

    #[test]
    fn given_a_dev_server_banner_and_a_context_footer_when_scanning_then_each_is_announced_once() {
        let app = tauri::test::mock_app();
        let servers = payloads_of(&app, "terminal-dev-server");
        let contexts = payloads_of(&app, "terminal-context");
        let mut scanner = due_scanner(&app);

        scanner.scan("  Local:   http://localhost:5173/\n12.3K (42%) $0.05\n");
        scanner.last_scan = Instant::now()
            .checked_sub(SCAN_INTERVAL)
            .unwrap_or_else(Instant::now);
        scanner.scan("again\n");

        let server = servers.recv_timeout(EVENT_DEADLINE).expect("dev server");
        assert_eq!(server["url"], json!("http://localhost:5173/"));
        assert_eq!(server["workspace_id"], json!("w-pump"));
        let context = contexts.recv_timeout(EVENT_DEADLINE).expect("context");
        assert_eq!(context["used"], json!(42));
        assert_eq!(scanner.dev_servers_seen, vec!["http://localhost:5173/"]);
        assert_eq!(scanner.ctx_last, Some(42));
        assert!(servers.try_recv().is_err());
        assert!(contexts.try_recv().is_err());
    }

    #[test]
    fn given_more_output_than_the_tail_when_scanning_then_only_the_latest_bytes_are_kept() {
        let app = tauri::test::mock_app();
        let mut scanner = SideChannelScanner::new(app.handle().clone(), TERMINAL);

        scanner.scan(&"x".repeat(RAW_TAIL_BYTES + 10));

        assert_eq!(scanner.raw_tail.len(), RAW_TAIL_BYTES);
    }

    #[test]
    fn given_the_same_title_twice_when_scanning_then_it_is_announced_once() {
        let app = tauri::test::mock_app();
        let titles = payloads_of(&app, "terminal-title");
        let mut scanner = SideChannelScanner::new(app.handle().clone(), TERMINAL);

        scanner.scan("\u{1b}]0;Build\u{7}");
        scanner.scan("\u{1b}]0;Build\u{7}");

        let title = titles.recv_timeout(EVENT_DEADLINE).expect("title");
        assert_eq!(title["title"], json!("Build"));
        assert!(titles.try_recv().is_err());
    }

    #[test]
    fn given_a_scrollback_store_that_cannot_write_when_emitting_then_the_output_still_reaches_the_window(
    ) {
        let blocker = std::env::temp_dir().join(format!(
            "terra-output-blocked-{}-{}",
            std::process::id(),
            crate::clock::now_millis()
        ));
        std::fs::write(&blocker, "not a directory").expect("blocking file");
        let app = tauri::test::mock_app();
        let outputs = payloads_of(&app, "pty-output-t-pump");

        let backlog = pump(
            &app,
            b"still shown",
            scrollback(ScrollbackStore::from_root(blocker.clone()), true),
        );

        let output = outputs.recv_timeout(EVENT_DEADLINE).expect("output event");
        assert_eq!(output["data"], json!("still shown"));
        assert_eq!(backlog.lock_or_recover().total, 11);
        let _ = std::fs::remove_file(blocker);
    }
}
