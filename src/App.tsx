import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api } from "./api";
import type {
  AgentInfo,
  ContextPayload,
  ExitPayload,
  NotificationItem,
  NotificationPayload,
  TitlePayload,
  Workspace,
} from "./types";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TerminalGrid } from "./components/TerminalGrid";
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

const DEFAULT_HOTKEYS: Record<string, Hotkey> = {
  newWorkspace: mk("n", true, true),
  renameWorkspace: mk("r", true, true),
  deleteWorkspace: mk("Backspace", true, true),
  newTerminal: mk("t", true),
  closeTerminal: mk("w", true),
  maximizeTerminal: mk("Enter", true),
  minimizeTerminal: mk("Enter", true, true),
  increaseFontSize: mk("=", true),
  decreaseFontSize: mk("-", true),
  resetFontSize: mk("0", true),
};

const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 32;
const DEFAULT_FONT_SIZE = 13;
const MAX_NOTIF_ITEMS = 50;
const BRANCH_POLL_MS = 10000;

function loadFontSize(): number {
  const raw = Number(localStorage.getItem("termFontSize"));
  return Number.isFinite(raw) && raw >= MIN_FONT_SIZE && raw <= MAX_FONT_SIZE
    ? Math.round(raw)
    : DEFAULT_FONT_SIZE;
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
  s += h.key.length === 1 ? h.key.toUpperCase() : h.key;
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
  const [capturing, setCapturing] = useState<string | null>(null);
  const [renameTrigger, setRenameTrigger] = useState<{
    id: string;
    n: number;
  } | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("sidebarCollapsed") === "1",
  );
  const [fontSize, setFontSize] = useState<number>(loadFontSize);
  const inited = useRef(false);
  const liveIdsRef = useRef<Set<string>>(new Set());
  const notifKeyRef = useRef(1);
  const spawnSeqRef = useRef<Record<string, number>>({});
  const lastFocusByWs = useRef<Record<string, string>>({});
  const prevActiveId = useRef<string | null>(null);

  useEffect(() => {
    liveIdsRef.current = new Set(
      workspaces.flatMap((w) => w.terminals.map((t) => t.id)),
    );
  }, [workspaces]);

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

  // One-time init: load workspaces and respawn persisted terminals. Guarded
  // so React StrictMode's double-invoke doesn't spawn everything twice.
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
        for (const r of running) {
          liveIdsRef.current.add(r.id);
          spawnSeqRef.current[r.id] = r.seq;
        }
        for (const ws of list) {
          for (const t of ws.terminals) {
            if (runningIds.has(t.id)) continue;
            // Register intent synchronously so an exit event for a
            // fast-crashing process is never dropped by the render-delay gap.
            liveIdsRef.current.add(t.id);
            api
              .spawnTerminal(ws.id, t.command, t.id)
              .then((res) => {
                spawnSeqRef.current[t.id] = res.seq;
              })
              .catch((err) => {
                console.error(`failed to spawn terminal ${t.id}:`, err);
                setExited((prev) => ({ ...prev, [t.id]: null }));
              });
          }
        }
      } catch (err) {
        console.error("initialization failed:", err);
      }
    })();

    api.detectAgents().then(setAgents).catch(() => {});
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
  const modalOpen = showNewWs || showAgentPicker || showSettings;

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
    const res = await api.spawnTerminal(wsId, command);
    liveIdsRef.current.add(res.meta.id);
    spawnSeqRef.current[res.meta.id] = res.seq;
    setFocusedId(res.meta.id);
    await refresh();
  };

  const openPicker = (wsId: string) => {
    setActiveId(wsId);
    setExpandedId(null);
    setPickerTarget(wsId);
    setPickerSaveDefault(!!defaultAgent);
    setShowAgentPicker(true);
  };

  const quickNewTerminal = (wsId: string) => {
    setActiveId(wsId);
    setExpandedId(null);
    const defAvailable =
      defaultAgent &&
      agents.some((a) => a.id === defaultAgent && a.available);
    if (defAvailable) {
      spawnTerminalInto(wsId, defaultAgent).catch(() => {});
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
      await spawnTerminalInto(pickerTarget, agentId).catch(() => {});
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
      // process and double-emit output.
      await api.stopTerminal(id);
      const res = await api.spawnTerminal(active.id, command, id);
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
    api.setTerminalWidth(wsId, id, pct).catch(() => {});
  };

  const swapTerminalsLocal = (wsId: string, a: string, b: string) => {
    setWorkspaces((prev) =>
      prev.map((w) => {
        if (w.id !== wsId) return w;
        const ia = w.terminals.findIndex((t) => t.id === a);
        const ib = w.terminals.findIndex((t) => t.id === b);
        if (ia < 0 || ib < 0) return w;
        const next = [...w.terminals];
        [next[ia], next[ib]] = [next[ib], next[ia]];
        return { ...w, terminals: next };
      }),
    );
  };

  const persistOrder = (wsId: string, order: string[]) => {
    api.reorderTerminals(wsId, order).catch(() => {});
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
          const base = dir.split("/").filter(Boolean).pop();
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

  // Latest-values ref so the global hotkey listener can be registered once
  // instead of being torn down and re-added on every render.
  const hotkeyCtx = useRef({ modalOpen, capturing, hotkeys, active, focusedId });
  hotkeyCtx.current = { modalOpen, capturing, hotkeys, active, focusedId };
  const hotkeyActions = useRef({
    closeWorkspace,
    quickNewTerminal,
    closeTerminal,
    changeFontSize,
    resetFontSize,
  });
  hotkeyActions.current = {
    closeWorkspace,
    quickNewTerminal,
    closeTerminal,
    changeFontSize,
    resetFontSize,
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const { modalOpen, capturing, hotkeys, active, focusedId } =
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
    <div className="app">
      <TopBar
        workspaces={workspaces}
        activeName={active?.name ?? null}
        items={notifItems}
        onMarkAllRead={markAllRead}
        onClearAll={clearAllNotifications}
        onJump={jumpToNotification}
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
        onQuickNew={quickNewTerminal}
        onPickNew={openPicker}
        onOpenSettings={() => setShowSettings(true)}
        renameTrigger={renameTrigger}
        notifications={notifications}
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
                  onSwap={(a, b) => swapTerminalsLocal(w.id, a, b)}
                  onDropOrder={(order) => persistOrder(w.id, order)}
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
        active={active}
        agents={agents}
        exited={exited}
      />

      {showNewWs && (
        <div className="modal-backdrop" onClick={() => setShowNewWs(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
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
          </div>
        </div>
      )}

      {showAgentPicker && (
        <div
          className="modal-backdrop blur-strong"
          onClick={() => setShowAgentPicker(false)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
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
          </div>
        </div>
      )}

      {showSettings && (
        <div
          className="modal-backdrop"
          onClick={() => {
            setShowSettings(false);
            setCapturing(null);
          }}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Settings</h2>
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
            <div className="modal-actions">
              <button onClick={resetHotkeys}>Reset defaults</button>
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
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
