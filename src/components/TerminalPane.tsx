import { deriveAgentStatus } from "../domain/agentStatus";
import { useMcpStore } from "../stores/mcpStore";
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
import { Maximize2, Minimize2, GitBranch } from "lucide-react";
import { useT } from "../i18n";
import { usePreferencesStore } from "../stores/preferencesStore";
import { terminalFontStack } from "../lib/terminalFonts";
import { PaneActionsMenu, type PaneMenuGroups } from "./workbench/PaneActionsMenu";
import "@xterm/xterm/css/xterm.css";
import "./terminal-pane.css";

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
  /** Branch of the agent's own git worktree, when it is isolated. */
  worktreeBranch?: string;
  /** Opens the review of the worktree's changes. */
  onOpenReview?: () => void;
  /** Task title (or name) shown first; falls back to the command. */
  label?: string;
  /** "claude 2" / "Lyra · claude" under or beside the label. */
  tag?: string;
  /** Latest unread message from the agent, shown in the attention strip. */
  attentionMessage?: string | null;
  /** Lifecycle actions for the "…" menu. */
  menu?: PaneMenuGroups;
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
    label,
    tag,
    attentionMessage,
    menu,
  } = props;
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const resizeQueueRef = useRef<ReturnType<typeof createTerminalResizeQueue> | null>(null);
  const appliedFontSize = useRef(fontSize);
  const fontFamily = terminalFontStack(usePreferencesStore((state) => state.terminalFontFamily));
  const appliedFontFamily = useRef(fontFamily);
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
      fontFamily,
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

  useEffect(() => {
    if (appliedFontFamily.current === fontFamily) return;
    appliedFontFamily.current = fontFamily;
    const term = getTerminal(id);
    if (!term) return;
    term.options.fontFamily = fontFamily;
    // A new family changes the cell size: refit so cols/rows follow.
    fitRef.current?.();
  }, [fontFamily, id]);

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

  const reported = useMcpStore((state) => state.statuses[id]?.state);
  const kind = command.split(" ")[0] || "shell";
  const primary = label || kind;
  const secondary = tag && tag !== primary ? tag : null;
  const attention = notifications > 0 && Boolean(attentionMessage);
  const status = deriveAgentStatus({ exited, notifications, contextUsed: contextUsed ?? undefined, reported });

  return (
    <div
      ref={rootRef}
      data-term-id={id}
      className={`pane ${expanded ? "expanded" : ""} ${entering ? "pane-enter" : ""} ${
        dragOver ? "drag-over" : ""
      } ${focused ? "focused" : ""}`}
      data-status={status}
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
      // Tabbing into the terminal must move focus too, or ⌘Enter and the
      // other focused-pane shortcuts act on the previously clicked pane.
      onFocusCapture={() => {
        if (!hidden && !focused) props.onFocus();
      }}
    >
      <div className="pane-header">
        <span className="terra-dot pane-dot" data-status={status} aria-hidden="true" />
        <span className="pane-name" title={command}>{primary}</span>
        {secondary ? <span className="terra-tag pane-tag">{secondary}</span> : null}
        {props.worktreeBranch ? (
          <button
            type="button"
            className="terra-tag pane-worktree"
            title={`${t("pane.worktree", { branch: props.worktreeBranch })} · ${t("review.open")}`}
            disabled={!props.onOpenReview}
            onClick={(event) => {
              event.stopPropagation();
              props.onOpenReview?.();
            }}
          >
            <GitBranch size={11} aria-hidden="true" />
            {props.worktreeBranch}
          </button>
        ) : null}
        {title && title !== primary ? (
          <span className="pane-title" title={title}>
            {title}
          </span>
        ) : <span className="pane-title" />}
        {contextUsed != null && !exited && (
          <span
            className={`pane-ctx ${contextUsed >= 85 ? "high" : contextUsed >= 60 ? "mid" : ""}`}
            title={t("pane.contextUsed", { count: contextUsed })}
          >
            <span className="pane-ctx-bar">
              <span style={{ transform: `scaleX(${contextUsed / 100})` }} />
            </span>
            {contextUsed}%
          </span>
        )}
        <div className="pane-actions">
          <button
            type="button"
            className="pane-btn"
            aria-label={expanded ? t("pane.restore") : t("pane.maximize")}
            title={expanded ? t("pane.restore") : t("pane.maximize")}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={props.onToggleExpand}
          >
            {expanded ? <Minimize2 size={13} aria-hidden="true" /> : <Maximize2 size={13} aria-hidden="true" />}
          </button>
          {menu ? <PaneActionsMenu label={t("pane.moreActions")} groups={menu} /> : null}
        </div>
      </div>
      <div className="pane-body" ref={containerRef} />
      {attention && !exited ? (
        <div className="pane-attention" role="status">
          <span className="pane-attention-message">{attentionMessage}</span>
          <button
            type="button"
            className="terra-button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={props.onClearNotifications}
          >
            {t("pane.markRead")}
          </button>
        </div>
      ) : null}
      {exited && (
        <div className="pane-overlay" role="status">
          <strong>{t("pane.exited")}</strong>
          <span>{t("pane.exitedDetail")}</span>
          <div className="pane-overlay-actions">
            <button type="button" className="terra-button" onClick={props.onRestart}>{t("pane.restart")}</button>
            <button type="button" className="terra-button" onClick={props.onClose}>{t("pane.closePane")}</button>
          </div>
        </div>
      )}
    </div>
  );
}
