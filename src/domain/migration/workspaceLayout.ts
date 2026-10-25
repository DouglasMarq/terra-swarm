import type { LayoutMode, WorkspaceLayout } from "../workspace.model";
import { asRecord } from "../../lib/records/records";
import { uniqueStrings } from "../../lib/collections/uniqueStrings";
import { readArray, readFiniteNumber, readString } from "./snapshotReaders";

export const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayout = {
  mode: "auto",
  itemIds: [],
};

export function cloneLayout(layout: WorkspaceLayout): WorkspaceLayout {
  return {
    mode: layout.mode,
    ...(layout.columns === undefined ? {} : { columns: layout.columns }),
    ...(layout.rows === undefined ? {} : { rows: layout.rows }),
    ...(layout.itemIds === undefined ? {} : { itemIds: [...layout.itemIds] }),
    ...(layout.sizes === undefined ? {} : { sizes: { ...layout.sizes } }),
    ...(layout.metadata === undefined ? {} : { metadata: { ...layout.metadata } }),
  };
}

export function restrictLayoutItems(layout: WorkspaceLayout, validIds: ReadonlySet<string>): WorkspaceLayout {
  return {
    ...cloneLayout(layout),
    itemIds: (layout.itemIds ?? []).filter((itemId) => validIds.has(itemId)),
  };
}

function isLayoutMode(value: unknown): value is LayoutMode {
  return (
    value === "auto" ||
    value === "grid" ||
    value === "horizontal" ||
    value === "vertical" ||
    value === "stack" ||
    value === "spotlight"
  );
}

export function normalizeLayout(
  value: unknown,
  fallback: WorkspaceLayout = DEFAULT_WORKSPACE_LAYOUT,
): WorkspaceLayout {
  const raw = asRecord(value);
  const mode = isLayoutMode(raw.mode) ? raw.mode : fallback.mode;
  const columns = readFiniteNumber(raw.columns);
  const rows = readFiniteNumber(raw.rows);
  const itemIds = uniqueStrings(readArray(raw.itemIds).map(readString));
  const sizes: Record<string, number> = {};
  const rawSizes = asRecord(raw.sizes);
  for (const [id, rawSize] of Object.entries(rawSizes)) {
    const size = readFiniteNumber(rawSize);
    if (id && size !== null && size > 0) sizes[id] = size;
  }
  const metadata = asRecord(raw.metadata);

  return {
    mode,
    ...(columns !== null && columns > 0 ? { columns: Math.max(1, Math.round(columns)) } : {}),
    ...(rows !== null && rows > 0 ? { rows: Math.max(1, Math.round(rows)) } : {}),
    ...(itemIds.length > 0 ? { itemIds } : { itemIds: [] }),
    ...(Object.keys(sizes).length > 0 ? { sizes } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata: { ...metadata } } : {}),
  };
}

export interface LayoutPair {
  previous: WorkspaceLayout | undefined;
  incoming: WorkspaceLayout | undefined;
}

export function mergeLayout(layouts: LayoutPair, validIds: ReadonlySet<string>, fallback: WorkspaceLayout): WorkspaceLayout {
  const previousLayout = normalizeLayout(layouts.previous, fallback);
  const incomingLayout = normalizeLayout(layouts.incoming, fallback);
  const itemIds = uniqueStrings([
    ...(previousLayout.itemIds ?? []),
    ...(incomingLayout.itemIds ?? []),
  ]).filter((id) => validIds.has(id));
  const sizes = {
    ...(incomingLayout.sizes ?? {}),
    ...(previousLayout.sizes ?? {}),
  };
  return restrictLayoutItems(
    {
      ...incomingLayout,
      ...previousLayout,
      itemIds,
      ...(Object.keys(sizes).length > 0 ? { sizes } : {}),
    },
    validIds,
  );
}

/** Shared layout merge primitive for the store's group projection. */
export function mergeWorkspaceLayout(
  layouts: LayoutPair,
  validIds: ReadonlySet<string>,
  fallback: WorkspaceLayout = DEFAULT_WORKSPACE_LAYOUT,
): WorkspaceLayout {
  return mergeLayout(layouts, validIds, fallback);
}
