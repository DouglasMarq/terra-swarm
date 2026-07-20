import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../api";
import type { OutputChunk } from "../types";
import { registerTerminal, unregisterTerminal, getTerminal } from "../terminalRegistry";
import "@xterm/xterm/css/xterm.css";

const MIN_PCT = 15;

interface Props {
  id: string;
  command: string;
  fontSize: number;
  exited: boolean;
  expanded: boolean;
  anyExpanded: boolean;
  basis: number;
  height: string;
  entering: boolean;
  dragging: boolean;
  dragOver: boolean;
  notifications: number;
  contextUsed?: number;
  title?: string;
  branch?: string;
  onClearNotifications: () => void;
  focused: boolean;
  onFocus: () => void;
  onHeaderMouseDown: (e: React.MouseEvent) => void;
  onResize: (pct: number) => void;
  onResizeEnd: (pct: number) => void;
  onToggleExpand: () => void;
  onRestart: () => void;
  onClose: () => void;
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

function BranchIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
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
  const { id, command, fontSize, exited, expanded, anyExpanded, basis, height, entering, dragging, dragOver, notifications, contextUsed, title, branch, focused } =
    props;
  const containerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const appliedFontSize = useRef(fontSize);

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
          api.writeTerminal(id, "\n").catch((err) => warnThrottled("write", err));
        }
        return false;
      }
      return true;
    });

    let lastCols = 0;
    let lastRows = 0;
    // fit() silently no-ops while the renderer has no cell metrics yet
    // (fresh webview at startup, or open() ran inside a display:none grid),
    // and a single full-width pane never changes size afterwards, so a failed
    // initial fit would stick the terminal at 80x24 until a window resize.
    // Report failure and retry with backoff until the fit actually takes.
    // proposeDimensions() can also return degenerate-but-truthy results
    // ({cols:2,rows:1} for a 0-height container, {NaN,NaN} inside a
    // display:none subtree) — treat those as failures so the retry loop
    // survives instead of poisoning lastCols/lastRows.
    const fitAndSend = (): boolean => {
      try {
        const d = fit.proposeDimensions();
        if (
          !d ||
          !Number.isFinite(d.cols) ||
          !Number.isFinite(d.rows) ||
          d.cols < 10 ||
          d.rows < 3
        ) {
          return false;
        }
        fit.fit();
        if (term.cols !== lastCols || term.rows !== lastRows) {
          lastCols = term.cols;
          lastRows = term.rows;
          api
            .resizeTerminal(id, term.cols, term.rows)
            .catch((err) => warnThrottled("resize", err));
        }
        return true;
      } catch {
        return false;
      }
    };
    fitRef.current = fitAndSend;

    // ConPTY (and some TUIs) can miss the very first resize because it lands
    // before the child has attached its console handler, and same-size
    // resizes are deduped afterwards — so after the first valid fit, nudge
    // the PTY with a rows-1/rows pair to force fresh resize events the
    // child cannot miss.
    const confirmTimers: number[] = [];
    let confirmed = false;
    const confirmResize = () => {
      if (disposed || confirmed) return;
      confirmed = true;
      for (const delay of [400, 1500]) {
        confirmTimers.push(
          window.setTimeout(() => {
            if (disposed || term.cols < 10 || term.rows < 4) return;
            if (term.cols !== lastCols || term.rows !== lastRows) return;
            const { cols, rows } = term;
            api
              .resizeTerminal(id, cols, rows - 1)
              .then(() => api.resizeTerminal(id, cols, rows))
              .catch(() => {});
          }, delay),
        );
      }
    };

    let fitTimer = 0;
    const scheduleFit = (attempt = 0) => {
      if (disposed || fitTimer) return;
      fitTimer = window.setTimeout(
        () => {
          fitTimer = 0;
          if (disposed) return;
          if (fitAndSend()) {
            confirmResize();
            return;
          }
          if (attempt >= 50) return;
          scheduleFit(attempt + 1);
        },
        attempt === 0 ? 0 : Math.min(1000, 100 * 2 ** Math.min(attempt, 3)),
      );
    };

    const raf = requestAnimationFrame(() => scheduleFit());
    const retry = setTimeout(() => scheduleFit(), 800);

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
      writeChain = writeChain.then(async () => {
        for (let attempt = 0; ; attempt++) {
          if (disposed) return;
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

    let resizeRaf = 0;
    const observer = new ResizeObserver(() => {
      if (resizeRaf) return;
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        if (fitAndSend()) confirmResize();
        else scheduleFit();
      });
    });
    observer.observe(container);

    return () => {
      disposed = true;
      writeBuf = "";
      cancelAnimationFrame(raf);
      cancelAnimationFrame(resizeRaf);
      clearTimeout(retry);
      clearTimeout(fitTimer);
      for (const t of confirmTimers) clearTimeout(t);
      observer.disconnect();
      dataSub.dispose();
      unlisten?.();
      unregisterTerminal(id, term);
      term.dispose();
      fitRef.current = null;
    };
  }, [id]);

  useEffect(() => {
    if (appliedFontSize.current === fontSize) return;
    appliedFontSize.current = fontSize;
    const term = getTerminal(id);
    if (!term) return;
    term.options.fontSize = fontSize;
    fitRef.current?.();
  }, [fontSize, id]);

  const startResize = (e: React.MouseEvent, edge: "left" | "right") => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const pane = rootRef.current;
    const rows = pane?.closest(".term-rows") as HTMLElement | null;
    if (!pane || !rows) return;
    const startX = e.clientX;
    // Percentages resolve against the container's content box, which excludes
    // its 10px side padding; the basis prop (not the rendered width, which
    // includes flex-grow slack) is the true starting share.
    const total = rows.getBoundingClientRect().width - 20;
    const startPct = basis;
    let last = startPct;
    document.body.classList.add("col-resizing");
    const onMove = (ev: MouseEvent) => {
      const raw = ((ev.clientX - startX) / total) * 100;
      const delta = edge === "right" ? raw : -raw;
      last = Math.min(100, Math.max(MIN_PCT, startPct + delta));
      props.onResize(last);
    };
    const onUp = () => {
      document.body.classList.remove("col-resizing");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      props.onResizeEnd(last);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div
      ref={rootRef}
      data-term-id={id}
      className={`pane ${expanded ? "expanded" : ""} ${entering ? "pane-enter" : ""} ${dragging ? "dragging" : ""} ${
        dragOver ? "drag-over" : ""
      } ${focused ? "focused" : ""}`}
      style={{ flex: `1 1 calc(${basis}% - 10px)`, height }}
      onMouseDown={() => {
        props.onFocus();
        if (notifications > 0) props.onClearNotifications();
      }}
    >
      <div className="pane-header" onMouseDown={props.onHeaderMouseDown}>
        <div className="pane-header-left">
          <span className={`pane-badge agent-${command.split(" ")[0]}`} title={command}>
            {command.split(" ")[0]}
          </span>
          {title && (
            <span className="pane-title" title={title}>
              {title}
            </span>
          )}
          {branch && (
            <span className="pane-branch" title={`Git branch: ${branch}`}>
              <BranchIcon />
              {branch}
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
                <span
                  className="pane-ctx-fill"
                  style={{ width: `${contextUsed}%` }}
                />
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
            onClick={props.onClose}
          >
            ×
          </button>
        </div>
      </div>
      <div className="pane-body" ref={containerRef} />
      {exited && (
        <div className="pane-overlay">
          <span>process exited</span>
          <div className="pane-overlay-actions">
            <button onClick={props.onRestart}>Restart</button>
            <button onClick={props.onClose}>Close</button>
          </div>
        </div>
      )}
      {!expanded && !anyExpanded && (
        <>
          <div
            className="pane-resize left"
            onMouseDown={(e) => startResize(e, "left")}
          />
          <div
            className="pane-resize"
            onMouseDown={(e) => startResize(e, "right")}
          />
        </>
      )}
    </div>
  );
}
