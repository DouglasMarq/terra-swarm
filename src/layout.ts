import type { TerminalMeta } from "./types";

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
