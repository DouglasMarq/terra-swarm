import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { TerminalMeta } from "../types";
import { api } from "../api";
import { getTerminal } from "../terminalRegistry";
import { computeTerminalMove, splitRows, GRID_GAP, type DropZone } from "../layout";
import { TerminalPane } from "./TerminalPane";

export const DEFAULT_BASIS = 50;
const GAP = GRID_GAP;
const MIN_ROW_HEIGHT = 200;
const DRAG_SCALE = 0.6;
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

interface DropTarget {
  id: string;
  zone: DropZone;
}

function paneIdAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y);
  const pane = el?.closest("[data-term-id]");
  return pane?.getAttribute("data-term-id") ?? null;
}

// Layout rect with any in-flight FLIP animation offset removed.
// getBoundingClientRect includes the animation transform, so hit-testing
// against it chases its own tail: the preview changes the rect, the rect
// flips the computed zone, the zone changes the preview — rapid flicker.
function stableRect(el: HTMLElement): DOMRect {
  const r = el.getBoundingClientRect();
  const m =
    /translate\(\s*(-?[\d.]+)px[\s,]+(-?[\d.]+)px\s*\)(?:\s*scale\(\s*(-?[\d.]+)(?:[\s,]+(-?[\d.]+))?\s*\))?/.exec(
      el.style.transform,
    );
  if (m) {
    const sx = m[3] ? parseFloat(m[3]) : 1;
    const sy = m[4] ? parseFloat(m[4]) : sx;
    return new DOMRect(
      r.left - parseFloat(m[1]),
      r.top - parseFloat(m[2]),
      r.width / (sx || 1),
      r.height / (sy || 1),
    );
  }
  return r;
}

interface DragGeometry {
  panes: Map<string, DOMRect>;
  container: DOMRect;
  scrollTop: number;
}

// Resolve a drop zone for a point against the FROZEN pre-drag geometry. The
// live preview rearranges the grid, so targeting against current positions
// feeds back into itself (preview moves rect → rect flips zone → zone
// changes preview) and flickers. Hovering a pane splits it by nearest edge
// (with a side-by-side bias); hovering the dragged pane's original slot
// restores the layout; empty space maps to the nearest row edge.
function dropTargetAt(
  x: number,
  y: number,
  excludeId: string,
  geom: DragGeometry,
  current: DropTarget | null = null,
): DropTarget | null {
  const panes = Array.from(geom.panes, ([id, rect]) => ({ id, rect })).filter(
    (p) => p.id !== excludeId,
  );

  const origin = geom.panes.get(excludeId);
  if (
    origin &&
    x >= origin.left &&
    x <= origin.right &&
    y >= origin.top &&
    y <= origin.bottom
  ) {
    // Back over its own slot. Leaning toward the top/bottom edge stacks the
    // pane into a new row above/below the neighboring pane (dragging "down
    // to the bottom" should just work); the rest restores the layout.
    const dL = x - origin.left;
    const dR = origin.right - x;
    const dT = y - origin.top;
    const dB = origin.bottom - y;
    if (Math.min(dT, dB) < Math.min(dL, dR) * 0.8) {
      const sibling =
        panes.find(
          (p) =>
            (Math.abs(p.rect.right - origin.left) < 24 ||
              Math.abs(p.rect.left - origin.right) < 24) &&
            Math.min(p.rect.bottom, origin.bottom) -
              Math.max(p.rect.top, origin.top) >
              0,
        ) ?? panes[0];
      if (sibling) {
        return { id: sibling.id, zone: dT < dB ? "above" : "below" };
      }
    }
    return null;
  }

  const hit = panes.find(
    (p) =>
      x >= p.rect.left &&
      x <= p.rect.right &&
      y >= p.rect.top &&
      y <= p.rect.bottom,
  );
  if (hit) {
    const rect = hit.rect;
    const dLeft = x - rect.left;
    const dRight = rect.right - x;
    const dTop = y - rect.top;
    const dBottom = rect.bottom - y;
    const minH = Math.min(dLeft, dRight);
    const minV = Math.min(dTop, dBottom);
    // Hysteresis: while hovering the same pane, stick to the current zone
    // near the boundaries so the preview doesn't flap on tiny movements.
    if (current && current.id === hit.id) {
      const vertical = current.zone === "above" || current.zone === "below";
      if (vertical && minV < minH * 1.1) {
        return { id: hit.id, zone: current.zone };
      }
      if (!vertical && Math.abs(dLeft - dRight) < 16) {
        return { id: hit.id, zone: current.zone };
      }
    }
    if (minV < minH * 0.8) {
      return { id: hit.id, zone: dTop < dBottom ? "above" : "below" };
    }
    return { id: hit.id, zone: dLeft < dRight ? "before" : "after" };
  }

  const crect = geom.container;
  if (x < crect.left || x > crect.right || y < crect.top || y > crect.bottom) {
    return null;
  }
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
  const [dragFloat, setDragFloat] = useState<{
    id: string;
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const floatElRef = useRef<HTMLElement | null>(null);
  const glideElRef = useRef<HTMLElement | null>(null);
  const dropTargetRef = useRef<DropTarget | null>(null);
  const dragGeomRef = useRef<DragGeometry | null>(null);
  const pendingFlip = useRef<Map<string, DOMRect> | null>(null);
  const lastRects = useRef<Map<string, DOMRect> | null>(null);
  const lastIds = useRef<string[]>([]);
  const lastPreviewSig = useRef("");
  const lastDragId = useRef<string | null>(null);

  // Never leave the global drag cursor/class behind if the grid unmounts
  // mid-gesture (workspace switch, last terminal closed).
  useEffect(
    () => () => document.body.classList.remove("reordering"),
    [],
  );

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

  // Live drop preview: run the same move the drop would perform so the grid
  // renders the exact post-drop layout (order, widths, row heights) with a
  // placeholder box where the dragged pane will land. Without a target the
  // placeholder holds the pane's original slot, so the grid always matches
  // the frozen geometry the drop targeting is computed against.
  const move =
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
  const previewNext = dragId ? (move?.next ?? terminals) : null;

  const previewWidth = new Map<string, number>();
  let previewIndex = -1;
  let previewBasis = 0;
  if (previewNext) {
    previewNext.forEach((t, i) => {
      if (t.id === dragId) {
        previewIndex = i;
        previewBasis = t.width ?? defaultBasis;
      } else {
        previewWidth.set(t.id, t.width ?? defaultBasis);
      }
    });
  }

  // Signature of the live preview layout; the FLIP effect re-runs when it
  // changes so siblings glide out of the way as the drop target moves.
  const previewSig = previewNext
    ? previewNext.map((t) => `${t.id}:${t.width ?? ""}`).join("|")
    : "";

  const rowSource = previewNext ?? terminals;
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
    const previewChanged = previewSig !== lastPreviewSig.current;
    const dragChanged = dragId !== lastDragId.current;

    const prevRects = flipSource ?? lastRects.current;
    const curr = snapshotRects();
    const rafs: number[] = [];
    const touched: HTMLElement[] = [];

    if (
      prevRects &&
      (flipSource || structureChanged || previewChanged || dragChanged)
    ) {
      containerRef.current
        ?.querySelectorAll<HTMLElement>("[data-term-id]")
        .forEach((el) => {
          const id = el.getAttribute("data-term-id");
          // The dragged pane follows the cursor; never FLIP it mid-drag.
          if (id && id === dragId && !flipSource) return;
          const before = id ? prevRects.get(id) : undefined;
          const after = id ? curr.get(id) : undefined;
          if (!before || !after) return;
          // A hidden pane (e.g. the dragged one) reports a zero rect; animating
          // from (0,0) would fling it from the viewport corner.
          if (before.width === 0 && before.height === 0) return;
          const dx = before.left - after.left;
          const dy = before.top - after.top;
          if (!dx && !dy && el !== glideElRef.current) return;
          touched.push(el);
          el.style.transition = "none";
          if (el === glideElRef.current) {
            // The dropped pane was scaled down: glide it home growing back to
            // full size in the same motion (scale about the top-left keeps
            // the translate math exact).
            const sx = after.width > 0 ? before.width / after.width : 1;
            const sy = after.height > 0 ? before.height / after.height : 1;
            el.style.transformOrigin = "0 0";
            el.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
          } else {
            el.style.transform = `translate(${dx}px, ${dy}px)`;
          }
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
    glideElRef.current = null;

    lastRects.current = curr;
    lastIds.current = currIds;
    lastPreviewSig.current = previewSig;
    lastDragId.current = dragId;
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
  }, [terminals, previewSig, dragId]);

  const startReorder = (e: React.MouseEvent, id: string) => {
    if (e.button !== 0 || expandedId) return;
    if ((e.target as HTMLElement).closest("button")) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    let cancelled = false;
    let grabDX = 0;
    let grabDY = 0;

    const updateDropTarget = (t: DropTarget | null) => {
      dropTargetRef.current = t;
      setDropTarget(t);
    };

    const onMove = (ev: MouseEvent) => {
      if (
        !dragging &&
        Math.hypot(ev.clientX - startX, ev.clientY - startY) > 6
      ) {
        const el = containerRef.current?.querySelector<HTMLElement>(
          `[data-term-id="${id}"]`,
        );
        const rect = el?.getBoundingClientRect();
        if (!el || !rect) return;
        dragging = true;
        floatElRef.current = el;
        // Freeze the pre-drag layout: all drop targeting for this gesture is
        // computed against these rects, so the live preview can't feed back
        // into the targeting and flicker.
        const geom: DragGeometry = {
          panes: new Map(),
          container: containerRef.current!.getBoundingClientRect(),
          scrollTop: containerRef.current!.scrollTop,
        };
        containerRef.current
          ?.querySelectorAll<HTMLElement>("[data-term-id]")
          .forEach((p) => {
            const pid = p.getAttribute("data-term-id");
            if (pid) geom.panes.set(pid, stableRect(p));
          });
        dragGeomRef.current = geom;
        // Lift the pane out of the grid. Position it with left/top (scaled
        // about the top-left corner) so the point under the cursor tracks
        // exactly: visual grab = left + scale * grabOffset = cursor.
        grabDX = (startX - rect.left) * DRAG_SCALE;
        grabDY = (startY - rect.top) * DRAG_SCALE;
        el.style.position = "fixed";
        el.style.left = `${startX - grabDX}px`;
        el.style.top = `${startY - grabDY}px`;
        el.style.width = `${rect.width}px`;
        el.style.height = `${rect.height}px`;
        el.style.margin = "0";
        el.style.zIndex = "60";
        el.style.pointerEvents = "none";
        el.style.transformOrigin = "0 0";
        el.style.transform = `scale(${DRAG_SCALE})`;
        setDragFloat({
          id,
          left: startX - grabDX,
          top: startY - grabDY,
          width: rect.width,
          height: rect.height,
        });
        setDragId(id);
        document.body.classList.add("reordering");
      }
      if (dragging) {
        // A mouseup released outside the window is never delivered; treat the
        // button state as the source of truth so the drag can't get stuck.
        if ((ev.buttons & 1) === 0) {
          onUp(ev);
          return;
        }
        const el = floatElRef.current;
        if (el) {
          el.style.left = `${ev.clientX - grabDX}px`;
          el.style.top = `${ev.clientY - grabDY}px`;
        }
        // Auto-scroll near the container edges, then shift the frozen
        // geometry by the scroll delta so drop targeting stays correct
        // (scrolling moves children's viewport rects, not the container's).
        const container = containerRef.current;
        const geom = dragGeomRef.current;
        if (container && geom) {
          const cr = geom.container;
          const EDGE = 40;
          if (ev.clientY < cr.top + EDGE) container.scrollTop -= 14;
          else if (ev.clientY > cr.bottom - EDGE) container.scrollTop += 14;
          const ds = container.scrollTop - geom.scrollTop;
          if (ds !== 0) {
            geom.scrollTop = container.scrollTop;
            for (const [pid, r] of geom.panes) {
              geom.panes.set(
                pid,
                new DOMRect(r.left, r.top - ds, r.width, r.height),
              );
            }
          }
        }
        updateDropTarget(
          geom
            ? dropTargetAt(
                ev.clientX,
                ev.clientY,
                id,
                geom,
                dropTargetRef.current,
              )
            : null,
        );
      }
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") cancelled = true;
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("keydown", onKey);
      document.body.classList.remove("reordering");
      if (dragging && !cancelled) {
        // Fresh rects let the FLIP effect glide the pane from the release
        // point into its slot (or back home when dropped off-target).
        pendingFlip.current = snapshotRects();
        glideElRef.current = floatElRef.current;
        const target = dragGeomRef.current
          ? dropTargetAt(
              ev.clientX,
              ev.clientY,
              id,
              dragGeomRef.current,
              dropTargetRef.current,
            )
          : null;
        if (target) {
          onSwap(id, target.id, target.zone, contentWidth);
        }
      }
      floatElRef.current = null;
      dropTargetRef.current = null;
      dragGeomRef.current = null;
      setDragFloat(null);
      setDragId(null);
      setDropTarget(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("keydown", onKey);
  };

  const prevIds = lastIds.current;

  const placeholder = previewNext && (
    <div
      key="drop-preview"
      className="drop-preview"
      style={{ flex: `1 1 calc(${previewBasis}% - 12px)`, height: paneHeight }}
    />
  );
  const dragOrigIndex = terminals.findIndex((t) => t.id === dragId);
  let insertAt = previewIndex;
  if (previewIndex > dragOrigIndex && dragOrigIndex >= 0) {
    insertAt = previewIndex + 1;
  }
  // No computed move (no target, or the pane vanished mid-drag): hold the
  // dragged pane's original slot so the grid matches the frozen geometry.
  if (insertAt < 0) {
    insertAt = dragOrigIndex >= 0 ? dragOrigIndex : terminals.length;
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
        floating={dragFloat && dragFloat.id === t.id ? dragFloat : null}
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
    </div>
  );
}
