use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

pub mod agents;
pub mod dev_server;
mod output;
mod output_scan;
#[cfg(unix)]
mod process_group;
pub mod shell;

#[cfg(unix)]
use process_group::ProcessGroup;

use agents::is_command_available;
use shell::resolve_shell;
#[cfg(windows)]
use shell::{shell_flavor, ShellFlavor};

use crate::agent_catalog;
use crate::ipc_error::{IpcError, IpcErrorCode};
use crate::mcp::connect::{LaunchRequest, McpLaunch};
use crate::mcp::launch::Quoting;
use crate::mcp::{McpHub, McpLease};
use crate::roles::Role;
use crate::scrollback::ScrollbackStore;
use crate::sync::LockExt;
use crate::workspace::{change_and_save, TerminalMeta, WorkspaceStore};
use crate::worktree::{NewWorktree, WorktreeInfo};

static NEXT_TERMINAL_ID: AtomicU64 = AtomicU64::new(1);
static SPAWN_SEQ: AtomicU64 = AtomicU64::new(1);

pub fn bump_next_terminal_id(id: &str) {
    if let Some(number) = id
        .strip_prefix("t-")
        .and_then(|digits| digits.parse::<u64>().ok())
    {
        NEXT_TERMINAL_ID.fetch_max(number.saturating_add(1), Ordering::SeqCst);
    }
}

const BACKLOG_CAP_BYTES: usize = 256 * 1024;
const MIN_PTY_DIMENSION: u16 = 2;
const INPUT_QUEUE_CAPACITY: usize = 256;
const DEMO_COLS: u16 = 100;
const DEMO_ROWS: u16 = 30;
const DEMO_AGENT_COMMANDS: [&str; 4] = ["claude", "codex", "opencode", "kimi"];
const DEMO_AGENT_COUNT: usize = 2;

pub struct Backlog {
    retained: Vec<u8>,
    total: u64,
}

impl Backlog {
    fn from_bytes(data: Vec<u8>) -> Self {
        let total = byte_count(&data);
        let retained = if data.len() > BACKLOG_CAP_BYTES {
            data[data.len() - BACKLOG_CAP_BYTES..].to_vec()
        } else {
            data
        };
        Self { retained, total }
    }

    fn push(&mut self, text: &str) {
        self.retained.extend_from_slice(text.as_bytes());
        if self.retained.len() > BACKLOG_CAP_BYTES {
            let cut = self.retained.len() - BACKLOG_CAP_BYTES;
            self.retained.drain(..cut);
        }
        self.total += byte_count(text.as_bytes());
    }
}

fn byte_count(bytes: &[u8]) -> u64 {
    u64::try_from(bytes.len()).unwrap_or(u64::MAX)
}

pub struct PtyEntry {
    pub input: std::sync::mpsc::SyncSender<Vec<u8>>,
    pub master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    pub killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
    pub pid: Option<u32>,
    pub last_size: Arc<Mutex<(u16, u16)>>,
    pub seq: u64,
    pub is_reaped: Arc<AtomicBool>,
    pub backlog: Arc<Mutex<Backlog>>,
    pub is_scrollback_enabled: Arc<AtomicBool>,
    pub _mcp_lease: Option<McpLease>,
    #[cfg(unix)]
    process_group: Option<Arc<ProcessGroup>>,
}

fn kill_entry(entry: PtyEntry, should_disable_scrollback: bool) {
    if should_disable_scrollback {
        entry.is_scrollback_enabled.store(false, Ordering::SeqCst);
    }
    #[cfg(unix)]
    if let Some(group) = &entry.process_group {
        group.kill();
        return;
    }
    if let Err(error) = entry.killer.lock_or_recover().kill() {
        eprintln!("failed to kill a terminal process: {}", error);
    }
}

pub struct PtyManager {
    terminals: HashMap<String, PtyEntry>,
    spawning: HashSet<String>,
    scrollback: Arc<ScrollbackStore>,
    is_durable_scrollback_enabled: Arc<AtomicBool>,
}

impl Default for PtyManager {
    fn default() -> Self {
        Self {
            terminals: HashMap::new(),
            spawning: HashSet::new(),
            scrollback: Arc::new(ScrollbackStore::default()),
            is_durable_scrollback_enabled: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl PtyManager {
    pub fn with_scrollback_dir(path: std::path::PathBuf) -> Self {
        Self {
            terminals: HashMap::new(),
            spawning: HashSet::new(),
            scrollback: Arc::new(ScrollbackStore::from_root(path)),
            is_durable_scrollback_enabled: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn scrollback(&self) -> Arc<ScrollbackStore> {
        Arc::clone(&self.scrollback)
    }

    pub fn durable_scrollback_enabled(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.is_durable_scrollback_enabled)
    }

    pub fn set_durable_scrollback_enabled(&self, is_enabled: bool) {
        self.is_durable_scrollback_enabled
            .store(is_enabled, Ordering::SeqCst);
    }

    fn running_terminals(&self) -> Vec<RunningTerminal> {
        self.terminals
            .iter()
            .filter(|(_, entry)| !entry.is_reaped.load(Ordering::SeqCst))
            .map(|(id, entry)| RunningTerminal {
                id: id.clone(),
                seq: entry.seq,
            })
            .collect()
    }
}

#[derive(Serialize, Clone)]
pub struct ExitPayload {
    pub id: String,
    pub workspace_id: String,
    pub code: Option<u32>,
    pub seq: u64,
}

#[derive(Default, Debug, Clone)]
pub struct SpawnOptions {
    pub shell: Option<String>,
    pub args: Option<String>,
    pub env: HashMap<String, String>,
    pub should_use_worktree: bool,
    pub worktree_root: Option<std::path::PathBuf>,
    pub role: Option<crate::roles::Role>,
}

impl SpawnOptions {
    fn valid_env(&self) -> impl Iterator<Item = (&String, &String)> {
        self.env.iter().filter(|(key, value)| {
            !key.is_empty()
                && !key.contains('=')
                && !key.contains('\0')
                && !value.contains('\0')
                && !key.starts_with("TERRA_")
        })
    }
}

#[derive(Deserialize, Default, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LaunchExtras {
    #[serde(default)]
    pub args: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default, alias = "worktree")]
    pub should_use_worktree: bool,
    #[serde(default)]
    pub role: Option<crate::roles::Role>,
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

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRuntimeInfo {
    pub id: String,
    pub pid: Option<u32>,
    pub cols: u16,
    pub rows: u16,
    pub is_running: bool,
    pub is_reaped: bool,
    pub generation: u64,
}

struct RuntimeFacts<'a> {
    id: &'a str,
    pid: Option<u32>,
    cols: u16,
    rows: u16,
    generation: u64,
    is_reaped: bool,
}

fn unrecycled_pid(facts: &RuntimeFacts<'_>) -> Option<u32> {
    if facts.is_reaped {
        return None;
    }
    facts.pid
}

fn runtime_info_from_values(facts: RuntimeFacts<'_>) -> TerminalRuntimeInfo {
    TerminalRuntimeInfo {
        id: facts.id.to_string(),
        pid: unrecycled_pid(&facts),
        cols: facts.cols,
        rows: facts.rows,
        is_running: !facts.is_reaped,
        is_reaped: facts.is_reaped,
        generation: facts.generation,
    }
}

fn runtime_info_from_manager(
    manager: &PtyManager,
    id: &str,
) -> Result<Option<TerminalRuntimeInfo>, String> {
    let Some(entry) = manager.terminals.get(id) else {
        return Ok(None);
    };
    let (cols, rows) = *entry.last_size.lock_or_recover();
    Ok(Some(runtime_info_from_values(RuntimeFacts {
        id,
        pid: entry.pid,
        cols,
        rows,
        generation: entry.seq,
        is_reaped: entry.is_reaped.load(Ordering::SeqCst),
    })))
}

#[derive(Serialize, Clone)]
pub struct BacklogSnapshot {
    pub data: String,
    pub total: u64,
}

#[derive(Clone, Copy)]
pub struct SpawnRequest<'a> {
    pub workspace_id: &'a str,
    pub command: &'a str,
    pub cols: u16,
    pub rows: u16,
    pub terminal_id: Option<&'a str>,
    pub options: &'a SpawnOptions,
}

#[derive(Clone, Copy)]
pub struct Registries<'a> {
    pub manager: &'a Mutex<PtyManager>,
    pub store: &'a Mutex<WorkspaceStore>,
}

struct StoredTerminal {
    worktree: Option<WorktreeInfo>,
    role: Option<Role>,
    command: Option<String>,
}

#[derive(Clone, Copy)]
struct WorktreeTarget<'a> {
    repo_cwd: &'a str,
    workspace_id: &'a str,
    terminal_id: &'a str,
    options: &'a SpawnOptions,
}

#[derive(Clone, Copy)]
struct ProcessLaunch<'a> {
    id: &'a str,
    workspace_id: &'a str,
    seq: u64,
    cwd: &'a str,
    command: &'a str,
    role: Option<Role>,
    options: &'a SpawnOptions,
    cols: u16,
    rows: u16,
}

struct SpawnedProcess<'a> {
    launch: ProcessLaunch<'a>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    mcp_lease: Option<McpLease>,
}

struct TerminalIo {
    input: std::sync::mpsc::SyncSender<Vec<u8>>,
    backlog: Arc<Mutex<Backlog>>,
    is_scrollback_enabled: Arc<AtomicBool>,
}

type SharedKiller = Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>;

struct ExitWatch {
    id: String,
    workspace_id: String,
    seq: u64,
    killer: SharedKiller,
    is_reaped: Arc<AtomicBool>,
    #[cfg(unix)]
    process_group: Option<Arc<ProcessGroup>>,
}

pub fn spawn_terminal_inner<R: Runtime>(
    app: &AppHandle<R>,
    registries: Registries<'_>,
    request: SpawnRequest<'_>,
) -> Result<SpawnedTerminal, String> {
    let Registries { manager, store } = registries;
    let workspace_id = request.workspace_id.to_string();
    let cwd = workspace_cwd(store, &workspace_id)?;
    let id = allocate_terminal_id(request.terminal_id);
    let command = request.command.trim().to_string();
    let seq = SPAWN_SEQ.fetch_add(1, Ordering::SeqCst);
    ensure_not_owned_elsewhere(store, &id, &workspace_id)?;

    let _reservation = SpawnReservation::claim(manager, &id)?;

    let stored = stored_terminal(store, &workspace_id, &id);
    let role = stored.role.or(request.options.role);
    let target = WorktreeTarget {
        repo_cwd: &cwd,
        workspace_id: &workspace_id,
        terminal_id: &id,
        options: request.options,
    };
    let (worktree, created_worktree) = resolve_worktree(app, stored.worktree, target)?;
    let cwd = worktree.as_ref().map_or(cwd, |info| info.cwd.clone());

    let launch = ProcessLaunch {
        id: &id,
        workspace_id: &workspace_id,
        seq,
        cwd: &cwd,
        command: &command,
        role,
        options: request.options,
        cols: request.cols.max(MIN_PTY_DIMENSION),
        rows: request.rows.max(MIN_PTY_DIMENSION),
    };
    register_process(app, manager, spawn_process(app, launch)?)?;

    let meta = TerminalMeta {
        id: id.clone(),
        command: recorded_command(stored.command, command),
        width: None,
        pane_id: None,
        tab_id: None,
        group_id: None,
        is_suspended: false,
        worktree,
        role,
    };
    record_terminal(registries, &workspace_id, &meta)?;

    created_worktree.disarm();
    Ok(SpawnedTerminal { meta, seq })
}

fn record_terminal(
    registries: Registries<'_>,
    workspace_id: &str,
    meta: &TerminalMeta,
) -> Result<(), String> {
    let recorded = change_and_save(registries.store, |store| {
        if !store.can_add_terminal(workspace_id, &meta.id) {
            return Err(format!(
                "workspace {} unavailable or terminal {} belongs to another workspace",
                workspace_id, meta.id
            ));
        }
        store.record_terminal(workspace_id, meta.clone());
        Ok(())
    });
    if recorded.is_err() {
        kill_terminal_inner(registries.manager, &meta.id);
    }
    recorded
}

fn workspace_cwd(store: &Mutex<WorkspaceStore>, workspace_id: &str) -> Result<String, String> {
    store
        .lock_or_recover()
        .get(workspace_id)
        .map(|workspace| workspace.cwd.clone())
        .ok_or_else(|| format!("workspace {} not found", workspace_id))
}

fn allocate_terminal_id(forced_id: Option<&str>) -> String {
    let Some(forced_id) = forced_id else {
        return format!("t-{}", NEXT_TERMINAL_ID.fetch_add(1, Ordering::SeqCst));
    };
    bump_next_terminal_id(forced_id);
    forced_id.to_string()
}

fn ensure_not_owned_elsewhere(
    store: &Mutex<WorkspaceStore>,
    id: &str,
    workspace_id: &str,
) -> Result<(), String> {
    let store = store.lock_or_recover();
    match store.terminal_owner(id) {
        Some(owner) if owner != workspace_id => Err(format!(
            "terminal {} already belongs to workspace {}",
            id, owner
        )),
        _ => Ok(()),
    }
}

fn stored_terminal(store: &Mutex<WorkspaceStore>, workspace_id: &str, id: &str) -> StoredTerminal {
    store
        .lock_or_recover()
        .get(workspace_id)
        .and_then(|workspace| {
            workspace
                .terminals
                .iter()
                .find(|terminal| terminal.id == id)
        })
        .map_or(
            StoredTerminal {
                worktree: None,
                role: None,
                command: None,
            },
            |terminal| StoredTerminal {
                worktree: terminal.worktree.clone(),
                role: terminal.role,
                command: Some(terminal.command.clone()),
            },
        )
}

fn existing_worktree(existing: WorktreeInfo) -> Result<WorktreeInfo, String> {
    if !std::path::Path::new(&existing.cwd).is_dir() {
        return Err(format!(
            "the agent's worktree {} no longer exists",
            existing.path
        ));
    }
    Ok(existing)
}

fn resolve_worktree<R: Runtime>(
    app: &AppHandle<R>,
    stored: Option<WorktreeInfo>,
    target: WorktreeTarget<'_>,
) -> Result<(Option<WorktreeInfo>, CreatedWorktree), String> {
    if let Some(existing) = stored {
        return Ok((Some(existing_worktree(existing)?), CreatedWorktree(None)));
    }
    if !target.options.should_use_worktree {
        return Ok((None, CreatedWorktree(None)));
    }
    let info = new_worktree(app, target)?;
    Ok((Some(info.clone()), CreatedWorktree(Some(info))))
}

fn new_worktree<R: Runtime>(
    app: &AppHandle<R>,
    target: WorktreeTarget<'_>,
) -> Result<WorktreeInfo, String> {
    let root = match &target.options.worktree_root {
        Some(root) => root.clone(),
        None => app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join("worktrees"),
    };
    crate::worktree::create(NewWorktree {
        project_cwd: std::path::Path::new(target.repo_cwd),
        root: &root,
        workspace_id: target.workspace_id,
        terminal_id: target.terminal_id,
    })
}

fn spawn_process<'a, R: Runtime>(
    app: &AppHandle<R>,
    launch: ProcessLaunch<'a>,
) -> Result<SpawnedProcess<'a>, String> {
    let shell = resolve_shell(launch.options.shell.as_deref());
    let is_interactive = launch.command.is_empty() || launch.command == "shell";
    let command_with_agent_args = match launch.options.args.as_deref().map(str::trim) {
        Some(args) if !args.is_empty() && !is_interactive => format!("{} {}", launch.command, args),
        _ => launch.command.to_string(),
    };
    let mut mcp_launch = app.try_state::<Arc<McpHub>>().and_then(|hub| {
        hub.launch(LaunchRequest {
            terminal_id: launch.id,
            workspace_id: launch.workspace_id,
            command: &command_with_agent_args,
            role: launch.role,
            quoting: quoting_for(&shell),
        })
    });
    let run_command = mcp_launch.as_ref().map_or_else(
        || command_with_agent_args.clone(),
        |launch| launch.command.clone(),
    );
    let mut cmd = CommandBuilder::new(&shell);
    cmd.args(shell_args(&shell, is_interactive, &run_command));
    cmd.cwd(launch.cwd);
    apply_env(&mut cmd, launch.options, mcp_launch.as_ref());

    let pair = native_pty_system()
        .openpty(pty_size(launch.cols, launch.rows))
        .map_err(|error| error.to_string())?;
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|error| format!("failed to spawn `{}`: {}", launch.command, error))?;
    drop(pair.slave);
    Ok(SpawnedProcess {
        launch,
        master: pair.master,
        child,
        mcp_lease: mcp_launch.take().map(|launch| launch.lease),
    })
}

#[cfg(unix)]
fn quoting_for(_shell: &str) -> Quoting {
    Quoting::Posix
}

#[cfg(windows)]
fn quoting_for(shell: &str) -> Quoting {
    match shell_flavor(shell) {
        ShellFlavor::Posix => Quoting::Posix,
        _ => Quoting::Windows,
    }
}

#[cfg(unix)]
fn shell_args(_shell: &str, is_interactive: bool, run_command: &str) -> Vec<String> {
    posix_shell_args(is_interactive, run_command)
}

#[cfg(windows)]
fn shell_args(shell: &str, is_interactive: bool, run_command: &str) -> Vec<String> {
    match shell_flavor(shell) {
        ShellFlavor::PowerShell if is_interactive => vec!["-NoLogo".into()],
        ShellFlavor::PowerShell => vec!["-NoLogo".into(), "-Command".into(), run_command.into()],
        ShellFlavor::Cmd if is_interactive => Vec::new(),
        ShellFlavor::Cmd => vec!["/C".into(), run_command.into()],
        ShellFlavor::Posix => posix_shell_args(is_interactive, run_command),
    }
}

fn posix_shell_args(is_interactive: bool, run_command: &str) -> Vec<String> {
    if is_interactive {
        return vec!["-l".into(), "-i".into()];
    }
    vec!["-l".into(), "-c".into(), format!("exec {}", run_command)]
}

fn apply_env(cmd: &mut CommandBuilder, options: &SpawnOptions, mcp_launch: Option<&McpLaunch>) {
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "terra-swarm");
    for (key, value) in options.valid_env() {
        cmd.env(key, value);
    }
    override_with_terminal_identity(cmd, mcp_launch);
}

fn override_with_terminal_identity(cmd: &mut CommandBuilder, mcp_launch: Option<&McpLaunch>) {
    let Some(launch) = mcp_launch else {
        return;
    };
    for (key, value) in &launch.env {
        cmd.env(key, value);
    }
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn register_process<R: Runtime>(
    app: &AppHandle<R>,
    manager: &Mutex<PtyManager>,
    process: SpawnedProcess<'_>,
) -> Result<(), String> {
    let io = start_terminal_io(app, manager, &process)?;
    let SpawnedProcess {
        launch,
        master,
        child,
        mcp_lease,
    } = process;
    let pid = child.process_id();
    #[cfg(unix)]
    let process_group = pid.and_then(ProcessGroup::of_leader).map(Arc::new);
    let killer = Arc::new(Mutex::new(child.clone_killer()));
    let is_reaped = Arc::new(AtomicBool::new(false));
    let watch = ExitWatch {
        id: launch.id.to_string(),
        workspace_id: launch.workspace_id.to_string(),
        seq: launch.seq,
        killer: Arc::clone(&killer),
        is_reaped: Arc::clone(&is_reaped),
        #[cfg(unix)]
        process_group: process_group.clone(),
    };
    let entry = PtyEntry {
        input: io.input,
        master: Arc::new(Mutex::new(master)),
        killer,
        pid,
        last_size: Arc::new(Mutex::new((launch.cols, launch.rows))),
        seq: launch.seq,
        is_reaped,
        backlog: io.backlog,
        is_scrollback_enabled: io.is_scrollback_enabled,
        _mcp_lease: mcp_lease,
        #[cfg(unix)]
        process_group,
    };
    manager
        .lock_or_recover()
        .terminals
        .insert(launch.id.to_string(), entry);

    spawn_exit_monitor(app, child, watch);
    Ok(())
}

fn start_terminal_io<R: Runtime>(
    app: &AppHandle<R>,
    manager: &Mutex<PtyManager>,
    process: &SpawnedProcess<'_>,
) -> Result<TerminalIo, String> {
    let launch = process.launch;
    let is_scrollback_enabled = Arc::new(AtomicBool::new(true));
    let (scrollback, is_durable_scrollback_enabled) = {
        let manager = manager.lock_or_recover();
        (manager.scrollback(), manager.durable_scrollback_enabled())
    };
    let restored = restored_backlog(&scrollback, &is_durable_scrollback_enabled, launch.id);
    let backlog = Arc::new(Mutex::new(Backlog::from_bytes(restored)));
    let reader = process
        .master
        .try_clone_reader()
        .map_err(|error| error.to_string())?;
    let writer = process
        .master
        .take_writer()
        .map_err(|error| error.to_string())?;

    output::spawn_output_pump(
        app,
        output::TerminalIds {
            id: launch.id,
            workspace_id: launch.workspace_id,
        },
        output::OutputPipe {
            reader,
            backlog: Arc::clone(&backlog),
            scrollback: output::DurableScrollback {
                store: Arc::clone(&scrollback),
                is_terminal_enabled: Arc::clone(&is_scrollback_enabled),
                is_app_enabled: is_durable_scrollback_enabled,
            },
        },
    );
    Ok(TerminalIo {
        input: spawn_input_writer(writer),
        backlog,
        is_scrollback_enabled,
    })
}

fn restored_backlog(scrollback: &ScrollbackStore, is_enabled: &AtomicBool, id: &str) -> Vec<u8> {
    if !is_enabled.load(Ordering::SeqCst) {
        return Vec::new();
    }
    scrollback.read(id).unwrap_or_else(|error| {
        eprintln!("failed to read durable scrollback for {}: {}", id, error);
        Vec::new()
    })
}

fn spawn_input_writer(mut writer: Box<dyn Write + Send>) -> std::sync::mpsc::SyncSender<Vec<u8>> {
    let (input_tx, input_rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(INPUT_QUEUE_CAPACITY);
    std::thread::spawn(move || {
        while let Ok(data) = input_rx.recv() {
            if writer
                .write_all(&data)
                .and_then(|_| writer.flush())
                .is_err()
            {
                break;
            }
        }
    });
    input_tx
}

fn spawn_exit_monitor<R: Runtime>(
    app: &AppHandle<R>,
    mut child: Box<dyn Child + Send + Sync>,
    watch: ExitWatch,
) {
    let app = app.clone();
    std::thread::spawn(move || {
        #[cfg(unix)]
        if let Some(group) = &watch.process_group {
            group.wait_for_exit();
            group.kill_and_seal();
        }
        let code = match child.wait() {
            Ok(status) => Some(status.exit_code()),
            Err(error) => {
                eprintln!("failed to wait for terminal {}: {}", watch.id, error);
                None
            }
        };
        watch.is_reaped.store(true, Ordering::SeqCst);
        forget_exited_terminal(&app, &watch);
        let _ = app.emit(
            "terminal-exit",
            ExitPayload {
                id: watch.id,
                workspace_id: watch.workspace_id,
                code,
                seq: watch.seq,
            },
        );
    });
}

fn forget_exited_terminal<R: Runtime>(app: &AppHandle<R>, watch: &ExitWatch) {
    let Some(manager) = app.try_state::<Mutex<PtyManager>>() else {
        return;
    };
    let mut manager = manager.lock_or_recover();
    let is_current = manager
        .terminals
        .get(&watch.id)
        .is_some_and(|entry| Arc::ptr_eq(&entry.killer, &watch.killer));
    if is_current {
        manager.terminals.remove(&watch.id);
    }
}

fn recorded_command(existing_command: Option<String>, command: String) -> String {
    match existing_command {
        Some(original)
            if agent_catalog::is_resume_command(&command)
                && !agent_catalog::is_resume_command(&original) =>
        {
            original
        }
        _ if command.is_empty() => "shell".into(),
        _ => command,
    }
}

struct SpawnReservation<'a> {
    manager: &'a Mutex<PtyManager>,
    id: String,
}

impl<'a> SpawnReservation<'a> {
    fn claim(manager: &'a Mutex<PtyManager>, id: &str) -> Result<Self, String> {
        let mut guard = manager.lock_or_recover();
        if guard.terminals.contains_key(id) || !guard.spawning.insert(id.to_string()) {
            return Err(format!("terminal {} already running", id));
        }
        Ok(Self {
            manager,
            id: id.to_string(),
        })
    }
}

impl Drop for SpawnReservation<'_> {
    fn drop(&mut self) {
        self.manager.lock_or_recover().spawning.remove(&self.id);
    }
}

struct CreatedWorktree(Option<crate::worktree::WorktreeInfo>);

impl CreatedWorktree {
    fn disarm(mut self) {
        self.0 = None;
    }
}

impl Drop for CreatedWorktree {
    fn drop(&mut self) {
        if let Some(info) = self.0.take() {
            if let Err(error) = crate::worktree::remove(&info, true) {
                eprintln!("failed to clean up worktree {}: {}", info.path, error);
            }
        }
    }
}

// Each argument is a field of the `spawn_terminal` IPC contract (`src/lib/tauri/commands.ts`).
#[allow(clippy::too_many_arguments)]
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
    launch: Option<LaunchExtras>,
) -> Result<SpawnedTerminal, String> {
    let launch = launch.unwrap_or_default();
    let options = SpawnOptions {
        shell,
        args: launch.args,
        env: launch.env,
        should_use_worktree: launch.should_use_worktree,
        worktree_root: None,
        role: launch.role,
    };
    spawn_terminal_inner(
        &app,
        Registries {
            manager: &manager,
            store: &store,
        },
        SpawnRequest {
            workspace_id: &workspace_id,
            command: &command,
            cols,
            rows,
            terminal_id: terminal_id.as_deref(),
            options: &options,
        },
    )
}

pub fn demo_seed(app: &AppHandle) {
    let store = app.state::<Mutex<WorkspaceStore>>();
    let manager = app.state::<Mutex<PtyManager>>();
    let registries = Registries {
        manager: &manager,
        store: &store,
    };
    let picked: Vec<&str> = DEMO_AGENT_COMMANDS
        .into_iter()
        .filter(|command| is_command_available(command))
        .take(DEMO_AGENT_COUNT)
        .collect();
    let options = SpawnOptions::default();
    let spawn = |workspace_id: &str, command: &str| {
        let request = SpawnRequest {
            workspace_id,
            command,
            cols: DEMO_COLS,
            rows: DEMO_ROWS,
            terminal_id: None,
            options: &options,
        };
        if let Err(error) = spawn_terminal_inner(app, registries, request) {
            eprintln!("demo seed could not spawn `{}`: {}", command, error);
        }
    };
    let agents = store
        .lock_or_recover()
        .create("agents".into(), String::new());
    for command in picked {
        spawn(&agents.id, command);
    }
    let scratch = store
        .lock_or_recover()
        .create("scratch".into(), String::new());
    #[cfg(unix)]
    spawn(&scratch.id, "top");
    spawn(&scratch.id, "shell");
    let _ = app.emit("workspaces-changed", ());
}

#[tauri::command(async)]
pub fn write_terminal(
    manager: State<'_, Mutex<PtyManager>>,
    id: String,
    data: String,
) -> Result<(), IpcError> {
    let input = {
        let manager = manager.lock_or_recover();
        manager
            .terminals
            .get(&id)
            .map(|entry| entry.input.clone())
            .ok_or_else(|| format!("terminal {} not found", id))?
    };
    send_input(&input, &id, data)
}

fn send_input(
    input: &std::sync::mpsc::SyncSender<Vec<u8>>,
    id: &str,
    data: String,
) -> Result<(), IpcError> {
    match input.try_send(data.into_bytes()) {
        Ok(()) => Ok(()),
        Err(std::sync::mpsc::TrySendError::Full(_)) => Err(IpcError::new(
            IpcErrorCode::Busy,
            format!("terminal {} input busy", id),
        )),
        Err(std::sync::mpsc::TrySendError::Disconnected(_)) => Err(IpcError::new(
            IpcErrorCode::Other,
            format!("terminal {} input closed", id),
        )),
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
        let manager = manager.lock_or_recover();
        let entry = manager
            .terminals
            .get(&id)
            .ok_or_else(|| format!("terminal {} not found", id))?;
        (Arc::clone(&entry.master), Arc::clone(&entry.last_size))
    };
    let cols = cols.max(MIN_PTY_DIMENSION);
    let rows = rows.max(MIN_PTY_DIMENSION);
    {
        let last = last_size.lock_or_recover();
        if *last == (cols, rows) {
            return Ok(());
        }
    }
    let guard = master.lock_or_recover();
    guard
        .resize(pty_size(cols, rows))
        .map_err(|error| error.to_string())?;
    *last_size.lock_or_recover() = (cols, rows);
    Ok(())
}

pub fn kill_terminal_inner(manager: &Mutex<PtyManager>, id: &str) {
    let entry = manager.lock_or_recover().terminals.remove(id);
    if let Some(entry) = entry {
        kill_entry(entry, false);
    }
}

fn kill_terminal_inner_destructive(manager: &Mutex<PtyManager>, id: &str) {
    let entry = manager.lock_or_recover().terminals.remove(id);
    if let Some(entry) = entry {
        kill_entry(entry, true);
    }
}

pub fn kill_all(manager: &Mutex<PtyManager>) {
    let entries: Vec<PtyEntry> = manager
        .lock_or_recover()
        .terminals
        .drain()
        .map(|(_, entry)| entry)
        .collect();
    for entry in entries {
        kill_entry(entry, false);
    }
}

#[tauri::command(async)]
pub fn kill_terminal(app: AppHandle, id: String) -> Result<(), String> {
    let manager = app.state::<Mutex<PtyManager>>();
    kill_terminal_inner_destructive(&manager, &id);
    let scrollback = manager.lock_or_recover().scrollback();
    if let Err(error) = scrollback.remove(&id) {
        eprintln!("failed to remove durable scrollback for {}: {}", id, error);
    }
    let store = app.state::<Mutex<WorkspaceStore>>();
    let mut workspaces = store.lock_or_recover();
    workspaces.forget_terminal(&id);
    workspaces.save();
    Ok(())
}

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
    let (backlog, scrollback, is_durable_scrollback_enabled) = {
        let manager = manager.lock_or_recover();
        (
            manager
                .terminals
                .get(&id)
                .map(|entry| Arc::clone(&entry.backlog)),
            manager.scrollback(),
            manager.durable_scrollback_enabled(),
        )
    };
    if let Some(backlog) = backlog {
        let backlog = backlog.lock_or_recover();
        return Ok(BacklogSnapshot {
            data: String::from_utf8_lossy(&backlog.retained).into_owned(),
            total: backlog.total,
        });
    }

    if !is_durable_scrollback_enabled.load(Ordering::SeqCst) {
        return Ok(BacklogSnapshot {
            data: String::new(),
            total: 0,
        });
    }
    let data = scrollback
        .read(&id)
        .map_err(|error| format!("failed to read terminal {} scrollback: {}", id, error))?;
    Ok(BacklogSnapshot {
        total: byte_count(&data),
        data: String::from_utf8_lossy(&data).into_owned(),
    })
}

#[tauri::command(async)]
pub fn set_durable_scrollback_enabled(
    manager: State<'_, Mutex<PtyManager>>,
    is_enabled: bool,
) -> Result<(), String> {
    let manager = manager.lock_or_recover();
    manager.set_durable_scrollback_enabled(is_enabled);
    Ok(())
}

#[tauri::command(async)]
pub fn running_terminals(
    manager: State<'_, Mutex<PtyManager>>,
) -> Result<Vec<RunningTerminal>, String> {
    let manager = manager.lock_or_recover();
    Ok(manager.running_terminals())
}

#[tauri::command(async)]
pub fn terminal_runtime_info(
    manager: State<'_, Mutex<PtyManager>>,
    id: String,
) -> Result<Option<TerminalRuntimeInfo>, String> {
    let manager = manager.lock_or_recover();
    runtime_info_from_manager(&manager, &id)
}

#[cfg(test)]
mod scrollback_flag_tests {
    use super::PtyManager;
    use crate::scrollback::ScrollbackStore;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn root() -> PathBuf {
        let id = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "terra-swarm-pty-scrollback-{}-{id}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("scrollback root");
        root
    }

    #[test]
    fn given_a_new_manager_when_toggling_durable_scrollback_then_the_gate_starts_closed_and_keeps_stored_bytes(
    ) {
        let root = root();
        let store = ScrollbackStore::from_root(root.clone());
        store
            .append("t-flag", b"existing")
            .expect("seed scrollback");
        let manager = PtyManager::with_scrollback_dir(root.clone());
        let is_enabled = manager.durable_scrollback_enabled();

        assert!(!is_enabled.load(Ordering::SeqCst));
        let hidden = if is_enabled.load(Ordering::SeqCst) {
            store.read("t-flag").expect("read")
        } else {
            Vec::new()
        };
        assert!(hidden.is_empty());

        manager.set_durable_scrollback_enabled(true);
        assert!(is_enabled.load(Ordering::SeqCst));
        assert_eq!(store.read("t-flag").expect("enabled read"), b"existing");

        manager.set_durable_scrollback_enabled(false);
        assert!(!is_enabled.load(Ordering::SeqCst));
        let hidden_again = if is_enabled.load(Ordering::SeqCst) {
            store.read("t-flag").expect("read")
        } else {
            Vec::new()
        };
        assert!(hidden_again.is_empty());
        assert_eq!(
            fs::read(root.join("t-flag.scrollback")).expect("file is not deleted"),
            b"existing"
        );
        let _ = fs::remove_dir_all(root);
    }
}

#[cfg(test)]
mod input_tests {
    use super::send_input;
    use crate::ipc_error::IpcErrorCode;
    use std::sync::mpsc::sync_channel;

    #[test]
    fn given_room_in_the_queue_when_writing_then_the_bytes_are_queued() {
        let (input, output) = sync_channel(1);
        send_input(&input, "t-1", "ls\n".into()).unwrap();
        assert_eq!(output.try_recv().unwrap(), b"ls\n");
    }

    #[test]
    fn given_a_full_input_queue_when_writing_then_it_fails_with_the_busy_code() {
        let (input, _output) = sync_channel(1);
        send_input(&input, "t-1", "a".into()).unwrap();
        let error = send_input(&input, "t-1", "b".into()).unwrap_err();
        assert_eq!(error.code, IpcErrorCode::Busy);
    }

    #[test]
    fn given_a_closed_input_when_writing_then_it_fails_with_the_other_code() {
        let (input, output) = sync_channel::<Vec<u8>>(1);
        drop(output);
        let error = send_input(&input, "t-1", "a".into()).unwrap_err();
        assert_eq!(error.code, IpcErrorCode::Other);
        assert!(error.message.contains("closed"));
    }
}

#[cfg(test)]
mod runtime_info_tests {
    use super::{runtime_info_from_manager, runtime_info_from_values, PtyManager, RuntimeFacts};

    #[test]
    fn given_a_live_terminal_when_reading_runtime_info_then_it_exposes_only_real_process_facts() {
        let info = runtime_info_from_values(RuntimeFacts {
            id: "term-live",
            pid: Some(42),
            cols: 120,
            rows: 40,
            generation: 7,
            is_reaped: false,
        });
        assert_eq!(info.id, "term-live");
        assert_eq!(info.pid, Some(42));
        assert_eq!((info.cols, info.rows), (120, 40));
        assert!(info.is_running);
        assert!(!info.is_reaped);
        assert_eq!(info.generation, 7);
    }

    #[test]
    fn given_a_reaped_terminal_when_reading_runtime_info_then_it_is_not_reported_as_running() {
        let info = runtime_info_from_values(RuntimeFacts {
            id: "term-ended",
            pid: Some(42),
            cols: 80,
            rows: 24,
            generation: 8,
            is_reaped: true,
        });
        assert_eq!(info.pid, None);
        assert!(!info.is_running);
        assert!(info.is_reaped);
    }

    #[test]
    fn given_an_empty_manager_when_reading_runtime_info_of_an_unknown_id_then_there_is_none() {
        let manager = PtyManager::default();
        assert_eq!(
            runtime_info_from_manager(&manager, "term-missing").expect("runtime query"),
            None
        );
    }
}

#[cfg(test)]
mod spawn_lifecycle_tests {
    use super::{
        spawn_terminal_inner, PtyManager, Registries, SpawnOptions, SpawnRequest, SpawnReservation,
    };
    use crate::workspace::WorkspaceStore;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    use tauri::Manager;

    #[test]
    fn given_a_spawn_in_progress_for_an_id_when_spawning_the_same_id_then_it_fails_without_registering(
    ) {
        let app = tauri::test::mock_app();
        assert!(app.manage(Mutex::new(PtyManager::default())));
        assert!(app.manage(Mutex::new(WorkspaceStore::default())));
        let store = app.state::<Mutex<WorkspaceStore>>();
        let workspace = store.lock().expect("workspace store").create(
            "spawn-race".into(),
            std::env::temp_dir().to_string_lossy().into_owned(),
        );
        let manager = app.state::<Mutex<PtyManager>>();
        let in_progress =
            SpawnReservation::claim(manager.inner(), "t-race").expect("first reservation");

        let result = spawn_terminal_inner(
            app.handle(),
            Registries {
                manager: manager.inner(),
                store: store.inner(),
            },
            SpawnRequest {
                workspace_id: &workspace.id,
                command: "sleep 30",
                cols: 80,
                rows: 24,
                terminal_id: Some("t-race"),
                options: &SpawnOptions::default(),
            },
        );

        assert!(result.is_err());
        assert!(!manager
            .lock()
            .expect("pty manager")
            .terminals
            .contains_key("t-race"));
        drop(in_progress);
    }

    #[test]
    fn given_a_released_reservation_when_claiming_the_same_id_then_it_succeeds() {
        let manager = Mutex::new(PtyManager::default());
        drop(SpawnReservation::claim(&manager, "t-1").expect("first reservation"));

        let again = SpawnReservation::claim(&manager, "t-1");

        assert!(again.is_ok());
    }

    #[test]
    fn given_a_held_reservation_when_claiming_the_same_id_then_it_fails() {
        let manager = Mutex::new(PtyManager::default());
        let _held = SpawnReservation::claim(&manager, "t-1").expect("first reservation");

        let second = SpawnReservation::claim(&manager, "t-1");

        assert!(second.is_err());
    }

    #[test]
    fn given_a_command_that_exits_immediately_when_spawning_then_it_is_registered_and_removed_without_a_phantom_runtime(
    ) {
        let app = tauri::test::mock_app();
        assert!(app.manage(Mutex::new(PtyManager::default())));
        assert!(app.manage(Mutex::new(WorkspaceStore::default())));
        let store = app.state::<Mutex<WorkspaceStore>>();
        let workspace = store.lock().expect("workspace store").create(
            "immediate-exit".into(),
            std::env::temp_dir().to_string_lossy().into_owned(),
        );
        let manager = app.state::<Mutex<PtyManager>>();

        let spawned = spawn_terminal_inner(
            app.handle(),
            Registries {
                manager: manager.inner(),
                store: store.inner(),
            },
            SpawnRequest {
                workspace_id: &workspace.id,
                command: "exit 0",
                cols: 80,
                rows: 24,
                terminal_id: None,
                options: &SpawnOptions::default(),
            },
        )
        .expect("spawn immediate command");

        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let manager = manager.lock().expect("pty manager");
            let is_running = manager
                .running_terminals()
                .iter()
                .any(|terminal| terminal.id == spawned.meta.id);
            let is_registered = manager.terminals.contains_key(&spawned.meta.id);
            drop(manager);
            if !is_running && !is_registered {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "immediate child remained in running_terminals"
            );
            std::thread::sleep(Duration::from_millis(5));
        }

        assert!(
            !manager
                .lock()
                .expect("pty manager")
                .terminals
                .contains_key(&spawned.meta.id),
            "reaped child left a phantom manager entry"
        );
    }

    #[cfg(unix)]
    #[test]
    fn given_per_agent_args_and_env_when_spawning_then_they_reach_the_process_but_terra_variables_do_not(
    ) {
        let app = tauri::test::mock_app();
        assert!(app.manage(Mutex::new(PtyManager::default())));
        assert!(app.manage(Mutex::new(WorkspaceStore::default())));
        let dir = std::env::temp_dir().join(format!("terra-spawn-env-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = app.state::<Mutex<WorkspaceStore>>();
        let workspace = store
            .lock()
            .unwrap()
            .create("env".into(), dir.to_string_lossy().into_owned());
        let manager = app.state::<Mutex<PtyManager>>();
        let run = |args: &str, out: &str| {
            let options = SpawnOptions {
                shell: Some("/bin/sh".into()),
                args: Some(format!("{} > {}", args, dir.join(out).display())),
                env: [
                    ("AGENT_TEST_VAR".to_string(), "hello".to_string()),
                    ("TERRA_PANE_ID".to_string(), "spoofed".to_string()),
                ]
                .into_iter()
                .collect(),
                ..SpawnOptions::default()
            };
            let spawned = spawn_terminal_inner(
                app.handle(),
                Registries {
                    manager: manager.inner(),
                    store: store.inner(),
                },
                SpawnRequest {
                    workspace_id: &workspace.id,
                    command: "printenv",
                    cols: 80,
                    rows: 24,
                    terminal_id: None,
                    options: &options,
                },
            )
            .expect("spawn printenv");
            assert_eq!(spawned.meta.command, "printenv");
        };
        run("AGENT_TEST_VAR", "agent.txt");
        run("TERRA_PANE_ID", "terra.txt");
        let read = |name: &str| {
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                if let Ok(text) = std::fs::read_to_string(dir.join(name)) {
                    if !text.is_empty() || Instant::now() > deadline {
                        return text;
                    }
                }
                assert!(Instant::now() < deadline, "{} was never written", name);
                std::thread::sleep(Duration::from_millis(20));
            }
        };
        assert_eq!(read("agent.txt").trim(), "hello");
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(read("terra.txt").trim(), "");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn given_an_isolated_agent_when_spawning_and_respawning_then_it_gets_a_worktree_and_keeps_it() {
        let app = tauri::test::mock_app();
        assert!(app.manage(Mutex::new(PtyManager::default())));
        assert!(app.manage(Mutex::new(WorkspaceStore::default())));
        let repo = crate::worktree::test_repo::init("spawn");
        let root = repo.with_extension("worktrees");
        let store = app.state::<Mutex<WorkspaceStore>>();
        let workspace = store.lock().unwrap().create(
            "repo".into(),
            repo.join("app").to_string_lossy().into_owned(),
        );
        let manager = app.state::<Mutex<PtyManager>>();
        let options = SpawnOptions {
            shell: Some("/bin/sh".into()),
            should_use_worktree: true,
            worktree_root: Some(root.clone()),
            ..SpawnOptions::default()
        };
        let first = spawn_terminal_inner(
            app.handle(),
            Registries {
                manager: manager.inner(),
                store: store.inner(),
            },
            SpawnRequest {
                workspace_id: &workspace.id,
                command: "pwd > where.txt",
                cols: 80,
                rows: 24,
                terminal_id: None,
                options: &options,
            },
        )
        .expect("spawn isolated agent");
        let info = first.meta.worktree.clone().expect("worktree recorded");
        assert_eq!(info.branch, format!("terra/{}", first.meta.id));
        let written = std::path::Path::new(&info.cwd).join("where.txt");
        let deadline = Instant::now() + Duration::from_secs(3);
        while !written.exists() {
            assert!(
                Instant::now() < deadline,
                "the agent did not start in its worktree"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        let plain = SpawnOptions {
            shell: Some("/bin/sh".into()),
            ..SpawnOptions::default()
        };
        std::thread::sleep(Duration::from_millis(200));
        let again = spawn_terminal_inner(
            app.handle(),
            Registries {
                manager: manager.inner(),
                store: store.inner(),
            },
            SpawnRequest {
                workspace_id: &workspace.id,
                command: "true",
                cols: 80,
                rows: 24,
                terminal_id: Some(&first.meta.id),
                options: &plain,
            },
        )
        .expect("respawn isolated agent");
        assert_eq!(again.meta.worktree.as_ref(), Some(&info));
        crate::worktree::remove(&info, true).unwrap();
        crate::worktree::test_repo::cleanup(&repo, &root);
    }
}

#[cfg(all(test, unix))]
mod kill_tests {
    use super::{
        kill_terminal_inner, spawn_terminal_inner, PtyManager, Registries, SpawnOptions,
        SpawnRequest,
    };
    use crate::sync::LockExt;
    use crate::workspace::WorkspaceStore;
    use std::sync::atomic::Ordering;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};
    use tauri::Manager;

    #[test]
    fn given_a_poisoned_manager_lock_when_killing_a_terminal_then_the_process_is_still_killed() {
        let app = tauri::test::mock_app();
        assert!(app.manage(Mutex::new(PtyManager::default())));
        assert!(app.manage(Mutex::new(WorkspaceStore::default())));
        let store = app.state::<Mutex<WorkspaceStore>>();
        let workspace = store.lock().expect("workspace store").create(
            "poisoned".into(),
            std::env::temp_dir().to_string_lossy().into_owned(),
        );
        let manager = app.state::<Mutex<PtyManager>>();
        let spawned = spawn_terminal_inner(
            app.handle(),
            Registries {
                manager: manager.inner(),
                store: store.inner(),
            },
            SpawnRequest {
                workspace_id: &workspace.id,
                command: "sleep 30",
                cols: 80,
                rows: 24,
                terminal_id: None,
                options: &SpawnOptions {
                    shell: Some("/bin/sh".into()),
                    ..SpawnOptions::default()
                },
            },
        )
        .expect("spawn long-running command");
        let is_reaped = Arc::clone(
            &manager
                .lock()
                .expect("pty manager")
                .terminals
                .get(&spawned.meta.id)
                .expect("registered terminal")
                .is_reaped,
        );
        std::thread::scope(|scope| {
            let poisoner = scope.spawn(|| {
                let _guard = manager.inner().lock().expect("pty manager");
                panic!("poison the pty manager");
            });
            assert!(poisoner.join().is_err());
        });
        assert!(manager.is_poisoned());

        kill_terminal_inner(manager.inner(), &spawned.meta.id);

        assert!(!manager
            .lock_or_recover()
            .terminals
            .contains_key(&spawned.meta.id));
        let deadline = Instant::now() + Duration::from_secs(3);
        while !is_reaped.load(Ordering::SeqCst) {
            assert!(
                Instant::now() < deadline,
                "the process outlived kill_terminal_inner"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
