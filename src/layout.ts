import type { TerminalMeta } from "./types";

export type DropZone = "before" | "after" | "above" | "below";

export interface TerminalMove {
  next: TerminalMeta[];
  order: string[];
  widths: { id: string; pct: number }[];
}

// Panes have `min-width: 240px` and `flex-basis: calc(basis% - 12px)` in a
// container with 12px gaps, so wrapping depends on both the percentage sum
// and the available pixel width.
export const MIN_PANE_WIDTH = 240;
export const GRID_GAP = 12;

// Split the flat terminal list into visual rows the same way flex-wrap does.
// Flex decides wrapping from each pane's hypothetical main size — flex-basis
// resolved against the content box, clamped by min-width — so with a measured
// container width we sum clamped pixel bases plus gaps; without one we fall
// back to a pure percentage check.
export function splitRows(
  terms: TerminalMeta[],
  defaultBasis: number,
  contentWidth = Infinity,
): TerminalMeta[][] {
  const pxBasis = (basis: number) =>
    Math.max(MIN_PANE_WIDTH, (basis / 100) * contentWidth - GRID_GAP);
  const rows: TerminalMeta[][] = [[]];
  let usedPct = 0;
  let usedPx = 0;
  for (const t of terms) {
    const basis = t.width ?? defaultBasis;
    const row = rows[rows.length - 1];
    const overflow =
      row.length > 0 &&
      (contentWidth === Infinity
        ? usedPct + basis > 100
        : usedPx + GRID_GAP + pxBasis(basis) > contentWidth + 0.01);
    if (overflow) {
      rows.push([t]);
      usedPct = basis;
      usedPx = contentWidth === Infinity ? 0 : pxBasis(basis);
    } else {
      if (row.length > 0 && contentWidth !== Infinity) usedPx += GRID_GAP;
      row.push(t);
      usedPct += basis;
      if (contentWidth !== Infinity) usedPx += pxBasis(basis);
    }
  }
  return rows;
}

// Insert-based rearrange on the visual row grid: the dragged pane is removed
// from its row and inserted next to the drop target ("before"/"after") or on
// a brand-new row above/below the target's row ("above"/"below"). Rows that
// gain or lose a pane are rebalanced so each member gets an equal share of
// the row width; a pane dropped onto its own row spans the full width.
export function computeTerminalMove(
  terms: TerminalMeta[],
  dragId: string,
  targetId: string,
  zone: DropZone,
  defaultBasis: number,
  contentWidth = Infinity,
): TerminalMove | null {
  if (dragId === targetId) return null;
  const dragged = terms.find((t) => t.id === dragId);
  if (!dragged || !terms.some((t) => t.id === targetId)) return null;

  const rows = splitRows(terms, defaultBasis, contentWidth);

  const dragRow = rows.findIndex((r) => r.some((t) => t.id === dragId));
  const targetRow = rows.findIndex((r) => r.some((t) => t.id === targetId));
  rows[dragRow] = rows[dragRow].filter((t) => t.id !== dragId);
  // Capture the source row now: splicing a new row at or before dragRow
  // would shift indices and make rows[dragRow] point at the wrong row.
  const sourceRow = rows[dragRow];

  const widthUpdates = new Map<string, number>();

  if (zone === "above" || zone === "below") {
    rows.splice(zone === "above" ? targetRow : targetRow + 1, 0, [dragged]);
    widthUpdates.set(dragId, 100);
    if (sourceRow.length > 0) {
      const basis = Math.floor(100 / sourceRow.length);
      for (const t of sourceRow) widthUpdates.set(t.id, basis);
    }
  } else {
    const row = rows[targetRow];
    const at = row.findIndex((t) => t.id === targetId);
    row.splice(zone === "before" ? at : at + 1, 0, dragged);
    if (dragRow !== targetRow) {
      for (const r of [rows[dragRow], rows[targetRow]]) {
        if (r.length === 0) continue;
        const basis = Math.floor(100 / r.length);
        for (const t of r) widthUpdates.set(t.id, basis);
      }
    }
  }

  const next = rows
    .filter((r) => r.length > 0)
    .flat()
    .map((t) => {
      const pct = widthUpdates.get(t.id);
      return pct != null && pct !== t.width ? { ...t, width: pct } : t;
    });

  return {
    next,
    order: next.map((t) => t.id),
    widths: [...widthUpdates].map(([id, pct]) => ({ id, pct })),
  };
}
