import { agentKind } from "../domain/agentLabels";
import { CONTEXT_ATTENTION_PERCENT, CONTEXT_WARNING_PERCENT, deriveAgentStatus } from "../domain/agentStatus";
import { useMcpStore } from "../stores/mcpStore";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { api } from "../api";
import { isIpcError } from "../lib/tauri/errors";
import type { UnlistenFn } from "../lib/tauri/events";
import { onPtyOutput } from "../lib/tauri/pty";
import { registerTerminal, unregisterTerminal, getTerminal } from "../terminalRegistry";
import {
  createFitScheduler,
  createTerminalResizeQueue,
  hasVisibleBox,
  isUsableDimensions,
} from "../lib/terminalFitScheduler";
import { createOutputBuffer } from "../lib/terminalOutputBuffer";
import { attachOutputStream } from "../lib/terminalOutputStream";
import { createRetryingWriter } from "../lib/terminalInputWriter";
import { isPlainShiftEnter } from "../lib/terminalKeys";
import { throttle } from "../lib/async/throttle";
import { Maximize2, Minimize2, GitBranch } from "lucide-react";
import { translateNow, useT } from "../i18n";
import { usePreferencesStore } from "../stores/preferencesStore";
import { terminalFontStack } from "../lib/terminalFonts";
import { detectDropPlatform, dropPointToClient, formatDroppedPaths } from "../domain/terminalDrop";
import { onFileDrop } from "../lib/tauri/fileDrop";
import { PaneActionsMenu, type PaneMenuGroups } from "./workbench/PaneActionsMenu";
import "@xterm/xterm/css/xterm.css";
import "./terminal-pane.css";
import { FULL_PERCENT } from "../lib/math/percent";

const SCROLLBACK_LINES = 10_000;
/** Minimum gap between console warnings for one terminal's failed IPC calls. */
const WARN_THROTTLE_MS = 2000;

interface Props {
  id: string;
  command: string;
  fontSize: number;
  hasExited: boolean;
  isExpanded: boolean;
  basis: number;
  height: string;
  isEntering: boolean;
  isDragOver: boolean;
  notifications: number;
  contextUsed?: number;
  title?: string;
  branch?: string;
  /** Branch of the agent's own git worktree, when it is isolated. */
  worktreeBranch?: string;
  /** The agent's team role, already translated. */
  roleLabel?: string;
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
  isFocused: boolean;
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
  isHidden?: boolean;
}

export function TerminalPane(props: Props) {
  const {
    id,
    command,
    fontSize,
    hasExited,
    isExpanded,
    basis,
    height,
    isEntering,
    isDragOver,
    notifications,
    contextUsed,
    title,
    isFocused,
    isHidden = false,
    label,
    tag,
    attentionMessage,
    menu,
  } = props;
  const translate = useT();
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
  const exitedRef = useRef(hasExited);
  exitedRef.current = hasExited;
  const hiddenRef = useRef(isHidden);
  hiddenRef.current = isHidden;
  const onFocusRef = useRef(props.onFocus);
  onFocusRef.current = props.onFocus;
  const [isDropTarget, setIsDropTarget] = useState(false);

  const currentFont = useEffectEvent(() => ({ fontFamily, fontSize }));

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const { fontFamily, fontSize } = currentFont();

    const term = new Terminal({
      fontFamily,
      fontSize,
      cursorBlink: true,
      macOptionIsMeta: true,
      scrollback: SCROLLBACK_LINES,
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

    let isDisposed = false;
    const isStopped = (): boolean => isDisposed || exitedRef.current;
    const warnThrottled = throttle(
      (what: string, err: unknown) => console.warn(`[terminal ${id}] ${what} failed:`, err),
      WARN_THROTTLE_MS,
    );

    term.attachCustomKeyEventHandler((event) => {
      if (!isPlainShiftEnter(event)) return true;
      if (event.type === "keydown") {
        event.preventDefault();
        if (!exitedRef.current) {
          api.writeTerminal(id, "\n").catch((err) => warnThrottled("write", err));
        }
      }
      return false;
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
        if (exitedRef.current || !hasVisibleBox(container)) return;
        if (!isUsableDimensions(fit.proposeDimensions())) return;
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

    const output = createOutputBuffer({
      write: (data, done) => term.write(data, done),
      overflowNotice: () => translateNow("pane.outputDropped"),
    });
    const detachOutput = attachOutputStream(
      {
        subscribe: (onChunk) => onPtyOutput(id, onChunk),
        loadBacklog: () => api.terminalBacklog(id),
      },
      output.enqueue,
    );

    const writeInput = createRetryingWriter({
      write: (data) => api.writeTerminal(id, data),
      shouldStop: isStopped,
      isRetryable: (err) => isIpcError(err, "busy"),
      onError: (err) => warnThrottled("write", err),
    });
    const dataSub = term.onData(writeInput);

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
      isDisposed = true;
      output.dispose();
      fitScheduler.dispose();
      resizeQueue.dispose();
      observer.disconnect();
      window.removeEventListener("resize", onWindowResize);
      window.removeEventListener("focus", onWindowResize);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      dataSub.dispose();
      detachOutput();
      unregisterTerminal(id, term);
      term.dispose();
      fitRef.current = null;
      resizeQueueRef.current = null;
    };
  }, [id]);

  // Every pane hears every drop; only the one under the cursor takes it, and
  // the paths are pasted as a native terminal does so agents see the file.
  useEffect(() => {
    const platform = detectDropPlatform();
    const isUnderCursor = (position: { x: number; y: number }): boolean => {
      if (exitedRef.current || hiddenRef.current) return false;
      const point = dropPointToClient(position, platform, window.devicePixelRatio);
      const target = document.elementFromPoint(point.x, point.y);
      return Boolean(target && rootRef.current?.contains(target));
    };
    let isDisposed = false;
    let unlisten: UnlistenFn | null = null;
    onFileDrop((event) => {
      if (isDisposed) return;
      if (event.type === "leave") {
        setIsDropTarget(false);
        return;
      }
      const isTarget = isUnderCursor(event.position);
      if (event.type !== "drop") {
        setIsDropTarget(isTarget);
        return;
      }
      setIsDropTarget(false);
      const text = formatDroppedPaths(event.paths, platform);
      const term = getTerminal(id);
      if (!isTarget || !text || !term) return;
      onFocusRef.current();
      term.focus();
      term.paste(text);
    })
      .then((un) => {
        if (isDisposed) un();
        else unlisten = un;
      })
      .catch((err) => console.warn(`[terminal ${id}] file drop unavailable:`, err));
    return () => {
      isDisposed = true;
      unlisten?.();
      setIsDropTarget(false);
    };
  }, [id]);

  const previousExited = useRef(hasExited);

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
    fitRef.current?.();
  }, [fontFamily, id]);

  // A hidden workbench tab can keep the same box dimensions while its
  // `display` state changes. ResizeObserver is not guaranteed to report that
  // transition, so treat visibility/focus/preset changes as explicit fit
  // signals as well.
  useEffect(() => {
    const isResumed = previousExited.current && !hasExited;
    previousExited.current = hasExited;
    if (isResumed) resizeQueueRef.current?.reset();
    fitRef.current?.();
  }, [basis, hasExited, isExpanded, isFocused, height, isHidden, id]);

  const reported = useMcpStore((state) => state.statuses[id]?.state);
  const kind = agentKind(command);
  const primary = label || kind;
  const secondary = tag && tag !== primary ? tag : null;
  const hasAttention = notifications > 0 && Boolean(attentionMessage);
  const status = deriveAgentStatus({ hasExited, notifications, contextUsed: contextUsed ?? undefined, reported });

  return (
    <div
      ref={rootRef}
      data-term-id={id}
      className={`pane ${isExpanded ? "expanded" : ""} ${isEntering ? "pane-enter" : ""} ${
        isDragOver ? "drag-over" : ""
      } ${isFocused ? "focused" : ""} ${isDropTarget ? "drop-target" : ""}`}
      data-status={status}
      style={{
        flex: `1 1 calc(${basis}% - 12px)`,
        height,
        display: isHidden ? "none" : undefined,
      }}
      aria-hidden={isHidden}
      onMouseDown={() => {
        if (isHidden) return;
        props.onFocus();
        if (notifications > 0) props.onClearNotifications();
      }}
      // Tabbing into the terminal must move focus too, or ⌘Enter and the
      // other focused-pane shortcuts act on the previously clicked pane.
      onFocusCapture={() => {
        if (!isHidden && !isFocused) props.onFocus();
      }}
    >
      <div className="pane-header">
        <span className="terra-dot pane-dot" data-status={status} aria-hidden="true" />
        <span className="pane-name" title={command}>{primary}</span>
        {secondary ? <span className="terra-tag pane-tag">{secondary}</span> : null}
        {props.roleLabel ? <span className="terra-tag pane-role">{props.roleLabel}</span> : null}
        {props.worktreeBranch ? (
          <button
            type="button"
            className="terra-tag pane-worktree"
            title={translate("pane.worktree", { branch: props.worktreeBranch })}
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
        {contextUsed != null && !hasExited && (
          <span
            className={`pane-ctx ${contextUsed >= CONTEXT_ATTENTION_PERCENT ? "high" : contextUsed >= CONTEXT_WARNING_PERCENT ? "mid" : ""}`}
            title={translate("pane.contextUsed", { count: contextUsed })}
          >
            <span className="pane-ctx-bar">
              <span style={{ transform: `scaleX(${contextUsed / FULL_PERCENT})` }} />
            </span>
            {contextUsed}%
          </span>
        )}
        <div className="pane-actions">
          <button
            type="button"
            className="pane-btn"
            aria-label={isExpanded ? translate("pane.restore") : translate("pane.maximize")}
            title={isExpanded ? translate("pane.restore") : translate("pane.maximize")}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={props.onToggleExpand}
          >
            {isExpanded ? <Minimize2 size={13} aria-hidden="true" /> : <Maximize2 size={13} aria-hidden="true" />}
          </button>
          {menu ? <PaneActionsMenu label={translate("pane.moreActions")} groups={menu} /> : null}
        </div>
      </div>
      <div className="pane-body" ref={containerRef} />
      {hasAttention && !hasExited ? (
        <div className="pane-attention" role="status">
          <span className="pane-attention-message">{attentionMessage}</span>
          <button
            type="button"
            className="terra-button"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={props.onClearNotifications}
          >
            {translate("pane.markRead")}
          </button>
        </div>
      ) : null}
      {hasExited && (
        <div className="pane-overlay" role="status">
          <strong>{translate("pane.exited")}</strong>
          <span>{translate("pane.exitedDetail")}</span>
          <div className="pane-overlay-actions">
            <button type="button" className="terra-button" onClick={props.onRestart}>{translate("pane.restart")}</button>
            <button type="button" className="terra-button" onClick={props.onClose}>{translate("pane.closePane")}</button>
          </div>
        </div>
      )}
    </div>
  );
}
