use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

static NEXT_WS_ID: AtomicU64 = AtomicU64::new(1);

struct SaveRequest {
    path: PathBuf,
    json: String,
}

static SAVE_TX: OnceLock<Sender<SaveRequest>> = OnceLock::new();

/// Writes `json` to `path` atomically (temp file + rename) so a crash
/// mid-write can never leave a truncated/corrupt store behind.
fn write_atomic(path: &std::path::Path, json: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Background writer: coalesces save requests and flushes to disk 150ms after
/// the last change, so mutations never do blocking disk I/O on a caller thread.
fn save_channel() -> &'static Sender<SaveRequest> {
    SAVE_TX.get_or_init(|| {
        let (tx, rx) = channel::<SaveRequest>();
        std::thread::spawn(move || {
            while let Ok(mut req) = rx.recv() {
                loop {
                    match rx.recv_timeout(Duration::from_millis(150)) {
                        Ok(newer) => req = newer,
                        Err(_) => break,
                    }
                }
                if let Err(e) = write_atomic(&req.path, &req.json) {
                    eprintln!("failed to save workspaces: {}", e);
                }
            }
        });
        tx
    })
}

pub fn bump_next_id(id: &str) {
    if let Some(n) = id.strip_prefix("ws-").and_then(|s| s.parse::<u64>().ok()) {
        NEXT_WS_ID.fetch_max(n.saturating_add(1), Ordering::SeqCst);
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct TerminalMeta {
    pub id: String,
    pub command: String,
    #[serde(default)]
    pub width: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub cwd: String,
    #[serde(default)]
    pub terminals: Vec<TerminalMeta>,
}

#[derive(Default)]
pub struct WorkspaceStore {
    pub workspaces: Vec<Workspace>,
    pub save_path: Option<PathBuf>,
}

impl WorkspaceStore {
    pub fn load(path: PathBuf) -> Self {
        let workspaces = match std::fs::read_to_string(&path) {
            Ok(s) => match serde_json::from_str::<Vec<Workspace>>(&s) {
                Ok(ws) => ws,
                Err(e) => {
                    // Never silently wipe the user's data: keep the corrupt
                    // file around for inspection instead of overwriting it.
                    eprintln!(
                        "workspaces store is corrupt ({}); backing up to .bak and starting fresh",
                        e
                    );
                    let _ = std::fs::rename(&path, path.with_extension("json.bak"));
                    Vec::new()
                }
            },
            Err(_) => Vec::new(),
        };
        let mut store = Self {
            workspaces,
            save_path: Some(path),
        };
        store.validate();
        store
    }

    /// Drops malformed entries and clamps out-of-range values, so a
    /// hand-edited or corrupted store can never panic or break the layout.
    fn validate(&mut self) {
        let mut seen_ws = std::collections::HashSet::new();
        self.workspaces
            .retain(|w| !w.id.is_empty() && seen_ws.insert(w.id.clone()));
        for w in &mut self.workspaces {
            let mut seen_t = std::collections::HashSet::new();
            w.terminals
                .retain(|t| !t.id.is_empty() && seen_t.insert(t.id.clone()));
            for t in &mut w.terminals {
                t.width = t
                    .width
                    .filter(|v| v.is_finite())
                    .map(|v| v.clamp(15.0, 100.0));
            }
        }
    }

    pub fn save(&self) {
        let Some(path) = &self.save_path else { return };
        if let Ok(json) = serde_json::to_string_pretty(&self.workspaces) {
            let _ = save_channel().send(SaveRequest {
                path: path.clone(),
                json,
            });
        }
    }

    /// Synchronous, un-debounced save for shutdown, so the final state is
    /// never lost when the app exits within the 150ms debounce window.
    pub fn save_now(&self) {
        let Some(path) = &self.save_path else { return };
        match serde_json::to_string_pretty(&self.workspaces) {
            Ok(json) => {
                if let Err(e) = write_atomic(path, &json) {
                    eprintln!("failed to save workspaces on exit: {}", e);
                }
            }
            Err(e) => eprintln!("failed to serialize workspaces on exit: {}", e),
        }
    }

    pub fn create(&mut self, name: String, cwd: String) -> Workspace {
        let cwd = if cwd.trim().is_empty() {
            std::env::var("HOME").unwrap_or_else(|_| "/".to_string())
        } else {
            cwd
        };
        let ws = Workspace {
            id: format!("ws-{}", NEXT_WS_ID.fetch_add(1, Ordering::SeqCst)),
            name: if name.trim().is_empty() {
                "workspace".into()
            } else {
                name
            },
            cwd,
            terminals: Vec::new(),
        };
        self.workspaces.push(ws.clone());
        self.save();
        ws
    }

    pub fn remove(&mut self, id: &str) -> Option<Workspace> {
        let idx = self.workspaces.iter().position(|w| w.id == id)?;
        let ws = self.workspaces.remove(idx);
        self.save();
        Some(ws)
    }

    pub fn get(&self, id: &str) -> Option<&Workspace> {
        self.workspaces.iter().find(|w| w.id == id)
    }

    /// Returns false when the workspace no longer exists (e.g. it was closed
    /// while a terminal was being spawned), so the caller can roll back.
    pub fn add_terminal(&mut self, ws_id: &str, meta: TerminalMeta) -> bool {
        let Some(ws) = self.workspaces.iter_mut().find(|w| w.id == ws_id) else {
            return false;
        };
        if let Some(existing) = ws.terminals.iter_mut().find(|t| t.id == meta.id) {
            existing.command = meta.command.clone();
        } else {
            ws.terminals.push(meta);
        }
        self.save();
        true
    }

    pub fn remove_terminal(&mut self, terminal_id: &str) {
        for ws in self.workspaces.iter_mut() {
            ws.terminals.retain(|t| t.id != terminal_id);
        }
        self.save();
    }

    pub fn rename(&mut self, id: &str, name: String) {
        let name = name.trim().to_string();
        if name.is_empty() {
            return;
        }
        if let Some(ws) = self.workspaces.iter_mut().find(|w| w.id == id) {
            ws.name = name;
        }
        self.save();
    }

    pub fn reorder(&mut self, ws_id: &str, order: &[String]) {
        if let Some(ws) = self.workspaces.iter_mut().find(|w| w.id == ws_id) {
            let mut remaining = std::mem::take(&mut ws.terminals);
            let mut sorted = Vec::with_capacity(remaining.len());
            for id in order {
                if let Some(pos) = remaining.iter().position(|t| &t.id == id) {
                    sorted.push(remaining.remove(pos));
                }
            }
            sorted.extend(remaining);
            ws.terminals = sorted;
        }
        self.save();
    }

    pub fn set_width(&mut self, ws_id: &str, terminal_id: &str, width: f64) {
        if let Some(ws) = self.workspaces.iter_mut().find(|w| w.id == ws_id) {
            if let Some(t) = ws.terminals.iter_mut().find(|t| t.id == terminal_id) {
                t.width = Some(width.clamp(15.0, 100.0));
            }
        }
        self.save();
    }
}

#[tauri::command(async)]
pub fn create_workspace(
    store: State<'_, Mutex<WorkspaceStore>>,
    name: String,
    cwd: String,
) -> Result<Workspace, String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    Ok(store.create(name, cwd))
}

#[tauri::command(async)]
pub fn list_workspaces(store: State<'_, Mutex<WorkspaceStore>>) -> Result<Vec<Workspace>, String> {
    let store = store.lock().map_err(|e| e.to_string())?;
    Ok(store.workspaces.clone())
}

#[tauri::command(async)]
pub fn rename_workspace(
    store: State<'_, Mutex<WorkspaceStore>>,
    id: String,
    name: String,
) -> Result<(), String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    store.rename(&id, name);
    Ok(())
}

#[tauri::command(async)]
pub fn reorder_terminals(
    store: State<'_, Mutex<WorkspaceStore>>,
    ws_id: String,
    order: Vec<String>,
) -> Result<(), String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    store.reorder(&ws_id, &order);
    Ok(())
}

#[tauri::command(async)]
pub fn set_terminal_width(
    store: State<'_, Mutex<WorkspaceStore>>,
    ws_id: String,
    terminal_id: String,
    width: f64,
) -> Result<(), String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    store.set_width(&ws_id, &terminal_id, width);
    Ok(())
}

#[tauri::command(async)]
pub fn close_workspace(app: AppHandle, id: String) -> Result<(), String> {
    let store = app.state::<Mutex<WorkspaceStore>>();
    let terminals = {
        let mut store = store.lock().map_err(|e| e.to_string())?;
        store.remove(&id).map(|ws| ws.terminals)
    };
    if let Some(terminals) = terminals {
        let manager = app.state::<Mutex<crate::pty::PtyManager>>();
        for t in terminals {
            crate::pty::kill_terminal_inner(&manager, &t.id);
        }
    }
    Ok(())
}

/// Current git branch for a workspace directory, or the short commit hash
/// when HEAD is detached. None when the directory is not a git work tree.
#[tauri::command(async)]
pub fn git_branch(cwd: String) -> Option<String> {
    fn git(cwd: &str, args: &[&str]) -> Option<String> {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(cwd)
            .args(args)
            .env("GIT_OPTIONAL_LOCKS", "0")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if s.is_empty() { None } else { Some(s) }
    }
    git(&cwd, &["branch", "--show-current"])
        .or_else(|| git(&cwd, &["rev-parse", "--short", "HEAD"]))
}
