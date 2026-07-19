import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { TerminalMeta } from "../types";
import { api } from "../api";
import { getTerminal } from "../terminalRegistry";
import { TerminalPane } from "./TerminalPane";

export const DEFAULT_BASIS = 50;
const GAP = 10;
const MIN_ROW_HEIGHT = 200;
const SWAP_COOLDOWN_MS = 220;
const FLIP_EASING = "transform 0.24s cubic-bezier(0.22, 1, 0.36, 1)";

interface Props {
  workspaceId: string;
  terminals: TerminalMeta[];
  fontSize: number;
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
  onSwap: (draggedId: string, targetId: string) => void;
  onDropOrder: (order: string[]) => void;
  onToggleExpand: (id: string | null) => void;
  onRestart: (id: string, command: string) => void;
  onClose: (id: string) => void;
}

interface GhostState {
  label: string;
  x: number;
  y: number;
}

function paneIdAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y);
  const pane = el?.closest("[data-term-id]");
  return pane?.getAttribute("data-term-id") ?? null;
}

function shellQuote(p: string): string {
  if (/^[A-Za-z0-9_\-./~:@%+=,]+$/.test(p)) return p;
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

export function TerminalGrid({
  terminals,
  fontSize,
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
  onDropOrder,
  onToggleExpand,
  onRestart,
  onClose,
}: Props) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [fileOverId, setFileOverId] = useState<string | null>(null);
  const [ghost, setGhost] = useState<GhostState | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const pendingFlip = useRef<Map<string, DOMRect> | null>(null);
  const lastRects = useRef<Map<string, DOMRect> | null>(null);
  const lastIds = useRef<string[]>([]);
  const lastSwapAt = useRef(0);
  const terminalsRef = useRef(terminals);
  terminalsRef.current = terminals;

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

  let rowCount = 1;
  let used = 0;
  for (const t of terminals) {
    const basis = t.width ?? DEFAULT_BASIS;
    if (used > 0 && used + basis > 100) {
      rowCount++;
      used = 0;
    }
    used = Math.min(100, used + basis);
  }

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

    if (prevRects && (flipSource || structureChanged)) {
      containerRef.current
        ?.querySelectorAll<HTMLElement>("[data-term-id]")
        .forEach((el) => {
          const id = el.getAttribute("data-term-id");
          const before = id ? prevRects.get(id) : undefined;
          const after = id ? curr.get(id) : undefined;
          if (!before || !after) return;
          const dx = before.left - after.left;
          const dy = before.top - after.top;
          if (!dx && !dy) return;
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
    return () => rafs.forEach(cancelAnimationFrame);
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
        lastSwapAt.current = Date.now();
      }
      if (dragging) {
        moveGhost(ev.clientX, ev.clientY);
        const target = paneIdAt(ev.clientX, ev.clientY);
        setOverId(target);
        if (
          target &&
          target !== id &&
          Date.now() - lastSwapAt.current > SWAP_COOLDOWN_MS
        ) {
          lastSwapAt.current = Date.now();
          pendingFlip.current = snapshotRects();
          onSwap(id, target);
        }
      }
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("reordering");
      if (dragging) {
        onDropOrder(terminalsRef.current.map((t) => t.id));
        ghostRef.current?.classList.add("leaving");
        setTimeout(() => setGhost(null), 160);
      }
      setDragId(null);
      setOverId(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const prevIds = lastIds.current;

  return (
    <div
      ref={containerRef}
      className={`term-rows ${expandedId ? "has-expanded" : ""}`}
      style={hidden ? { display: "none" } : undefined}
    >
      {terminals.map((t) => (
        <TerminalPane
          key={t.id}
          id={t.id}
          command={t.command}
          fontSize={fontSize}
          exited={t.id in exited}
          expanded={expandedId === t.id}
          anyExpanded={!!expandedId}
          basis={t.width ?? DEFAULT_BASIS}
          height={paneHeight}
          entering={!prevIds.includes(t.id)}
          dragging={dragId === t.id}
          dragOver={(overId === t.id && dragId !== t.id) || fileOverId === t.id}
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
        />
      ))}
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
