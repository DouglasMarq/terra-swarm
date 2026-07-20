import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { TerminalMeta } from "../types";
import { api } from "../api";
import { getTerminal } from "../terminalRegistry";
import { computeTerminalMove, splitRows, type DropZone } from "../layout";
import { TerminalPane } from "./TerminalPane";

export const DEFAULT_BASIS = 50;
const GAP = 10;
const MIN_ROW_HEIGHT = 200;
const EDGE_ZONE = 0.25;
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
  onResize: (id: string, pct: number) => void;
  onResizeEnd: (id: string, pct: number) => void;
  onSwap: (
    draggedId: string,
    targetId: string,
    zone: DropZone,
    contentWidth: number,
  ) => void;
  onToggleExpand: (id: string | null) => void;
  onRestart: (id: string, command: string) => void;
  onClose: (id: string) => void;
}

interface GhostState {
  label: string;
  x: number;
  y: number;
}

interface DropTarget {
  id: string;
  zone: DropZone;
}

function paneIdAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y);
  const pane = el?.closest("[data-term-id]");
  return pane?.getAttribute("data-term-id") ?? null;
}

// Resolve a drop zone for a point: hovering a pane splits it into a top band
// (new row above), a bottom band (new row below), and left/right halves
// (insert into the same row). Points over empty grid space map to the
// nearest row edge so a pane can be dropped past the end of a row or into a
// new row at the top/bottom of the grid.
function dropTargetAt(
  x: number,
  y: number,
  excludeId: string,
  container: HTMLElement | null,
): DropTarget | null {
  const el = document.elementFromPoint(x, y);
  const pane = el?.closest("[data-term-id]");
  const id = pane?.getAttribute("data-term-id");
  if (pane && id) {
    if (id === excludeId) return null;
    const rect = pane.getBoundingClientRect();
    const fy = (y - rect.top) / rect.height;
    if (fy < EDGE_ZONE) return { id, zone: "above" };
    if (fy > 1 - EDGE_ZONE) return { id, zone: "below" };
    return { id, zone: x < rect.left + rect.width / 2 ? "before" : "after" };
  }
  if (!container) return null;
  const crect = container.getBoundingClientRect();
  if (x < crect.left || x > crect.right || y < crect.top || y > crect.bottom) {
    return null;
  }
  const panes = Array.from(
    container.querySelectorAll<HTMLElement>("[data-term-id]"),
  )
    .map((p) => ({
      id: p.getAttribute("data-term-id") ?? "",
      rect: p.getBoundingClientRect(),
    }))
    .filter((p) => p.id && p.id !== excludeId);
  if (panes.length === 0) return null;

  const bands: { top: number; bottom: number; items: typeof panes }[] = [];
  for (const p of panes.sort(
    (a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left,
  )) {
    const band = bands.find((b) => Math.abs(b.top - p.rect.top) < 8);
    if (band) {
      band.items.push(p);
      band.bottom = Math.max(band.bottom, p.rect.bottom);
    } else {
      bands.push({ top: p.rect.top, bottom: p.rect.bottom, items: [p] });
    }
  }
  bands.sort((a, b) => a.top - b.top);

  const first = bands[0];
  const last = bands[bands.length - 1];
  if (y < first.top) return { id: first.items[0].id, zone: "above" };
  if (y > last.bottom) {
    return { id: last.items[last.items.length - 1].id, zone: "below" };
  }

  const band =
    bands.find((b) => y >= b.top - 4 && y <= b.bottom + 4) ??
    bands.reduce((best, b) => {
      const d = y < b.top ? b.top - y : y - b.bottom;
      const bd = y < best.top ? best.top - y : y - best.bottom;
      return d < bd ? b : best;
    });
  const items = band.items;
  if (x < items[0].rect.left) return { id: items[0].id, zone: "before" };
  const lastItem = items[items.length - 1];
  if (x > lastItem.rect.right) return { id: lastItem.id, zone: "after" };
  let best = items[0];
  let bestDist = Infinity;
  for (const p of items) {
    const d = Math.abs(x - (p.rect.left + p.rect.width / 2));
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return {
    id: best.id,
    zone: x < best.rect.left + best.rect.width / 2 ? "before" : "after",
  };
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
  onResize,
  onResizeEnd,
  onSwap,
  onToggleExpand,
  onRestart,
  onClose,
}: Props) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [fileOverId, setFileOverId] = useState<string | null>(null);
  const [ghost, setGhost] = useState<GhostState | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const pendingFlip = useRef<Map<string, DOMRect> | null>(null);
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
    const measure = () => setContentWidth(Math.max(1, el.clientWidth - 20));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Live drop preview: run the same move the drop would perform so the grid
  // renders the exact post-drop layout (order, widths, row heights) with a
  // placeholder box where the dragged pane will land.
  const preview =
    dragId && dropTarget
      ? computeTerminalMove(
          terminals,
          dragId,
          dropTarget.id,
          dropTarget.zone,
          defaultBasis,
          contentWidth,
        )
      : null;

  const previewWidth = new Map<string, number>();
  let previewIndex = -1;
  let previewBasis = 0;
  if (preview) {
    preview.next.forEach((t, i) => {
      if (t.id === dragId) {
        previewIndex = i;
        previewBasis = t.width ?? defaultBasis;
      } else {
        previewWidth.set(t.id, t.width ?? defaultBasis);
      }
    });
  }

  // While dragging without a drop target the dragged pane is display:none
  // with no placeholder, so exclude it from the row model.
  const rowSource = preview
    ? preview.next
    : dragId
      ? terminals.filter((t) => t.id !== dragId)
      : terminals;
  const rowCount = Math.max(1, splitRows(rowSource, defaultBasis, contentWidth).length);

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

  useLayoutEffect(() => {
    const flipSource = pendingFlip.current;
    pendingFlip.current = null;

    const prevIds = lastIds.current;
    const currIds = terminals.map((t) => t.id);
    const structureChanged =
      prevIds.length !== currIds.length ||
      currIds.some((id, i) => prevIds[i] !== id);

    const prevRects = flipSource ?? lastRects.current;
    const curr = snapshotRects();
    const rafs: number[] = [];
    const touched: HTMLElement[] = [];

    if (prevRects && (flipSource || structureChanged)) {
      containerRef.current
        ?.querySelectorAll<HTMLElement>("[data-term-id]")
        .forEach((el) => {
          const id = el.getAttribute("data-term-id");
          const before = id ? prevRects.get(id) : undefined;
          const after = id ? curr.get(id) : undefined;
          if (!before || !after) return;
          // A hidden pane (e.g. the dragged one) reports a zero rect; animating
          // from (0,0) would fling it from the viewport corner.
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
      }
    };
  }, [terminals]);

  const startReorder = (e: React.MouseEvent, id: string) => {
    if (e.button !== 0 || expandedId) return;
    if ((e.target as HTMLElement).closest("button")) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const label = terminals.find((t) => t.id === id)?.command ?? "terminal";
    let dragging = false;

    const moveGhost = (x: number, y: number) => {
      if (ghostRef.current) {
        ghostRef.current.style.transform = `translate(${x + 12}px, ${
          y + 14
        }px) rotate(1.5deg)`;
      }
    };

    const onMove = (ev: MouseEvent) => {
      if (
        !dragging &&
        Math.hypot(ev.clientX - startX, ev.clientY - startY) > 6
      ) {
        dragging = true;
        setDragId(id);
        setGhost({ label, x: ev.clientX, y: ev.clientY });
        document.body.classList.add("reordering");
      }
      if (dragging) {
        moveGhost(ev.clientX, ev.clientY);
        setDropTarget(
          dropTargetAt(ev.clientX, ev.clientY, id, containerRef.current),
        );
      }
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("reordering");
      if (dragging) {
        const target = dropTargetAt(
          ev.clientX,
          ev.clientY,
          id,
          containerRef.current,
        );
        if (target) {
          pendingFlip.current = snapshotRects();
          onSwap(id, target.id, target.zone, contentWidth);
        }
        ghostRef.current?.classList.add("leaving");
        setTimeout(() => setGhost(null), 160);
      }
      setDragId(null);
      setDropTarget(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const prevIds = lastIds.current;

  const placeholder = preview && (
    <div
      key="drop-preview"
      className="drop-preview"
      style={{ flex: `1 1 calc(${previewBasis}% - 10px)`, height: paneHeight }}
    />
  );
  const dragOrigIndex = terminals.findIndex((t) => t.id === dragId);
  let insertAt = previewIndex;
  if (previewIndex > dragOrigIndex && dragOrigIndex >= 0) {
    insertAt = previewIndex + 1;
  }

  const nodes: React.ReactNode[] = [];
  terminals.forEach((t, i) => {
    if (placeholder && i === insertAt) nodes.push(placeholder);
    nodes.push(
      <TerminalPane
        key={t.id}
        id={t.id}
        command={t.command}
        fontSize={fontSize}
        exited={t.id in exited}
        expanded={expandedId === t.id}
        anyExpanded={!!expandedId}
        basis={previewWidth.get(t.id) ?? t.width ?? defaultBasis}
        height={paneHeight}
        entering={!prevIds.includes(t.id)}
        dragging={dragId === t.id}
        dragOver={dropTarget?.id === t.id || fileOverId === t.id}
        notifications={notifications[t.id] ?? 0}
        contextUsed={contextUsage[t.id]}
        title={titles[t.id]}
        branch={branch}
        onClearNotifications={() => onClearNotifications(t.id)}
        focused={focusedId === t.id}
        onFocus={() => onFocus(t.id)}
        onHeaderMouseDown={(e) => startReorder(e, t.id)}
        onResize={(pct) => onResize(t.id, pct)}
        onResizeEnd={(pct) => onResizeEnd(t.id, pct)}
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
  if (placeholder && insertAt === terminals.length) nodes.push(placeholder);

  return (
    <div
      ref={containerRef}
      className={`term-rows ${expandedId ? "has-expanded" : ""}`}
      style={hidden ? { display: "none" } : undefined}
    >
      {nodes}
      {ghost && (
        <div
          ref={ghostRef}
          className="drag-ghost"
          style={{
            transform: `translate(${ghost.x + 12}px, ${ghost.y + 14}px) rotate(1.5deg)`,
          }}
        >
          {ghost.label}
        </div>
      )}
    </div>
  );
}
