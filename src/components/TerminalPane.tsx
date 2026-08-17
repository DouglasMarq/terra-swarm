import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../api";
import type { OutputChunk } from "../types";
import { registerTerminal, unregisterTerminal, getTerminal } from "../terminalRegistry";
import {
  createFitScheduler,
  createTerminalResizeQueue,
} from "../lib/terminalFitScheduler";
import "@xterm/xterm/css/xterm.css";

interface Props {
  id: string;
  command: string;
  fontSize: number;
  exited: boolean;
  expanded: boolean;
  basis: number;
  height: string;
  entering: boolean;
  dragOver: boolean;
  notifications: number;
  contextUsed?: number;
  title?: string;
  branch?: string;
  onClearNotifications: () => void;
  focused: boolean;
  onFocus: () => void;
  onToggleExpand: () => void;
  onRestart: () => void;
  /** Legacy close means the visual terminal close action. */
  onClose: () => void;
  /** Detach a tab without ending its PTY, when the orchestration model is on. */
  onDetach?: () => void;
  /** Explicitly destructive PTY action; intentionally separate from detach. */
  onKill?: () => void;
  /** Hidden tabs remain mounted so switching tabs never kills a PTY. */
  hidden?: boolean;
}

function MaximizeIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function MinimizeIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="4 14 10 14 10 20" />
      <polyline points="20 10 14 10 14 4" />
      <line x1="14" y1="10" x2="21" y2="3" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

export function TerminalPane(props: Props) {
  const {
    id,
    command,
    fontSize,
    exited,
    expanded,
    basis,
    height,
    entering,
    dragOver,
    notifications,
    contextUsed,
    title,
    focused,
    hidden = false,
  } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const resizeQueueRef = useRef<ReturnType<typeof createTerminalResizeQueue> | null>(null);
  const appliedFontSize = useRef(fontSize);
  // Keep the long-lived xterm effect aware of the latest backend lifecycle.
  // The component intentionally survives a PTY exit so it can show scrollback
  // and restart controls, but geometry observers must stop addressing a PTY
  // that no longer exists.
  const exitedRef = useRef(exited);
  exitedRef.current = exited;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: "'SF Mono', Menlo, Monaco, 'Courier New', monospace",
      fontSize,
      cursorBlink: true,
      macOptionIsMeta: true,
      scrollback: 10000,
      theme: {
        background: "#0c0c0e",
        foreground: "#d4d4d8",
        cursor: "#d4d4d8",
        selectionBackground: "#3f3f46",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    registerTerminal(id, term);

    let disposed = false;

    // Backend IPC failures (dead PTY, full input queue) must be visible
    // somewhere; throttle so a dead terminal can't spam the console.
    let lastWarnAt = 0;
    const warnThrottled = (what: string, err: unknown) => {
      const now = Date.now();
      if (now - lastWarnAt < 2000) return;
      lastWarnAt = now;
      console.warn(`[terminal ${id}] ${what} failed:`, err);
    };

    term.attachCustomKeyEventHandler((e) => {
      if (
        (e.type === "keydown" || e.type === "keypress") &&
        e.key === "Enter" &&
        e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        if (e.type === "keydown") {
          e.preventDefault();
          if (!exitedRef.current) {
            api.writeTerminal(id, "\n").catch((err) => warnThrottled("write", err));
          }
        }
        return false;
      }
      return true;
    });

    const resizeQueue = createTerminalResizeQueue(({ cols, rows }) => {
      // A skipped resize must reject rather than resolve: the queue only
      // remembers dimensions after a successful send, and a PTY exit can be
      // followed by a restart with the same geometry.
      if (exitedRef.current) return Promise.reject(new Error("terminal exited"));
      return api.resizeTerminal(id, cols, rows).catch((err) => {
        // An exit event can race an in-flight resize. Once the UI knows the
        // process is gone this is expected lifecycle, not an actionable error.
        if (!exitedRef.current) warnThrottled("resize", err);
        throw err;
      });
    });

    // FitAddon intentionally returns a minimum 2x1 geometry even for a
    // display:none parent. Check the real box first so a zero-sized mount
    // never poisons the PTY with a tiny resize.
    const fitAndSend = (): void => {
      try {
        if (exitedRef.current) return;
        const box = container.getBoundingClientRect();
        if (!(box.width > 0 && box.height > 0)) return;
        const d = fit.proposeDimensions();
        if (
          !d ||
          !Number.isFinite(d.cols) ||
          !Number.isFinite(d.rows) ||
          d.cols < 1 ||
          d.rows < 1
        ) {
          return;
        }
        fit.fit();
        if (term.cols < 1 || term.rows < 1) return;
        resizeQueue.request({ cols: term.cols, rows: term.rows });
      } catch {
        // The renderer can still be measuring while the pane is entering the
        // layout. The observer/focus/visibility signals will schedule a new
        // coalesced fit once a real box exists.
      }
    };

    const fitScheduler = createFitScheduler(fitAndSend);
    fitRef.current = fitScheduler.schedule;
    resizeQueueRef.current = resizeQueue;
    fitScheduler.schedule();

    // Output pipeline with real backpressure: each chunk is handed to xterm
    // with a completion callback, and the next chunk is only drained once
    // xterm has parsed the previous one. If the producer outruns the parser
    // (huge bursts, throttled timers in an occluded window), the buffer is
    // capped and the oldest data is dropped instead of growing without bound.
    const WRITE_BUDGET = 32768;
    const MAX_BUFFERED = 8 * 1024 * 1024;
    let writeBuf = "";
    let writing = false;
    const drain = () => {
      if (disposed || writing || !writeBuf) return;
      writing = true;
      let n = Math.min(writeBuf.length, WRITE_BUDGET);
      if (n < writeBuf.length) {
        // never split a surrogate pair at the cut
        const c = writeBuf.charCodeAt(n - 1);
        if (c >= 0xd800 && c <= 0xdbff) n += 1;
      }
      const data = writeBuf.slice(0, n);
      writeBuf = writeBuf.slice(n);
      term.write(data, () => {
        writing = false;
        drain();
      });
    };
    const enqueueOutput = (data: string) => {
      if (disposed || !data) return;
      if (writeBuf.length + data.length > MAX_BUFFERED) {
        writeBuf =
          writeBuf.slice(-Math.floor(MAX_BUFFERED / 4)) +
          "\r\n\x1b[33m[...output dropped...]\x1b[0m\r\n";
      }
      writeBuf += data;
      drain();
    };

    // Exactly-once delivery across listener attach: events carry a cumulative
    // byte total; the backlog snapshot covers everything up to its total, so
    // buffered events already included in it are dropped.
    let live = false;
    let backlogTotal = 0;
    const preLive: OutputChunk[] = [];
    let unlisten: UnlistenFn | null = null;
    (async () => {
      const un = await listen<OutputChunk>(`pty-output-${id}`, (e) => {
        if (disposed) return;
        if (!live) {
          preLive.push(e.payload);
          return;
        }
        enqueueOutput(e.payload.data);
      });
      if (disposed) {
        un();
        return;
      }
      unlisten = un;
      try {
        const backlog = await api.terminalBacklog(id);
        if (disposed) return;
        if (backlog.data) enqueueOutput(backlog.data);
        backlogTotal = backlog.total;
      } catch {
        // Terminal may already be gone backend-side; the live stream (if any)
        // still works, and a dead process surfaces via terminal-exit.
      }
      live = true;
      for (const c of preLive) {
        if (c.total > backlogTotal) enqueueOutput(c.data);
      }
      preLive.length = 0;
    })();

    // Serialize writes and retry while the backend input channel is full
    // (child not reading stdin): without this, keystrokes and pastes are
    // silently dropped under backpressure.
    let writeChain: Promise<void> = Promise.resolve();
    const dataSub = term.onData((data) => {
      if (disposed || exitedRef.current) return;
      writeChain = writeChain.then(async () => {
        for (let attempt = 0; ; attempt++) {
          if (disposed || exitedRef.current) return;
          try {
            await api.writeTerminal(id, data);
            return;
          } catch (err) {
            if (!String(err).includes("busy") || attempt >= 30) {
              warnThrottled("write", err);
              return;
            }
            await new Promise((r) =>
              setTimeout(r, 25 * Math.min(attempt + 1, 10)),
            );
          }
        }
      });
    });

    const observer = new ResizeObserver(() => {
      fitScheduler.schedule();
    });
    observer.observe(container);

    const onWindowResize = () => fitScheduler.schedule();
    const onVisibilityChange = () => fitScheduler.schedule();
    window.addEventListener("resize", onWindowResize);
    window.addEventListener("focus", onWindowResize);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      disposed = true;
      writeBuf = "";
      fitScheduler.dispose();
      resizeQueue.dispose();
      observer.disconnect();
      window.removeEventListener("resize", onWindowResize);
      window.removeEventListener("focus", onWindowResize);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      dataSub.dispose();
      unlisten?.();
      unregisterTerminal(id, term);
      term.dispose();
      fitRef.current = null;
      resizeQueueRef.current = null;
    };
  }, [id]);

  const previousExited = useRef(exited);

  useEffect(() => {
    if (appliedFontSize.current === fontSize) return;
    appliedFontSize.current = fontSize;
    const term = getTerminal(id);
    if (!term) return;
    term.options.fontSize = fontSize;
    fitRef.current?.();
  }, [fontSize, id]);

  // A hidden workbench tab can keep the same box dimensions while its
  // `display` state changes. ResizeObserver is not guaranteed to report that
  // transition, so treat visibility/focus/preset changes as explicit fit
  // signals as well.
  useEffect(() => {
    const resumed = previousExited.current && !exited;
    previousExited.current = exited;
    if (resumed) resizeQueueRef.current?.reset();
    fitRef.current?.();
  }, [basis, exited, expanded, focused, height, hidden, id]);

  return (
    <div
      ref={rootRef}
      data-term-id={id}
      className={`pane ${expanded ? "expanded" : ""} ${entering ? "pane-enter" : ""} ${
        dragOver ? "drag-over" : ""
      } ${focused ? "focused" : ""}`}
      style={{
        flex: `1 1 calc(${basis}% - 12px)`,
        height,
        display: hidden ? "none" : undefined,
      }}
      aria-hidden={hidden}
      onMouseDown={() => {
        if (hidden) return;
        props.onFocus();
        if (notifications > 0) props.onClearNotifications();
      }}
    >
      <div className="pane-header">
        <div className="pane-header-left">
          <span className={`pane-badge agent-${command.split(" ")[0]}`} title={command}>
            {command.split(" ")[0]}
          </span>
          {title && (
            <span className="pane-title" title={title}>
              {title}
            </span>
          )}
          {contextUsed != null && !exited && (
            <span
              className={`pane-ctx ${
                contextUsed >= 85 ? "high" : contextUsed >= 60 ? "mid" : ""
              }`}
              title={`Context used: ${contextUsed}%`}
            >
              <span className="pane-ctx-bar">
                <span style={{ transform: `scaleX(${contextUsed / 100})` }} />
              </span>
              {contextUsed}%
            </span>
          )}
          {notifications > 0 && (
            <span className="pane-bell" key={notifications} title="Notifications">
              <BellIcon />
              {notifications}
            </span>
          )}
        </div>
        <div className="pane-actions">
          <button
            className="pane-btn"
            title={expanded ? "Back to grid" : "Maximize"}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={props.onToggleExpand}
          >
            {expanded ? <MinimizeIcon /> : <MaximizeIcon />}
          </button>
          <button
            className="pane-btn pane-close"
            title="Close terminal"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={props.onDetach ?? props.onClose}
          >
            ×
          </button>
          {props.onKill && (
            <button
              className="pane-btn pane-kill"
              title="Kill PTY"
              aria-label="Kill PTY"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={props.onKill}
            >
              ■
            </button>
          )}
        </div>
      </div>
      <div className="pane-body" ref={containerRef} />
      {exited && (
        <div className="pane-overlay">
          <span>process exited</span>
          <div className="pane-overlay-actions">
            <button onClick={props.onRestart}>Restart</button>
            <button onClick={props.onDetach ?? props.onClose}>Detach</button>
            {props.onKill && <button onClick={props.onKill}>Kill</button>}
          </div>
        </div>
      )}
    </div>
  );
}
