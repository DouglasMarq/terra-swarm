import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { api } from "./api";
import { checkForUpdate, installPendingUpdate } from "./updater";
import type {
  AgentInfo,
  ContextPayload,
  ExitPayload,
  NotificationItem,
  NotificationPayload,
  ResumeItem,
  TitlePayload,
  VoiceDownloadProgress,
  VoiceModelInfo,
  VoiceStatus,
  Workspace,
} from "./types";
import { computeTerminalMove, type DropZone } from "./layout";
import { backdropAnim, modalAnim } from "./motion";
import { ResumeDialog } from "./components/ResumeDialog";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { DEFAULT_BASIS, TerminalGrid } from "./components/TerminalGrid";
import { TopBar } from "./components/TopBar";
import { getTerminal } from "./terminalRegistry";
import "./App.css";

interface Hotkey {
  key: string;
  meta: boolean;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

const mk = (
  key: string,
  meta = false,
  shift = false,
  ctrl = false,
  alt = false,
): Hotkey => ({ key, meta, shift, ctrl, alt });

const IS_MAC =
  typeof navigator !== "undefined" &&
  /mac/i.test(navigator.platform || navigator.userAgent);

const wsSelect = (n: number): Hotkey =>
  IS_MAC ? mk(String(n), true) : mk(String(n), false, false, true);

const termSelect = (n: number): Hotkey =>
  IS_MAC ? mk(String(n), true, true) : mk(String(n), false, true, true);

// On Windows the meta key is the Win key: Win+W opens Widgets, Win+Enter
// launches Narrator, Win+= drives the Magnifier, etc. Use Ctrl+Shift / Alt
// combos there; keep Cmd combos on macOS.
const DEFAULT_HOTKEYS: Record<string, Hotkey> = {
  newWorkspace: IS_MAC ? mk("n", true, true) : mk("n", false, true, true),
  renameWorkspace: IS_MAC ? mk("r", true, true) : mk("r", false, true, true),
  deleteWorkspace: IS_MAC
    ? mk("Backspace", true, true)
    : mk("Backspace", false, true, true),
  newTerminal: IS_MAC ? mk("t", true) : mk("t", false, true, true),
  closeTerminal: IS_MAC ? mk("w", true) : mk("w", false, true, true),
  maximizeTerminal: IS_MAC ? mk("Enter", true) : mk("Enter", false, false, false, true),
  minimizeTerminal: IS_MAC
    ? mk("Enter", true, true)
    : mk("Enter", false, true, false, true),
  increaseFontSize: IS_MAC ? mk("=", true) : mk("=", false, false, true),
  decreaseFontSize: IS_MAC ? mk("-", true) : mk("-", false, false, true),
  resetFontSize: IS_MAC ? mk("0", true) : mk("0", false, false, true),
  toggleVoice: IS_MAC ? mk(" ", true, true) : mk(" ", false, true, true),
  selectWorkspace1: wsSelect(1),
  selectWorkspace2: wsSelect(2),
  selectWorkspace3: wsSelect(3),
  selectWorkspace4: wsSelect(4),
  selectWorkspace5: wsSelect(5),
  selectWorkspace6: wsSelect(6),
  selectWorkspace7: wsSelect(7),
  selectWorkspace8: wsSelect(8),
  selectWorkspace9: wsSelect(9),
  selectTerminal1: termSelect(1),
  selectTerminal2: termSelect(2),
  selectTerminal3: termSelect(3),
  selectTerminal4: termSelect(4),
  selectTerminal5: termSelect(5),
  selectTerminal6: termSelect(6),
  selectTerminal7: termSelect(7),
  selectTerminal8: termSelect(8),
  selectTerminal9: termSelect(9),
};

const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 32;
const DEFAULT_FONT_SIZE = 13;
const MAX_NOTIF_ITEMS = 50;
const BRANCH_POLL_MS = 10000;
const UPDATE_CHECK_MS = 60 * 60 * 1000;
const GRID_COL_OPTIONS = [2, 3, 4, 5, 6];
const DEFAULT_GRID_COLS = 2;

const SETTINGS_SECTIONS = [
  { id: "terminal", label: "Terminal" },
  { id: "voice", label: "Voice input" },
  { id: "shortcuts", label: "Keyboard shortcuts" },
  { id: "accessibility", label: "Accessibility" },
  { id: "about", label: "About" },
] as const;

type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

// Agent-native session continuation for the startup resume dialog. Only the
// base binary is mapped; anything else (shell, custom commands) respawns
// with its original command, which is a fresh start for that program.
const RESUME_COMMANDS: Record<string, string> = {
  claude: "claude --continue",
  codex: "codex resume --last",
  opencode: "opencode --continue",
  kimi: "kimi --continue",
};

function resumeCommandFor(command: string): string {
  const base = command.trim().split(/\s+/)[0];
  return RESUME_COMMANDS[base] ?? command;
}

const VOICE_LANGUAGES = [
  { code: "auto", label: "Auto-detect" },
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "it", label: "Italian" },
  { code: "pt", label: "Portuguese" },
  { code: "nl", label: "Dutch" },
  { code: "pl", label: "Polish" },
  { code: "ru", label: "Russian" },
  { code: "uk", label: "Ukrainian" },
  { code: "tr", label: "Turkish" },
  { code: "ar", label: "Arabic" },
  { code: "hi", label: "Hindi" },
  { code: "zh", label: "Chinese" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
];

function loadFontSize(): number {
  const raw = Number(localStorage.getItem("termFontSize"));
  return Number.isFinite(raw) && raw >= MIN_FONT_SIZE && raw <= MAX_FONT_SIZE
    ? Math.round(raw)
    : DEFAULT_FONT_SIZE;
}

function loadGridCols(): number {
  const raw = Number(localStorage.getItem("gridCols"));
  return GRID_COL_OPTIONS.includes(raw) ? raw : DEFAULT_GRID_COLS;
}

const HOTKEY_ACTIONS = [
  { id: "newWorkspace", label: "New workspace" },
  { id: "renameWorkspace", label: "Rename workspace" },
  { id: "deleteWorkspace", label: "Delete workspace" },
  { id: "newTerminal", label: "New terminal" },
  { id: "closeTerminal", label: "Close focused terminal" },
  { id: "maximizeTerminal", label: "Maximize terminal (toggle)" },
  { id: "minimizeTerminal", label: "Minimize terminal" },
  { id: "increaseFontSize", label: "Increase terminal font size" },
  { id: "decreaseFontSize", label: "Decrease terminal font size" },
  { id: "resetFontSize", label: "Reset terminal font size" },
  { id: "toggleVoice", label: "Toggle voice input" },
  { id: "selectWorkspace1", label: "Select workspace 1" },
  { id: "selectWorkspace2", label: "Select workspace 2" },
  { id: "selectWorkspace3", label: "Select workspace 3" },
  { id: "selectWorkspace4", label: "Select workspace 4" },
  { id: "selectWorkspace5", label: "Select workspace 5" },
  { id: "selectWorkspace6", label: "Select workspace 6" },
  { id: "selectWorkspace7", label: "Select workspace 7" },
  { id: "selectWorkspace8", label: "Select workspace 8" },
  { id: "selectWorkspace9", label: "Select workspace 9" },
  { id: "selectTerminal1", label: "Focus terminal 1" },
  { id: "selectTerminal2", label: "Focus terminal 2" },
  { id: "selectTerminal3", label: "Focus terminal 3" },
  { id: "selectTerminal4", label: "Focus terminal 4" },
  { id: "selectTerminal5", label: "Focus terminal 5" },
  { id: "selectTerminal6", label: "Focus terminal 6" },
  { id: "selectTerminal7", label: "Focus terminal 7" },
  { id: "selectTerminal8", label: "Focus terminal 8" },
  { id: "selectTerminal9", label: "Focus terminal 9" },
];

function loadHotkeys(): Record<string, Hotkey> {
  try {
    const raw = localStorage.getItem("hotkeys");
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      const clean: Record<string, Hotkey> = {};
      for (const [action, def] of Object.entries(DEFAULT_HOTKEYS)) {
        const v = (parsed as Record<string, unknown>)?.[action];
        if (
          v &&
          typeof v === "object" &&
          typeof (v as Hotkey).key === "string" &&
          (v as Hotkey).key.length > 0 &&
          ["meta", "shift", "ctrl", "alt"].every(
            (m) => typeof (v as unknown as Record<string, unknown>)[m] === "boolean",
          )
        ) {
          const h = v as Hotkey;
          clean[action] = {
            key: h.key,
            meta: h.meta,
            shift: h.shift,
            ctrl: h.ctrl,
            alt: h.alt,
          };
        } else {
          clean[action] = def;
        }
      }
      return clean;
    }
  } catch {
    // corrupted value; fall back to defaults
  }
  return { ...DEFAULT_HOTKEYS };
}

function formatHotkey(h: Hotkey): string {
  let s = "";
  if (h.ctrl) s += "⌃";
  if (h.alt) s += "⌥";
  if (h.shift) s += "⇧";
  if (h.meta) s += "⌘";
  s +=
    h.key === " " ? "Space" : h.key.length === 1 ? h.key.toUpperCase() : h.key;
  return s;
}

function matchHotkey(e: KeyboardEvent, h: Hotkey): boolean {
  return (
    e.key.toLowerCase() === h.key.toLowerCase() &&
    e.metaKey === h.meta &&
    e.ctrlKey === h.ctrl &&
    e.altKey === h.alt &&
    e.shiftKey === h.shift
  );
}

function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [defaultAgent, setDefaultAgent] = useState<string | null>(
    () => localStorage.getItem("defaultAgent"),
  );
  const [exited, setExited] = useState<Record<string, number | null>>({});
  const [notifications, setNotifications] = useState<Record<string, number>>(
    {},
  );
  const [notifItems, setNotifItems] = useState<NotificationItem[]>([]);
  const [branches, setBranches] = useState<Record<string, string>>({});
  const [contextUsage, setContextUsage] = useState<Record<string, number>>({});
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [showNewWs, setShowNewWs] = useState(false);
  const [newWsName, setNewWsName] = useState("");
  const [newWsCwd, setNewWsCwd] = useState("");
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const [pickerTarget, setPickerTarget] = useState<string | null>(null);
  const [pickerSaveDefault, setPickerSaveDefault] = useState(false);
  const [hotkeys, setHotkeys] = useState<Record<string, Hotkey>>(loadHotkeys);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("terminal");
  const [capturing, setCapturing] = useState<string | null>(null);
  const [renameTrigger, setRenameTrigger] = useState<{
    id: string;
    n: number;
  } | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("sidebarCollapsed") === "1",
  );
  const [fontSize, setFontSize] = useState<number>(loadFontSize);
  const [defaultShell, setDefaultShell] = useState(
    () => localStorage.getItem("defaultShell") ?? "",
  );
  const [reduceMotion, setReduceMotion] = useState(
    () => localStorage.getItem("reduceMotion") === "1",
  );

  useEffect(() => {
    document.documentElement.classList.toggle("reduce-motion", reduceMotion);
  }, [reduceMotion]);

  const updateReduceMotion = (on: boolean) => {
    setReduceMotion(on);
    localStorage.setItem("reduceMotion", on ? "1" : "0");
  };
  const agentsRef = useRef<AgentInfo[]>([]);
  const agentsReadyRef = useRef<Promise<void>>(Promise.resolve());
  const [availableShells, setAvailableShells] = useState<string[]>([]);
  const [gridCols, setGridCols] = useState<number>(loadGridCols);
  const [resumeItems, setResumeItems] = useState<ResumeItem[] | null>(null);
  const [resumeSavedAt, setResumeSavedAt] = useState<number | null>(null);
  const [voiceEnabled, setVoiceEnabled] = useState(
    () => localStorage.getItem("voiceEnabled") === "1",
  );
  const [voiceLang, setVoiceLang] = useState(
    () => localStorage.getItem("voiceLanguage") ?? "auto",
  );
  const [voiceModel, setVoiceModel] = useState<string | null>(
    () => localStorage.getItem("voiceModel"),
  );
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>("idle");
  const [voiceModels, setVoiceModels] = useState<VoiceModelInfo[]>([]);
  const [voiceDl, setVoiceDl] = useState<{
    id: string;
    percent: number;
  } | null>(null);
  const [micAvailable, setMicAvailable] = useState<boolean | null>(null);
  const [appVersion, setAppVersion] = useState<string>("");
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [updateCheckState, setUpdateCheckState] = useState<
    "idle" | "checking" | "uptodate" | "error"
  >("idle");
  const inited = useRef(false);
  // Authoritative set of terminal ids the UI tracks; mutated only by
  // spawn/close paths (never rebuilt from `workspaces`, which would race
  // with pending refreshes and silently drop live ids).
  const liveIdsRef = useRef<Set<string>>(new Set());
  const notifKeyRef = useRef(1);
  const spawnSeqRef = useRef<Record<string, number>>({});
  const lastFocusByWs = useRef<Record<string, string>>({});
  const prevActiveId = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await api.listWorkspaces();
      setWorkspaces(list);
      setActiveId((prev) =>
        prev && list.some((w) => w.id === prev) ? prev : (list[0]?.id ?? null),
      );
    } catch (err) {
      console.error("failed to list workspaces:", err);
    }
  }, []);

  // One-time init: load workspaces and offer to resume the terminals that
  // were running at last close. Guarded so React StrictMode's double-invoke
  // doesn't spawn everything twice.
  useEffect(() => {
    if (inited.current) return;
    inited.current = true;

    (async () => {
      try {
        let list = await api.listWorkspaces();
        if (list.length === 0) {
          await api.createWorkspace("default", "");
          list = await api.listWorkspaces();
        }
        setWorkspaces(list);
        setActiveId(list[0]?.id ?? null);

        const running = await api.runningTerminals();
        const runningIds = new Set(running.map((r) => r.id));
        for (const ws of list) {
          for (const t of ws.terminals) liveIdsRef.current.add(t.id);
        }
        for (const r of running) {
          spawnSeqRef.current[r.id] = r.seq;
        }
        // Persisted terminals that are no longer alive were running when the
        // app last closed; offer to resume them instead of silently
        // respawning, so agent-native session continuation can be used.
        const items: ResumeItem[] = [];
        const deadIds: string[] = [];
        for (const ws of list) {
          for (const t of ws.terminals) {
            if (runningIds.has(t.id)) continue;
            deadIds.push(t.id);
            items.push({
              terminalId: t.id,
              wsId: ws.id,
              wsName: ws.name,
              cwd: ws.cwd,
              command: t.command,
              agentId: t.command.trim().split(/\s+/)[0] || "shell",
              resumeCommand: resumeCommandFor(t.command),
            });
          }
        }
        if (items.length > 0) {
          // Mark persisted-dead terminals as exited up front so the status
          // bar doesn't count them as running and panes show the exited
          // overlay instead of a blank live-looking terminal.
          setExited((prev) => {
            const next = { ...prev };
            for (const id of deadIds) next[id] = null;
            return next;
          });
          setResumeItems(items);
          api.storeSavedAt().then(setResumeSavedAt).catch(() => {});
        }
      } catch (err) {
        console.error("initialization failed:", err);
      }
    })();

    agentsReadyRef.current = api
      .detectAgents()
      .then((a) => {
        agentsRef.current = a;
        setAgents(a);
      })
      .catch(() => {});

    getVersion()
      .then(setAppVersion)
      .catch(() => {});
    runUpdateCheck();
    setInterval(runUpdateCheck, UPDATE_CHECK_MS);

    // Push persisted voice settings into the backend (model load is async).
    // If the mic is gone while the feature was left enabled, disable it.
    if (localStorage.getItem("voiceEnabled") === "1") {
      api
        .voiceMicAvailable()
        .then((avail) => {
          setMicAvailable(avail);
          if (!avail) disableVoiceInput(false);
        })
        .catch(() => {});
      api
        .voiceSetLanguage(localStorage.getItem("voiceLanguage") ?? "auto")
        .catch(() => {});
      const model = localStorage.getItem("voiceModel");
      if (model) {
        api.voiceSetModel(model).catch(handleVoiceModelLoadError);
      }
    }
  }, []);

  // Global backend event listeners. Registered in a dedicated effect (no
  // one-time guard) so StrictMode's unmount/remount cycle re-registers them.
  useEffect(() => {
    const unlisten = listen<ExitPayload>("terminal-exit", (e) => {
      if (!liveIdsRef.current.has(e.payload.id)) return;
      // Ignore exit events from a previous process generation (e.g. the old
      // PTY's death arriving right after a restart respawned the id).
      const known = spawnSeqRef.current[e.payload.id];
      if (known != null && e.payload.seq !== known) return;
      setExited((prev) => ({ ...prev, [e.payload.id]: e.payload.code }));
      setContextUsage((prev) => {
        const next = { ...prev };
        delete next[e.payload.id];
        return next;
      });
    });
    const unlistenNotif = listen<NotificationPayload>(
      "terminal-notification",
      (e) => {
        if (!liveIdsRef.current.has(e.payload.id)) return;
        setNotifications((prev) => ({
          ...prev,
          [e.payload.id]: (prev[e.payload.id] ?? 0) + e.payload.count,
        }));
        if (e.payload.messages.length > 0) {
          const ts = Date.now();
          const added = e.payload.messages
            .map((message) => ({
              key: notifKeyRef.current++,
              terminalId: e.payload.id,
              workspaceId: e.payload.workspace_id,
              message,
              ts,
              read: false,
            }))
            .reverse();
          setNotifItems((prev) =>
            [...added, ...prev].slice(0, MAX_NOTIF_ITEMS),
          );
        }
      },
    );
    const unlistenCtx = listen<ContextPayload>("terminal-context", (e) => {
      if (!liveIdsRef.current.has(e.payload.id)) return;
      setContextUsage((prev) => ({ ...prev, [e.payload.id]: e.payload.used }));
    });
    const unlistenTitle = listen<TitlePayload>("terminal-title", (e) => {
      if (!liveIdsRef.current.has(e.payload.id)) return;
      setTitles((prev) => ({ ...prev, [e.payload.id]: e.payload.title }));
    });
    const unlistenWs = listen("workspaces-changed", () => {
      refresh();
    });
    return () => {
      unlisten.then((u) => u());
      unlistenNotif.then((u) => u());
      unlistenCtx.then((u) => u());
      unlistenTitle.then((u) => u());
      unlistenWs.then((u) => u());
    };
  }, [refresh]);

  const active = workspaces.find((w) => w.id === activeId) ?? null;
  const showResume = resumeItems !== null && resumeItems.length > 0;
  const modalOpen = showNewWs || showAgentPicker || showSettings || showResume;

  // Poll git branches for all workspace directories. Keyed off the id:cwd
  // signature so terminal spawns/resizes don't restart the interval.
  const wsCwdSig = workspaces.map((w) => `${w.id}:${w.cwd}`).join("|");
  useEffect(() => {
    const targets = workspaces.map((w) => ({ id: w.id, cwd: w.cwd }));
    let cancelled = false;
    const poll = async () => {
      const entries = await Promise.all(
        targets.map(
          async (t) =>
            [t.id, await api.gitBranch(t.cwd).catch(() => null)] as const,
        ),
      );
      if (cancelled) return;
      setBranches((prev) => {
        const next: Record<string, string> = {};
        for (const [id, b] of entries) if (b) next[id] = b;
        const keys = Object.keys(next);
        const same =
          keys.length === Object.keys(prev).length &&
          keys.every((k) => prev[k] === next[k]);
        return same ? prev : next;
      });
    };
    poll();
    const iv = setInterval(poll, BRANCH_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [wsCwdSig]);

  useEffect(() => {
    if (!activeId || !focusedId) return;
    const ws = workspaces.find((w) => w.id === activeId);
    if (ws?.terminals.some((t) => t.id === focusedId)) {
      lastFocusByWs.current[activeId] = focusedId;
    }
  }, [activeId, focusedId, workspaces]);

  useEffect(() => {
    if (prevActiveId.current === activeId) return;
    prevActiveId.current = activeId;
    if (!activeId) return;
    const ws = workspaces.find((w) => w.id === activeId);
    if (!ws) return;
    const saved = lastFocusByWs.current[activeId];
    setFocusedId((cur) => {
      if (cur && ws.terminals.some((t) => t.id === cur)) return cur;
      return saved && ws.terminals.some((t) => t.id === saved) ? saved : null;
    });
  }, [activeId, workspaces]);

  useEffect(() => {
    if (!focusedId || !activeId || modalOpen) return;
    const ae = document.activeElement as HTMLElement | null;
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "SELECT")) return;
    const raf = requestAnimationFrame(() => getTerminal(focusedId)?.focus());
    return () => cancelAnimationFrame(raf);
  }, [activeId, focusedId, modalOpen]);

  const spawnTerminalInto = async (wsId: string, command: string) => {
    // Spawn at an existing pane's size when possible: the PTY otherwise
    // starts at 80x24 and the child draws its first frame at the wrong size
    // before the pane's fit can correct it (worst on Windows/ConPTY).
    const sibling = workspaces
      .find((w) => w.id === wsId)
      ?.terminals.map((t) => getTerminal(t.id))
      .find((t) => t && t.cols > 0 && t.rows > 0);
    const res = await api.spawnTerminal(
      wsId,
      command,
      undefined,
      sibling?.cols,
      sibling?.rows,
      defaultShell || undefined,
    );
    liveIdsRef.current.add(res.meta.id);
    spawnSeqRef.current[res.meta.id] = res.seq;
    setFocusedId(res.meta.id);
    await refresh();
  };

  const reportSpawnError = (err: unknown) => {
    console.error("failed to spawn terminal:", err);
    pushSystemNotification(`Failed to start terminal: ${String(err)}`);
  };

  const openPicker = (wsId: string) => {
    setActiveId(wsId);
    setExpandedId(null);
    setPickerTarget(wsId);
    setPickerSaveDefault(!!defaultAgent);
    setShowAgentPicker(true);
  };

  const quickNewTerminal = async (wsId: string) => {
    setActiveId(wsId);
    setExpandedId(null);
    // Wait for agent detection: at startup `agents` is still empty, and
    // deciding on a stale list would open the picker despite a saved default.
    await agentsReadyRef.current;
    const defAvailable =
      defaultAgent &&
      agentsRef.current.some((a) => a.id === defaultAgent && a.available);
    if (defAvailable) {
      spawnTerminalInto(wsId, defaultAgent).catch(reportSpawnError);
    } else {
      setPickerTarget(wsId);
      setPickerSaveDefault(false);
      setShowAgentPicker(true);
    }
  };

  const chooseAgent = async (agentId: string) => {
    if (pickerSaveDefault) {
      setDefaultAgent(agentId);
      localStorage.setItem("defaultAgent", agentId);
    }
    setShowAgentPicker(false);
    if (pickerTarget) {
      await spawnTerminalInto(pickerTarget, agentId).catch(reportSpawnError);
    }
  };

  const closeTerminal = async (id: string) => {
    liveIdsRef.current.delete(id);
    delete spawnSeqRef.current[id];
    await api.killTerminal(id).catch(() => {});
    setExited((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setContextUsage((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setTitles((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setNotifications((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setNotifItems((prev) => prev.filter((n) => n.terminalId !== id));
    if (expandedId === id) setExpandedId(null);
    if (focusedId === id) {
      const ws = workspaces.find((w) => w.terminals.some((t) => t.id === id));
      const idx = ws ? ws.terminals.findIndex((t) => t.id === id) : -1;
      const next = ws?.terminals[idx - 1] ?? ws?.terminals[idx + 1] ?? null;
      setFocusedId(next ? next.id : null);
    }
    await refresh();
  };

  const restartTerminal = async (id: string, command: string) => {
    if (!active) return;
    liveIdsRef.current.add(id);
    try {
      // Kill the old PTY first (store entry is kept so position/width are
      // preserved), then respawn. Spawning onto a live id would leak the old
      // process and double-emit output. Spawn at the xterm's current size:
      // it fitted to the pane long ago, so nothing would re-send the real
      // dimensions and the new PTY would stay stuck at the 80x24 default.
      const term = getTerminal(id);
      await api.stopTerminal(id);
      const res = await api.spawnTerminal(
        active.id,
        command,
        id,
        term?.cols,
        term?.rows,
        defaultShell || undefined,
      );
      spawnSeqRef.current[id] = res.seq;
    } catch (err) {
      console.error(`failed to restart terminal ${id}:`, err);
      setExited((prev) => ({ ...prev, [id]: null }));
      await refresh();
      return;
    }
    setExited((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setContextUsage((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setTitles((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setNotifications((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setNotifItems((prev) => prev.filter((n) => n.terminalId !== id));
    await refresh();
  };

  const spawnResumed = async (item: ResumeItem) => {
    try {
      // Respawn onto the persisted id so position/width are kept; the store
      // entry's command is updated to the resume variant backend-side. Spawn
      // at the xterm's current size: the pane mounted (and fitted) while the
      // old process was dead, so no resize would be sent after the respawn
      // and the PTY would stay at the 80x24 default under a full-width pane.
      const term = getTerminal(item.terminalId);
      const res = await api.spawnTerminal(
        item.wsId,
        item.resumeCommand,
        item.terminalId,
        term?.cols,
        term?.rows,
        defaultShell || undefined,
      );
      liveIdsRef.current.add(item.terminalId);
      spawnSeqRef.current[item.terminalId] = res.seq;
      setExited((prev) => {
        const next = { ...prev };
        delete next[item.terminalId];
        return next;
      });
    } catch (err) {
      console.error(`failed to resume terminal ${item.terminalId}:`, err);
      setExited((prev) => ({ ...prev, [item.terminalId]: null }));
    }
  };

  const dropResumeItem = (terminalId: string) =>
    setResumeItems((prev) => {
      if (!prev) return prev;
      const next = prev.filter((i) => i.terminalId !== terminalId);
      return next.length > 0 ? next : null;
    });

  const resumeOne = async (item: ResumeItem) => {
    await spawnResumed(item);
    dropResumeItem(item.terminalId);
    await refresh();
  };

  const dismissOne = async (item: ResumeItem) => {
    // killTerminal removes the store entry even when no PTY is alive.
    liveIdsRef.current.delete(item.terminalId);
    delete spawnSeqRef.current[item.terminalId];
    await api.killTerminal(item.terminalId).catch(() => {});
    dropResumeItem(item.terminalId);
    await refresh();
  };

  const resumeAll = async () => {
    const items = resumeItems ?? [];
    setResumeItems(null);
    await Promise.all(items.map(spawnResumed));
    await refresh();
  };

  const dismissAll = async () => {
    const items = resumeItems ?? [];
    setResumeItems(null);
    for (const i of items) {
      liveIdsRef.current.delete(i.terminalId);
      delete spawnSeqRef.current[i.terminalId];
    }
    await Promise.all(
      items.map((i) => api.killTerminal(i.terminalId).catch(() => {})),
    );
    await refresh();
  };

  const markTerminalRead = (id: string) => {
    setNotifItems((prev) =>
      prev.some((n) => n.terminalId === id && !n.read)
        ? prev.map((n) => (n.terminalId === id ? { ...n, read: true } : n))
        : prev,
    );
  };

  const clearNotifications = (id: string) => {
    setNotifications((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    markTerminalRead(id);
  };

  const markAllRead = () => {
    setNotifItems((prev) =>
      prev.some((n) => !n.read)
        ? prev.map((n) => ({ ...n, read: true }))
        : prev,
    );
    setNotifications({});
  };

  const clearAllNotifications = () => {
    setNotifItems([]);
    setNotifications({});
  };

  const jumpToNotification = (item: NotificationItem) => {
    const ws = workspaces.find((w) => w.id === item.workspaceId);
    if (ws?.terminals.some((t) => t.id === item.terminalId)) {
      setActiveId(item.workspaceId);
      setFocusedId(item.terminalId);
    }
    clearNotifications(item.terminalId);
  };

  const resizeTerminalLocal = (wsId: string, id: string, pct: number) => {
    setWorkspaces((prev) =>
      prev.map((w) =>
        w.id !== wsId
          ? w
          : {
              ...w,
              terminals: w.terminals.map((t) =>
                t.id !== id ? t : { ...t, width: pct },
              ),
            },
      ),
    );
  };

  const persistWidth = (wsId: string, id: string, pct: number) => {
    api
      .setTerminalWidth(wsId, id, pct)
      .catch((err) => console.warn("persist width failed:", err));
  };

  const persistOrder = (wsId: string, order: string[]) => {
    api
      .reorderTerminals(wsId, order)
      .catch((err) => console.warn("persist order failed:", err));
  };

  const wsOrderRef = useRef<Workspace[]>([]);
  wsOrderRef.current = workspaces;

  const reorderWorkspacesLocal = (ordered: Workspace[]) => {
    setWorkspaces(ordered);
  };

  const persistWorkspaceOrder = () => {
    api
      .reorderWorkspaces(wsOrderRef.current.map((w) => w.id))
      .catch(() => {});
  };

  const moveTerminalLocal = (
    wsId: string,
    dragId: string,
    targetId: string,
    zone: DropZone,
    contentWidth: number,
  ) => {
    // Read through the ref, not the render closure: the drop gesture can
    // outlive the render that started it (a terminal closed or a refresh
    // landed mid-drag), and the stale list would resurrect the removed pane.
    const ws = wsOrderRef.current.find((w) => w.id === wsId);
    if (!ws) return;
    const defaultBasis = gridCols > 0 ? Math.floor(100 / gridCols) : DEFAULT_BASIS;
    const move = computeTerminalMove(
      ws.terminals,
      dragId,
      targetId,
      zone,
      defaultBasis,
      contentWidth,
    );
    if (!move) return;
    setWorkspaces((prev) =>
      prev.map((w) => (w.id !== wsId ? w : { ...w, terminals: move.next })),
    );
    persistOrder(wsId, move.order);
    for (const { id, pct } of move.widths) {
      api
        .setTerminalWidth(wsId, id, pct)
        .catch((err) => console.warn("persist width failed:", err));
    }
  };

  const renameWorkspace = async (id: string, name: string) => {
    await api.renameWorkspace(id, name).catch(() => {});
    await refresh();
  };

  const pickFolder = async () => {
    try {
      const dir = await openDialog({ directory: true, multiple: false });
      if (typeof dir === "string") {
        setNewWsCwd(dir);
        if (!newWsName) {
          const base = dir.split(/[\\/]/).filter(Boolean).pop();
          if (base) setNewWsName(base);
        }
      }
    } catch (err) {
      console.error("folder picker failed:", err);
    }
  };

  const createWorkspace = async () => {
    try {
      const ws = await api.createWorkspace(
        newWsName.trim() || "workspace",
        newWsCwd,
      );
      setShowNewWs(false);
      setNewWsName("");
      setNewWsCwd("");
      await refresh();
      setActiveId(ws.id);
    } catch (err) {
      console.error("failed to create workspace:", err);
    }
  };

  const closeWorkspace = async (id: string) => {
    const terms = workspaces.find((w) => w.id === id)?.terminals ?? [];
    for (const t of terms) {
      liveIdsRef.current.delete(t.id);
      delete spawnSeqRef.current[t.id];
    }
    delete lastFocusByWs.current[id];
    setExited((prev) => {
      const next = { ...prev };
      for (const t of terms) delete next[t.id];
      return next;
    });
    setNotifications((prev) => {
      const next = { ...prev };
      for (const t of terms) delete next[t.id];
      return next;
    });
    setNotifItems((prev) =>
      prev.filter((n) => !terms.some((t) => t.id === n.terminalId)),
    );
    setContextUsage((prev) => {
      const next = { ...prev };
      for (const t of terms) delete next[t.id];
      return next;
    });
    setTitles((prev) => {
      const next = { ...prev };
      for (const t of terms) delete next[t.id];
      return next;
    });
    try {
      await api.closeWorkspace(id);
    } catch (err) {
      console.error(`failed to close workspace ${id}:`, err);
    }
    if (activeId === id) {
      setExpandedId(null);
      setFocusedId(null);
    }
    await refresh();
  };

  const toggleSidebar = () => {
    setSidebarCollapsed((prev) => {
      localStorage.setItem("sidebarCollapsed", prev ? "0" : "1");
      return !prev;
    });
  };

  const changeFontSize = (delta: number) => {
    setFontSize((prev) => {
      const next = Math.min(
        MAX_FONT_SIZE,
        Math.max(MIN_FONT_SIZE, prev + delta),
      );
      localStorage.setItem("termFontSize", String(next));
      return next;
    });
  };

  const resetFontSize = () => {
    setFontSize(DEFAULT_FONT_SIZE);
    localStorage.removeItem("termFontSize");
  };

  const refreshVoiceModels = useCallback(() => {
    api.voiceListModels().then(setVoiceModels).catch(() => {});
  }, []);

  const toggleVoice = useCallback(() => {
    if (!voiceEnabled) {
      setSettingsSection("voice");
      setShowSettings(true);
      return;
    }
    api
      .voiceToggleRecording()
      .catch((err) => console.error("voice toggle failed:", err));
  }, [voiceEnabled]);

  const pushSystemNotification = (message: string) => {
    setNotifItems((prev) =>
      [
        {
          key: notifKeyRef.current++,
          terminalId: "",
          workspaceId: "",
          message,
          ts: Date.now(),
          read: false,
          system: true,
        },
        ...prev,
      ].slice(0, MAX_NOTIF_ITEMS),
    );
  };

  const notifyUpdateAvailable = (version: string, current: string) => {
    setUpdateVersion(version);
    setNotifItems((prev) =>
      [
        {
          key: notifKeyRef.current++,
          terminalId: "",
          workspaceId: "",
          message: `Version ${version} is available (installed: ${current}).`,
          ts: Date.now(),
          read: false,
          system: true,
          update: true,
        },
        ...prev.filter((n) => !n.update),
      ].slice(0, MAX_NOTIF_ITEMS),
    );
  };

  const runUpdateCheck = () => {
    checkForUpdate().then((result) => {
      if (result.kind === "update") {
        notifyUpdateAvailable(result.version, result.current);
      }
    });
  };

  const manualUpdateCheck = () => {
    setUpdateCheckState("checking");
    checkForUpdate().then((result) => {
      if (result.kind === "update") {
        notifyUpdateAvailable(result.version, result.current);
        setUpdateCheckState("idle");
      } else {
        setUpdateCheckState(result.kind === "none" ? "uptodate" : "error");
      }
    });
  };

  const installUpdate = () => {
    if (updateInstalling) return;
    setUpdateInstalling(true);
    installPendingUpdate().catch((err) => {
      console.error("update install failed:", err);
      setUpdateInstalling(false);
      pushSystemNotification("Update failed to install — try again later");
    });
  };

  const handleVoiceModelLoadError = (err: unknown) => {
    console.error("voice model load failed:", err);
    setVoiceModel(null);
    localStorage.removeItem("voiceModel");
    refreshVoiceModels();
    pushSystemNotification("Voice model failed to load — select it again");
  };

  const disableVoiceInput = (notify: boolean) => {
    setVoiceEnabled(false);
    localStorage.setItem("voiceEnabled", "0");
    if (notify) {
      pushSystemNotification("Microphone disconnected — voice input disabled");
    }
  };

  const updateVoiceEnabled = (on: boolean) => {
    if (!on) {
      setVoiceEnabled(false);
      localStorage.setItem("voiceEnabled", "0");
      return;
    }
    // Never enable without a microphone connected
    api
      .voiceMicAvailable()
      .then((avail) => {
        setMicAvailable(avail);
        if (!avail) return;
        setVoiceEnabled(true);
        localStorage.setItem("voiceEnabled", "1");
        api.voiceSetLanguage(voiceLang).catch(() => {});
        if (voiceModel) {
          api.voiceSetModel(voiceModel).catch(handleVoiceModelLoadError);
        }
        refreshVoiceModels();
      })
      .catch(() => {});
  };

  const updateVoiceLang = (lang: string) => {
    setVoiceLang(lang);
    localStorage.setItem("voiceLanguage", lang);
    api.voiceSetLanguage(lang).catch(() => {});
  };

  const selectVoiceModel = (id: string) => {
    api.voiceSetModel(id).catch(handleVoiceModelLoadError);
  };

  const downloadVoiceModel = (id: string) => {
    setVoiceDl({ id, percent: 0 });
    api.voiceDownloadModel(id).catch((err) => {
      setVoiceDl(null);
      console.error("voice model download failed:", err);
    });
  };

  // Latest focused terminal for the voice paste target, readable from
  // listeners that are registered once.
  const voiceFocusRef = useRef<string | null>(null);
  voiceFocusRef.current = focusedId;
  const voiceEnabledRef = useRef(voiceEnabled);
  voiceEnabledRef.current = voiceEnabled;

  // Voice backend events. On completion the transcript is written into the
  // focused terminal (bracketed-paste aware) and focus is returned to it.
  useEffect(() => {
    const unRecStart = listen("voice-recording-started", () =>
      setVoiceStatus("recording"),
    );
    const unTrStart = listen("voice-transcription-started", () =>
      setVoiceStatus("transcribing"),
    );
    const unTrDone = listen<string>("voice-transcription-complete", (e) => {
      setVoiceStatus("idle");
      const text = e.payload;
      if (!text.trim()) return;
      const id = voiceFocusRef.current;
      if (!id) return;
      const term = getTerminal(id);
      if (!term) return;
      const data = term.modes.bracketedPasteMode
        ? `\u001b[200~${text}\u001b[201~`
        : text;
      api.writeTerminal(id, data).catch(() => {});
      term.focus();
    });
    const unTrErr = listen<string>("voice-transcription-error", (e) => {
      setVoiceStatus("idle");
      console.error("voice transcription error:", e.payload);
    });
    const unRecErr = listen<string>("voice-recording-error", (e) => {
      setVoiceStatus("idle");
      console.error("voice recording error:", e.payload);
      if (e.payload.includes("model")) {
        setSettingsSection("voice");
        setShowSettings(true);
      }
    });
    const unDlProg = listen<VoiceDownloadProgress>(
      "voice-model-download-progress",
      (e) => setVoiceDl({ id: e.payload.model_id, percent: e.payload.percent }),
    );
    const unDlDone = listen("voice-model-download-complete", () => {
      setVoiceDl(null);
      refreshVoiceModels();
    });
    const unModelChanged = listen<string>("voice-model-changed", (e) => {
      setVoiceModel(e.payload);
      localStorage.setItem("voiceModel", e.payload);
      refreshVoiceModels();
    });
    const unMicChanged = listen<boolean>("voice-mic-changed", (e) => {
      setMicAvailable(e.payload);
      if (!e.payload && voiceEnabledRef.current) disableVoiceInput(true);
    });
    return () => {
      unRecStart.then((u) => u());
      unTrStart.then((u) => u());
      unTrDone.then((u) => u());
      unTrErr.then((u) => u());
      unRecErr.then((u) => u());
      unDlProg.then((u) => u());
      unDlDone.then((u) => u());
      unModelChanged.then((u) => u());
      unMicChanged.then((u) => u());
    };
  }, [refreshVoiceModels]);

  // Refresh mic presence and the model list whenever the settings page opens
  useEffect(() => {
    if (!showSettings) return;
    api
      .voiceMicAvailable()
      .then(setMicAvailable)
      .catch(() => {});
    if (voiceEnabled) refreshVoiceModels();
    api
      .listShells()
      .then(setAvailableShells)
      .catch(() => {});
  }, [showSettings, voiceEnabled, refreshVoiceModels]);

  const applyGridLayout = async (cols: number) => {
    if (!GRID_COL_OPTIONS.includes(cols)) return;
    setGridCols(cols);
    localStorage.setItem("gridCols", String(cols));
    // Even out every pane to an equal share of the row, then reload the
    // workspaces so all grids re-layout on the new column count.
    const basis = Math.floor(100 / cols);
    const targets = workspaces.flatMap((w) =>
      w.terminals.map((t) => ({ wsId: w.id, id: t.id })),
    );
    setWorkspaces((prev) =>
      prev.map((w) => ({
        ...w,
        terminals: w.terminals.map((t) => ({ ...t, width: basis })),
      })),
    );
    await Promise.all(
      targets.map(({ wsId, id }) =>
        api.setTerminalWidth(wsId, id, basis).catch(() => {}),
      ),
    );
    await refresh();
  };

  // Latest-values ref so the global hotkey listener can be registered once
  // instead of being torn down and re-added on every render.
  const hotkeyCtx = useRef({
    modalOpen,
    capturing,
    hotkeys,
    active,
    focusedId,
    workspaces,
  });
  hotkeyCtx.current = {
    modalOpen,
    capturing,
    hotkeys,
    active,
    focusedId,
    workspaces,
  };
  const hotkeyActions = useRef({
    closeWorkspace,
    quickNewTerminal,
    closeTerminal,
    changeFontSize,
    resetFontSize,
    toggleVoice,
  });
  hotkeyActions.current = {
    closeWorkspace,
    quickNewTerminal,
    closeTerminal,
    changeFontSize,
    resetFontSize,
    toggleVoice,
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const { modalOpen, capturing, hotkeys, active, focusedId, workspaces } =
        hotkeyCtx.current;
      const actions = hotkeyActions.current;
      if (modalOpen || capturing) return;
      const target = e.target as HTMLElement | null;
      if (
        target?.closest("input, select") ||
        target?.closest("textarea:not(.xterm-helper-textarea)")
      )
        return;
      for (const [action, hk] of Object.entries(hotkeys)) {
        if (!matchHotkey(e, hk)) continue;
        e.preventDefault();
        e.stopPropagation();
        switch (action) {
          case "newWorkspace":
            setShowNewWs(true);
            break;
          case "renameWorkspace":
            if (active) setRenameTrigger({ id: active.id, n: Date.now() });
            break;
          case "deleteWorkspace":
            if (active) actions.closeWorkspace(active.id);
            break;
          case "newTerminal":
            if (active) actions.quickNewTerminal(active.id);
            break;
          case "closeTerminal":
            if (focusedId) actions.closeTerminal(focusedId);
            break;
          case "maximizeTerminal": {
            const last = active?.terminals[active.terminals.length - 1];
            const target =
              focusedId && active?.terminals.some((t) => t.id === focusedId)
                ? focusedId
                : last?.id;
            if (target) {
              setExpandedId((prev) => (prev === target ? null : target));
            }
            break;
          }
          case "minimizeTerminal":
            setExpandedId(null);
            break;
          case "increaseFontSize":
            actions.changeFontSize(1);
            break;
          case "decreaseFontSize":
            actions.changeFontSize(-1);
            break;
          case "resetFontSize":
            actions.resetFontSize();
            break;
          case "toggleVoice":
            actions.toggleVoice();
            break;
          default: {
            const wsMatch = /^selectWorkspace([1-9])$/.exec(action);
            if (wsMatch) {
              const ws = workspaces[Number(wsMatch[1]) - 1];
              if (ws) {
                setActiveId(ws.id);
                setExpandedId(null);
              }
              break;
            }
            const termMatch = /^selectTerminal([1-9])$/.exec(action);
            if (termMatch) {
              const t = active?.terminals[Number(termMatch[1]) - 1];
              if (t) {
                setFocusedId(t.id);
                setExpandedId((cur) => (cur === t.id ? cur : null));
              }
            }
            break;
          }
        }
        return;
      }
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, []);

  useEffect(() => {
    if (!capturing) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturing(null);
        return;
      }
      if (["Meta", "Shift", "Control", "Alt"].includes(e.key)) return;
      const hk: Hotkey = {
        key: e.key,
        meta: e.metaKey,
        shift: e.shiftKey,
        ctrl: e.ctrlKey,
        alt: e.altKey,
      };
      if (!hk.meta && !hk.ctrl && !hk.alt) return;
      // Reject duplicates: dispatch stops at the first match, so a combo
      // already bound to another action would silently never fire.
      const conflict = HOTKEY_ACTIONS.find(
        (a) =>
          a.id !== capturing &&
          hotkeys[a.id] &&
          hotkeys[a.id].key === hk.key &&
          hotkeys[a.id].meta === hk.meta &&
          hotkeys[a.id].shift === hk.shift &&
          hotkeys[a.id].ctrl === hk.ctrl &&
          hotkeys[a.id].alt === hk.alt,
      );
      if (conflict) {
        pushSystemNotification(
          `Shortcut already assigned to "${conflict.label}"`,
        );
        setCapturing(null);
        return;
      }
      const next = { ...hotkeys, [capturing]: hk };
      setHotkeys(next);
      localStorage.setItem("hotkeys", JSON.stringify(next));
      setCapturing(null);
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, [capturing, hotkeys]);

  const resetHotkeys = () => {
    setHotkeys({ ...DEFAULT_HOTKEYS });
    localStorage.removeItem("hotkeys");
    setCapturing(null);
  };

  return (
    <MotionConfig reducedMotion={reduceMotion ? "always" : "user"}>
    <div className="app">
      <TopBar
        workspaces={workspaces}
        activeName={active?.name ?? null}
        items={notifItems}
        notificationCount={notifItems.reduce(
          (n, it) => n + (it.read ? 0 : 1),
          0,
        )}
        gridCols={gridCols}
        onGridLayoutChange={applyGridLayout}
        onMarkAllRead={markAllRead}
        onClearAll={clearAllNotifications}
        onJump={jumpToNotification}
        onUpdateClick={installUpdate}
        updateInstalling={updateInstalling}
        voiceEnabled={voiceEnabled}
        voiceStatus={voiceStatus}
        onVoiceClick={toggleVoice}
      />
      <div className="app-row">
        <Sidebar
        workspaces={workspaces}
        activeId={activeId}
        collapsed={sidebarCollapsed}
        onToggleCollapse={toggleSidebar}
        onSelect={(id) => {
          setActiveId(id);
          setExpandedId(null);
        }}
        onAdd={() => setShowNewWs(true)}
        onClose={closeWorkspace}
        onRename={renameWorkspace}
        onReorder={reorderWorkspacesLocal}
        onPersistOrder={persistWorkspaceOrder}
        onQuickNew={quickNewTerminal}
        onPickNew={openPicker}
        onOpenSettings={() => setShowSettings(true)}
        renameTrigger={renameTrigger}
        notifications={notifications}
        branches={branches}
      />

      <main className="main">
        {active ? (
          <>
            {workspaces
              .filter((w) => w.terminals.length > 0)
              .map((w) => (
                <TerminalGrid
                  key={w.id}
                  workspaceId={w.id}
                  terminals={w.terminals}
                  fontSize={fontSize}
                  gridCols={gridCols}
                  hidden={w.id !== active.id}
                  expandedId={w.id === active.id ? expandedId : null}
                  focusedId={focusedId}
                  exited={exited}
                  notifications={notifications}
                  contextUsage={contextUsage}
                  titles={titles}
                  branch={branches[w.id]}
                  onClearNotifications={clearNotifications}
                  onFocus={setFocusedId}
                  onResize={(id, pct) => resizeTerminalLocal(w.id, id, pct)}
                  onResizeEnd={(id, pct) => persistWidth(w.id, id, pct)}
                  onSwap={(a, b, before, width) =>
                    moveTerminalLocal(w.id, a, b, before, width)
                  }
                  onToggleExpand={setExpandedId}
                  onRestart={restartTerminal}
                  onClose={closeTerminal}
                />
              ))}
            {active.terminals.length === 0 && (
              <div className="empty">
                <p>No terminals running.</p>
                <button
                  className="add-terminal"
                  onClick={() => openPicker(active.id)}
                >
                  + New terminal
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="empty">
            <p>No workspaces. Create one to get started.</p>
            <button className="add-terminal" onClick={() => setShowNewWs(true)}>
              + New workspace
            </button>
          </div>
        )}
      </main>
      </div>

      <StatusBar
        workspaces={workspaces}
        agents={agents}
        exited={exited}
        branch={active ? branches[active.id] : undefined}
        voiceEnabled={voiceEnabled}
        voiceStatus={voiceStatus}
      />

      <AnimatePresence>
      {showResume && (
        <ResumeDialog
          items={resumeItems}
          savedAt={resumeSavedAt}
          onResume={resumeOne}
          onDismiss={dismissOne}
          onResumeAll={resumeAll}
          onDismissAll={dismissAll}
        />
      )}
      </AnimatePresence>

      <AnimatePresence>
      {showNewWs && (
        <motion.div
          className="modal-backdrop"
          {...backdropAnim}
          onClick={() => setShowNewWs(false)}
        >
          <motion.div
            className="modal"
            {...modalAnim}
            onClick={(e) => e.stopPropagation()}
          >
            <h2>New workspace</h2>
            <label>
              Name
              <input
                autoFocus
                value={newWsName}
                onChange={(e) => setNewWsName(e.target.value)}
                placeholder="my-project"
              />
            </label>
            <label>
              Folder
              <div className="modal-folder">
                <input
                  value={newWsCwd}
                  onChange={(e) => setNewWsCwd(e.target.value)}
                  placeholder="~ (home)"
                />
                <button onClick={pickFolder}>Browse…</button>
              </div>
            </label>
            <div className="modal-actions">
              <button onClick={() => setShowNewWs(false)}>Cancel</button>
              <button className="primary" onClick={createWorkspace}>
                Create
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
      </AnimatePresence>

      <AnimatePresence>
      {showAgentPicker && (
        <motion.div
          className="modal-backdrop blur-strong"
          {...backdropAnim}
          onClick={() => setShowAgentPicker(false)}
        >
          <motion.div
            className="modal"
            {...modalAnim}
            onClick={(e) => e.stopPropagation()}
          >
            <h2>New terminal</h2>
            <div className="agent-list">
              {agents.map((a) => (
                <button
                  key={a.id}
                  className="agent-option"
                  disabled={!a.available}
                  onClick={() => chooseAgent(a.id)}
                >
                  <span className={`pane-badge agent-${a.id}`}>{a.id}</span>
                  <span className="agent-option-label">{a.label}</span>
                  {!a.available && (
                    <span className="agent-option-missing">not found</span>
                  )}
                </button>
              ))}
            </div>
            <label className="picker-default">
              <input
                type="checkbox"
                checked={pickerSaveDefault}
                onChange={(e) => setPickerSaveDefault(e.target.checked)}
              />
              Save as default (quick-add skips this dialog)
            </label>
          </motion.div>
        </motion.div>
      )}
      </AnimatePresence>

      <AnimatePresence>
      {showSettings && (
        <motion.div
          className="modal-backdrop"
          {...backdropAnim}
          onClick={() => {
            setShowSettings(false);
            setCapturing(null);
          }}
        >
          <motion.div
            className="modal settings-modal"
            {...modalAnim}
            onClick={(e) => e.stopPropagation()}
          >
            <h2>Settings</h2>
            <div className="settings-body">
              <nav className="settings-nav">
                {SETTINGS_SECTIONS.map((s) => (
                  <button
                    key={s.id}
                    className={`settings-nav-item ${
                      settingsSection === s.id ? "active" : ""
                    }`}
                    onClick={() => {
                      setSettingsSection(s.id);
                      setCapturing(null);
                    }}
                  >
                    {s.label}
                  </button>
                ))}
              </nav>
              <div className="settings-content">
                {settingsSection === "terminal" && (
                  <>
                    <div className="settings-title">Terminal font size</div>
                    <div className="font-stepper">
                      <button
                        className="font-stepper-btn"
                        onClick={() => changeFontSize(-1)}
                        disabled={fontSize <= MIN_FONT_SIZE}
                      >
                        −
                      </button>
                      <span className="font-stepper-value">{fontSize}px</span>
                      <button
                        className="font-stepper-btn"
                        onClick={() => changeFontSize(1)}
                        disabled={fontSize >= MAX_FONT_SIZE}
                      >
                        +
                      </button>
                    </div>
                    <div className="settings-title">Grid layout</div>
                    <div className="grid-cols-row">
                      <span className="grid-cols-label">
                        Terminals side-by-side
                      </span>
                      <div className="grid-cols-picker">
                        {GRID_COL_OPTIONS.map((n) => (
                          <button
                            key={n}
                            className={`grid-cols-option ${
                              gridCols === n ? "active" : ""
                            }`}
                            onClick={() => applyGridLayout(n)}
                          >
                            {n}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="settings-title">Default shell</div>
                    <div className="voice-row">
                      <select
                        className="voice-select"
                        value={defaultShell}
                        onChange={(e) => {
                          const shell = e.target.value;
                          setDefaultShell(shell);
                          if (shell) {
                            localStorage.setItem("defaultShell", shell);
                          } else {
                            localStorage.removeItem("defaultShell");
                          }
                        }}
                      >
                        <option value="">System default</option>
                        {(defaultShell &&
                        !availableShells.includes(defaultShell)
                          ? [defaultShell, ...availableShells]
                          : availableShells
                        ).map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </div>
                  </>
                )}
                {settingsSection === "voice" && (
                  <>
                    <div className="settings-title">Voice input</div>
                    <div className="toggle-row">
                      <div className="toggle-row-text">
                        <span className="toggle-row-label">
                          Enable voice input
                        </span>
                        <span className="toggle-row-desc">
                          Speech-to-text into the focused terminal
                        </span>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={voiceEnabled}
                        aria-label="Enable voice input"
                        className={`toggle-switch ${voiceEnabled ? "on" : ""}`}
                        disabled={micAvailable === false && !voiceEnabled}
                        onClick={() => updateVoiceEnabled(!voiceEnabled)}
                      >
                        <span className="toggle-knob" />
                      </button>
                    </div>
                    {micAvailable === false && !voiceEnabled && (
                      <div className="voice-hint">
                        No microphone detected — connect one to enable voice
                        input.
                      </div>
                    )}
                    {voiceEnabled && (
                      <>
                        <div className="voice-row">
                          <span className="hotkey-label">Language</span>
                          <select
                            className="voice-select"
                            value={voiceLang}
                            onChange={(e) => updateVoiceLang(e.target.value)}
                          >
                            {VOICE_LANGUAGES.map((l) => (
                              <option key={l.code} value={l.code}>
                                {l.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="voice-model-list">
                          {voiceModels.length === 0 && (
                            <div className="voice-hint">Loading models…</div>
                          )}
                          {voiceModels.length > 0 &&
                            !voiceModels.some((m) => m.downloaded) && (
                              <div className="voice-hint">
                                Download a model to start using voice input.
                              </div>
                            )}
                          {voiceModels.map((m) => (
                            <div className="hotkey-row" key={m.id}>
                              <span
                                className="hotkey-label"
                                title={m.description}
                              >
                                {m.display_name}
                                <span className="voice-model-size">
                                  {m.size_label}
                                </span>
                              </span>
                              {voiceDl?.id === m.id ? (
                                <span className="hotkey-capturing">
                                  {Math.floor(voiceDl.percent)}%
                                </span>
                              ) : m.active ? (
                                <span className="voice-chip active">
                                  Active
                                </span>
                              ) : m.downloaded ? (
                                <button
                                  className="hotkey-chip"
                                  onClick={() => selectVoiceModel(m.id)}
                                >
                                  Use
                                </button>
                              ) : (
                                <button
                                  className="hotkey-chip"
                                  onClick={() => downloadVoiceModel(m.id)}
                                  disabled={voiceDl !== null}
                                >
                                  Download
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </>
                )}
                {settingsSection === "shortcuts" && (
                  <>
                    <div className="settings-title">Keyboard shortcuts</div>
                    <div className="hotkey-list">
                      {HOTKEY_ACTIONS.map((a) => (
                        <div className="hotkey-row" key={a.id}>
                          <span className="hotkey-label">{a.label}</span>
                          {capturing === a.id ? (
                            <span className="hotkey-capturing">
                              Press shortcut… (Esc cancels)
                            </span>
                          ) : (
                            <button
                              className="hotkey-chip"
                              onClick={() => setCapturing(a.id)}
                              title="Click to rebind"
                            >
                              {formatHotkey(hotkeys[a.id])}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                    <div className="settings-section-actions">
                      <button onClick={resetHotkeys}>Reset defaults</button>
                    </div>
                  </>
                )}
                {settingsSection === "accessibility" && (
                  <>
                    <div className="settings-title">Accessibility</div>
                    <div className="toggle-row">
                      <div className="toggle-row-text">
                        <span className="toggle-row-label">Reduce motion</span>
                        <span className="toggle-row-desc">
                          Minimize animations and transitions across the app
                        </span>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={reduceMotion}
                        aria-label="Reduce motion"
                        className={`toggle-switch ${reduceMotion ? "on" : ""}`}
                        onClick={() => updateReduceMotion(!reduceMotion)}
                      >
                        <span className="toggle-knob" />
                      </button>
                    </div>
                  </>
                )}
                {settingsSection === "about" && (
                  <>
                    <div className="settings-title">Terra Swarm</div>
                    <div className="voice-row">
                      <span className="hotkey-label">Version</span>
                      <span className="voice-chip">
                        {appVersion || "unknown"}
                      </span>
                    </div>
                    <div className="settings-title">Updates</div>
                    {updateVersion ? (
                      <div className="voice-row">
                        <span className="hotkey-label">
                          Version {updateVersion} available
                        </span>
                        <button
                          className="hotkey-chip"
                          disabled={updateInstalling}
                          onClick={installUpdate}
                        >
                          {updateInstalling ? "Installing…" : "Update now"}
                        </button>
                      </div>
                    ) : (
                      <div className="voice-row">
                        <span className="hotkey-label">
                          {updateCheckState === "checking"
                            ? "Checking for updates…"
                            : updateCheckState === "uptodate"
                              ? "You're up to date"
                              : updateCheckState === "error"
                                ? "Update check failed"
                                : "Checks automatically every hour"}
                        </span>
                        <button
                          className="hotkey-chip"
                          disabled={updateCheckState === "checking"}
                          onClick={manualUpdateCheck}
                        >
                          Check for updates
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
            <div className="modal-actions">
              <button
                className="primary"
                onClick={() => {
                  setShowSettings(false);
                  setCapturing(null);
                }}
              >
                Done
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
      </AnimatePresence>
    </div>
    </MotionConfig>
  );
}

export default App;
