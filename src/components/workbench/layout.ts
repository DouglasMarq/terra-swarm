import type { WorkspaceLayout } from "../../types";
import type { WorkbenchLayoutMode } from "./types";

export const WORKBENCH_LAYOUT_MODES: readonly WorkbenchLayoutMode[] = [
  "auto",
  "spotlight",
  "sidebar",
  "grid",
  "horizontal",
  "vertical",
  "stack",
];

export function isWorkbenchLayoutMode(value: unknown): value is WorkbenchLayoutMode {
  return typeof value === "string" && WORKBENCH_LAYOUT_MODES.includes(value as WorkbenchLayoutMode);
}

export function resolveLayoutMode(
  layout: WorkspaceLayout | null | undefined,
  explicitMode?: WorkbenchLayoutMode,
): WorkbenchLayoutMode {
  if (explicitMode) return explicitMode;
  return isWorkbenchLayoutMode(layout?.mode) ? layout.mode : "auto";
}

/**
 * Workspace presets are persisted in the project layout. `sidebar` is a
 * Terra-only visual preset and therefore lives in the extensible metadata
 * field instead of widening the Rust/legacy LayoutMode wire union.
 */
export function workbenchModeForLayout(
  layout: WorkspaceLayout | null | undefined,
): WorkbenchLayoutMode {
  const metadataMode = layout?.metadata?.workbenchMode;
  return isWorkbenchLayoutMode(metadataMode) ? metadataMode : resolveLayoutMode(layout);
}

export function workspaceLayoutForMode(
  layout: WorkspaceLayout,
  mode: WorkbenchLayoutMode,
): WorkspaceLayout {
  return {
    ...layout,
    mode: mode === "sidebar" ? "auto" : mode,
    metadata: {
      ...(layout.metadata ?? {}),
      workbenchMode: mode,
    },
  };
}

export interface GridDimensions {
  columns: number;
  rows: number;
}

/** Largest grid the picker offers: 8 columns × 8 rows. */
export const GRID_MAX = 8;

const GRID_CONTROL_VALUES = [1, 2, 3, 4, 5, 6, 7, 8] as const;

/** Values exposed by the grid size picker in the container header. */
export const GRID_DIMENSION_VALUES = GRID_CONTROL_VALUES;

/** Automatic grids grow with the pane count up to this many columns. */
export const AUTO_GRID_MAX_COLUMNS = 4;

/**
 * v3 shows two modes: Grade (a CSS grid, automatic or fixed) and Foco
 * (spotlight). Older persisted modes read as an automatic grid.
 */
export type VisibleWorkbenchMode = "grid" | "spotlight";

export function visibleWorkbenchMode(mode: WorkbenchLayoutMode): VisibleWorkbenchMode {
  return mode === "spotlight" ? "spotlight" : "grid";
}

/** A grid is automatic until the user fixes its columns and rows. */
export function isAutoGrid(layout: WorkspaceLayout | null | undefined): boolean {
  return !(typeof layout?.columns === "number" && layout.columns >= 1 && typeof layout?.rows === "number" && layout.rows >= 1);
}

/** Drop fixed dimensions so the grid follows the pane count again. */
export function workspaceLayoutForAutoGrid(layout: WorkspaceLayout): WorkspaceLayout {
  const next: WorkspaceLayout = { ...layout, mode: "grid" };
  delete next.columns;
  delete next.rows;
  if (layout.itemIds) next.itemIds = [...layout.itemIds];
  if (layout.sizes) next.sizes = { ...layout.sizes };
  if (layout.metadata) next.metadata = { ...layout.metadata };
  return next;
}

function clampGrid(value: number): number {
  return Math.max(1, Math.min(GRID_MAX, value));
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}

/**
 * Choose a stable, useful grid for a pane count. The square-root heuristic
 * keeps the surface balanced while the four-column cap keeps the header
 * editor compact and deterministic.
 */
export function defaultGridDimensions(paneCount: number): GridDimensions {
  const count = Math.max(0, Math.floor(paneCount));
  if (count === 0) return { columns: 1, rows: 1 };
  const columns = Math.min(AUTO_GRID_MAX_COLUMNS, Math.max(1, Math.ceil(Math.sqrt(count))));
  return { columns, rows: Math.max(1, Math.ceil(count / columns)) };
}

/**
 * Read persisted grid hints without dropping valid empty tracks. A user may
 * intentionally choose four columns for a two-pane workspace, so dimensions
 * are not clamped to the current pane count.
 */
export function gridDimensionsForLayout(
  layout: WorkspaceLayout | null | undefined,
  paneCount: number,
): GridDimensions {
  const defaults = defaultGridDimensions(paneCount);
  const columns = positiveInteger(layout?.columns, defaults.columns);
  const rows = positiveInteger(layout?.rows, Math.max(1, Math.ceil(Math.max(1, paneCount) / columns)));
  return { columns, rows };
}

/**
 * Persist grid dimensions while retaining all unrelated layout metadata.
 * Cloning the collection fields prevents an editor update from mutating the
 * caller's snapshot and keeps pane/PTY identities mounted and untouched.
 */
export function workspaceLayoutForGrid(
  layout: WorkspaceLayout,
  paneCount: number,
  dimensions: Partial<GridDimensions>,
): WorkspaceLayout {
  const current = gridDimensionsForLayout(layout, paneCount);
  const next: WorkspaceLayout = {
    ...layout,
    mode: "grid",
    columns: clampGrid(positiveInteger(dimensions.columns, current.columns)),
    rows: clampGrid(positiveInteger(dimensions.rows, current.rows)),
  };
  if (layout.itemIds) next.itemIds = [...layout.itemIds];
  if (layout.sizes) next.sizes = { ...layout.sizes };
  if (layout.metadata) next.metadata = { ...layout.metadata };
  return next;
}

export function orderedIds(
  ids: readonly string[],
  persistedOrder: readonly string[] | undefined,
): string[] {
  if (!persistedOrder || persistedOrder.length === 0) return [...ids];
  const allowed = new Set(ids);
  const result: string[] = [];
  for (const id of persistedOrder) {
    if (allowed.has(id) && !result.includes(id)) result.push(id);
  }
  for (const id of ids) {
    if (!result.includes(id)) result.push(id);
  }
  return result;
}

export function defaultPanelSizes(ids: readonly string[]): Record<string, number> {
  if (ids.length === 0) return {};
  const size = Math.round((100 / ids.length) * 100) / 100;
  const sizes = Object.fromEntries(ids.map((id) => [id, size]));
  const total = Object.values(sizes).reduce((sum, value) => sum + value, 0);
  if (ids.length > 0 && total !== 100) {
    sizes[ids[ids.length - 1]] += Math.round((100 - total) * 100) / 100;
  }
  return sizes;
}

export function layoutForPanelIds(
  layout: WorkspaceLayout | null | undefined,
  ids: readonly string[],
): Record<string, number> {
  const ordered = orderedIds(ids, layout?.itemIds);
  const defaults = defaultPanelSizes(ordered);
  const persisted = layout?.sizes ?? {};
  const sizes: Record<string, number> = {};
  let total = 0;
  for (const id of ordered) {
    const candidate = persisted[id];
    const value = typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0
      ? candidate
      : defaults[id];
    sizes[id] = value;
    total += value;
  }
  if (total <= 0) return defaults;
  for (const id of ordered) sizes[id] = (sizes[id] / total) * 100;
  return sizes;
}

export function modeLabel(mode: WorkbenchLayoutMode): string {
  switch (mode) {
    case "spotlight":
      return "Spotlight";
    case "sidebar":
      return "Sidebar";
    case "grid":
      return "Custom grid";
    case "horizontal":
      return "Horizontal";
    case "vertical":
      return "Vertical";
    case "stack":
      return "Stack";
    case "auto":
    default:
      return "Auto";
  }
}

export function nextLayout(
  containerId: string,
  mode: WorkbenchLayoutMode,
  paneIds: readonly string[],
  sizes?: Record<string, number>,
): { containerId: string; layout: WorkspaceLayout } {
  return {
    containerId,
    layout: {
      mode: mode as WorkspaceLayout["mode"],
      itemIds: [...paneIds],
      ...(sizes && Object.keys(sizes).length > 0 ? { sizes: { ...sizes } } : {}),
    },
  };
}

/** Closing/hiding is visual-only; a PTY is killed only through onKillTab. */
export const CONTAINER_CLOSE_SEMANTICS = Object.freeze({
  hidesContainer: true,
  unmountsPanes: false,
  killsPtys: false,
});

export const TAB_DETACH_SEMANTICS = Object.freeze({
  hidesTab: true,
  unmountsSurface: false,
  killsPty: false,
});

export const TAB_KILL_SEMANTICS = Object.freeze({
  hidesTab: false,
  unmountsSurface: true,
  killsPty: true,
});
