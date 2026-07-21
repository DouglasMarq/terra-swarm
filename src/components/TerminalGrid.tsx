import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { TerminalMeta } from "../types";
import { api } from "../api";
import { getTerminal } from "../terminalRegistry";
import { splitRows, GRID_GAP } from "../layout";
import { TerminalPane } from "./TerminalPane";

export const DEFAULT_BASIS = 50;
const GAP = GRID_GAP;
const MIN_ROW_HEIGHT = 200;
const FLIP_EASING = "transform 0.24s cubic-bezier(0.22, 1, 0.36, 1)";

interface Props {
  workspaceId: string;
  terminals: TerminalMeta[];
  fontSize: number;
  gridCols: number;
  hidden?: boolean;
  expandedId: string | null;
  focusedId: string | null;
  exited: Record<string, number | null>;
  notifications: Record<string, number>;
  contextUsage: Record<string, number>;
  titles: Record<string, string>;
  branch?: string;
  onClearNotifications: (id: string) => void;
  onFocus: (id: string) => void;
  onToggleExpand: (id: string | null) => void;
  onRestart: (id: string, command: string) => void;
  onClose: (id: string) => void;
}

function paneIdAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y);
  const pane = el?.closest("[data-term-id]");
  return pane?.getAttribute("data-term-id") ?? null;
}

const IS_WINDOWS = navigator.userAgent.includes("Windows");

function shellQuote(p: string): string {
  if (IS_WINDOWS) {
    if (/^[A-Za-z0-9_\-./\\:@%+=,~]+$/.test(p)) return p;
    return `"${p.replace(/"/g, '\\"')}"`;
  }
  if (/^[A-Za-z0-9_\-./~:@%+=,]+$/.test(p)) return p;
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

export function TerminalGrid({
  terminals,
  fontSize,
  gridCols,
  hidden = false,
  expandedId,
  focusedId,
  exited,
  notifications,
  contextUsage,
  titles,
  branch,
  onClearNotifications,
  onFocus,
  onToggleExpand,
  onRestart,
  onClose,
}: Props) {
  const [fileOverId, setFileOverId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastRects = useRef<Map<string, DOMRect> | null>(null);
  const lastIds = useRef<string[]>([]);

  useEffect(() => {
    if (hidden) return;
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "enter" || payload.type === "over") {
        const scale = window.devicePixelRatio || 1;
        setFileOverId(
          paneIdAt(payload.position.x / scale, payload.position.y / scale),
        );
      } else if (payload.type === "drop") {
        const scale = window.devicePixelRatio || 1;
        const target = paneIdAt(
          payload.position.x / scale,
          payload.position.y / scale,
        );
        setFileOverId(null);
        if (target && payload.paths.length > 0) {
          const term = getTerminal(target);
          const text =
            term?.modes.bracketedPasteMode
              ? payload.paths
                  .map((p) => `\u001b[200~${shellQuote(p)}\u001b[201~`)
                  .join(" ") + " "
              : payload.paths.map(shellQuote).join(" ") + " ";
          api
            .writeTerminal(target, text)
            .catch((err) => console.warn("file drop write failed:", err));
          onFocus(target);
        }
      } else {
        setFileOverId(null);
      }
    });
    return () => {
      unlisten.then((u) => u());
    };
  }, [onFocus, hidden]);

  const defaultBasis =
    gridCols > 0 ? Math.floor(100 / gridCols) : DEFAULT_BASIS;

  // The flex container enforces `min-width` on panes, so wrapping (and thus
  // row heights) depends on the actual content-box width, not just the
  // percentage bases. Measure it so the layout model matches reality.
  const [contentWidth, setContentWidth] = useState(Infinity);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setContentWidth(Math.max(1, el.clientWidth - 24));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rowCount = Math.max(1, splitRows(terminals, defaultBasis, contentWidth).length);

  const paneHeight = `max(${MIN_ROW_HEIGHT}px, calc((100% - ${
    (rowCount - 1) * GAP
  }px) / ${rowCount}))`;

  const snapshotRects = () => {
    const map = new Map<string, DOMRect>();
    containerRef.current
      ?.querySelectorAll<HTMLElement>("[data-term-id]")
      .forEach((el) => {
        const id = el.getAttribute("data-term-id");
        if (id) map.set(id, el.getBoundingClientRect());
      });
    return map;
  };

  // FLIP on structure changes only (terminal spawned or closed): siblings
  // glide from their previous rects to the reflowed ones. New panes get the
  // `pane-enter` CSS animation instead — there is no "before" rect for them.
  useLayoutEffect(() => {
    const prevIds = lastIds.current;
    const currIds = terminals.map((t) => t.id);
    const structureChanged =
      prevIds.length !== currIds.length ||
      currIds.some((id, i) => prevIds[i] !== id);

    const prevRects = lastRects.current;
    const curr = snapshotRects();
    const rafs: number[] = [];
    const touched: HTMLElement[] = [];

    if (prevRects && structureChanged) {
      containerRef.current
        ?.querySelectorAll<HTMLElement>("[data-term-id]")
        .forEach((el) => {
          const id = el.getAttribute("data-term-id");
          const before = id ? prevRects.get(id) : undefined;
          const after = id ? curr.get(id) : undefined;
          if (!before || !after) return;
          // A hidden pane reports a zero rect; animating from (0,0) would
          // fling it from the viewport corner.
          if (before.width === 0 && before.height === 0) return;
          const dx = before.left - after.left;
          const dy = before.top - after.top;
          if (!dx && !dy) return;
          touched.push(el);
          el.style.transition = "none";
          el.style.transform = `translate(${dx}px, ${dy}px)`;
          rafs.push(
            requestAnimationFrame(() => {
              if (!el.isConnected) return;
              el.style.transition = FLIP_EASING;
              el.style.transform = "";
              el.addEventListener(
                "transitionend",
                () => {
                  el.style.transition = "";
                  el.style.transformOrigin = "";
                },
                { once: true },
              );
            }),
          );
        });
    }

    lastRects.current = curr;
    lastIds.current = currIds;
    return () => {
      rafs.forEach(cancelAnimationFrame);
      // If a rerender cancels the pending animation frame, don't leave the
      // inline offset/transition behind or the pane stays visually shifted.
      for (const el of touched) {
        if (!el.isConnected) continue;
        el.style.transition = "";
        el.style.transform = "";
        el.style.transformOrigin = "";
      }
    };
  }, [terminals]);

  const prevIds = lastIds.current;

  const nodes: React.ReactNode[] = [];
  terminals.forEach((t) => {
    nodes.push(
      <TerminalPane
        key={t.id}
        id={t.id}
        command={t.command}
        fontSize={fontSize}
        exited={t.id in exited}
        expanded={expandedId === t.id}
        basis={t.width ?? defaultBasis}
        height={paneHeight}
        entering={!prevIds.includes(t.id)}
        dragOver={fileOverId === t.id}
        notifications={notifications[t.id] ?? 0}
        contextUsed={contextUsage[t.id]}
        title={titles[t.id]}
        branch={branch}
        onClearNotifications={() => onClearNotifications(t.id)}
        focused={focusedId === t.id}
        onFocus={() => onFocus(t.id)}
        onToggleExpand={() => {
          const expanding = expandedId !== t.id;
          onToggleExpand(expanding ? t.id : null);
          if (expanding) onFocus(t.id);
        }}
        onRestart={() => onRestart(t.id, t.command)}
        onClose={() => onClose(t.id)}
      />,
    );
  });

  return (
    <div
      ref={containerRef}
      className={`term-rows ${expandedId ? "has-expanded" : ""}`}
      style={hidden ? { display: "none" } : undefined}
    >
      {nodes}
    </div>
  );
}
