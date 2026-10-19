import { Group, Panel, Separator } from "react-resizable-panels";
import type { ReactNode } from "react";
import type { WorkspaceLayout } from "../../types";
import {
  gridDimensionsForLayout,
  layoutForPanelIds,
  orderedIds,
  resolveLayoutMode,
} from "./layout";
import type {
  ContainerLayoutChange,
  WorkbenchContainerProjection,
  WorkbenchLayoutMode,
  WorkbenchPaneProjection,
} from "./types";

export interface PaneGridProps {
  projection: WorkbenchContainerProjection;
  mode?: WorkbenchLayoutMode;
  activePaneId?: string | null;
  renderPane: (pane: WorkbenchPaneProjection) => ReactNode;
  /** Filler for unused slots of a fixed grid (a "+ New agent" button). */
  renderEmptySlot?: (index: number) => ReactNode;
  onLayoutChange?: (change: ContainerLayoutChange) => void;
}

function paneOrder(
  projection: WorkbenchContainerProjection,
  mode: WorkbenchLayoutMode,
  activePaneId: string | null | undefined,
): WorkbenchPaneProjection[] {
  const ids = projection.panes.map(({ pane }) => pane.id);
  const ordered = orderedIds(ids, projection.container.layout.itemIds)
    .map((id) => projection.panes.find(({ pane }) => pane.id === id))
    .filter((pane): pane is WorkbenchPaneProjection => pane !== undefined);
  if (mode !== "spotlight" || !activePaneId) return ordered;
  const active = ordered.find(({ pane }) => pane.id === activePaneId);
  return active ? [active, ...ordered.filter(({ pane }) => pane.id !== activePaneId)] : ordered;
}

function panelSizes(
  projection: WorkbenchContainerProjection,
  mode: WorkbenchLayoutMode,
  activePaneId: string | null | undefined,
): Record<string, number> {
  const ordered = paneOrder(projection, mode, activePaneId).map(({ pane }) => pane.id);
  const sizes = layoutForPanelIds(projection.container.layout, ordered);
  if (mode === "spotlight" && ordered.length > 1) {
    const activeId = activePaneId && ordered.includes(activePaneId) ? activePaneId : ordered[0];
    if (activeId) {
      const remaining = ordered.filter((id) => id !== activeId);
      sizes[activeId] = 72;
      const remainder = remaining.length > 0 ? 28 / remaining.length : 0;
      remaining.forEach((id) => {
        sizes[id] = remainder;
      });
    }
  }
  if (mode === "sidebar" && ordered.length > 1) {
    const sidebarId = ordered[0];
    sizes[sidebarId] = 26;
    const remainder = 74 / (ordered.length - 1);
    ordered.slice(1).forEach((id) => {
      sizes[id] = remainder;
    });
  }
  return sizes;
}

function persistedLayout(
  containerId: string,
  mode: WorkbenchLayoutMode,
  paneIds: readonly string[],
  sizes: Record<string, number>,
  baseLayout: WorkspaceLayout,
): ContainerLayoutChange {
  const normalizedSizes = layoutForPanelIds(
    { ...baseLayout, itemIds: [...paneIds], sizes },
    paneIds,
  );
  const persistedPaneOrder = orderedIds(paneIds, baseLayout.itemIds);
  const layout: WorkspaceLayout = {
    ...baseLayout,
    mode: (mode === "sidebar" ? baseLayout.mode : mode) as WorkspaceLayout["mode"],
    itemIds: persistedPaneOrder,
    sizes: normalizedSizes,
  };
  return { containerId, layout };
}

/**
 * Resizable pane surface. `Panel` and `Separator` stay direct children of
 * `Group`, as required by react-resizable-panels v4.
 */
export function PaneGrid({
  projection,
  mode: explicitMode,
  activePaneId,
  renderPane,
  renderEmptySlot,
  onLayoutChange,
}: PaneGridProps) {
  const mode = resolveLayoutMode(projection.container.layout, explicitMode);
  const panes = paneOrder(projection, mode, activePaneId);
  if (panes.length === 0) return null;

  const sizes = panelSizes(projection, mode, activePaneId);
  const orientation = mode === "vertical" || mode === "stack" ? "vertical" : "horizontal";
  const isGrid = mode === "grid";

  if (isGrid) {
    const { columns, rows } = gridDimensionsForLayout(
      projection.container.layout,
      panes.length,
    );
    return (
      <div
        className="terra-pane-grid terra-pane-grid--grid"
        data-layout-mode={mode}
        data-grid-columns={columns}
        data-grid-rows={rows}
        style={{
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
          gridAutoRows: "minmax(0, 1fr)",
        }}
      >
        {panes.map((paneProjection) => (
          <div className="terra-pane-grid__cell terra-anim-rise" key={paneProjection.pane.id}>
            {renderPane(paneProjection)}
          </div>
        ))}
        {renderEmptySlot
          ? Array.from({ length: Math.max(0, columns * rows - panes.length) }, (_, index) => (
            <div className="terra-pane-grid__cell terra-pane-grid__cell--empty" key={`empty-${index}`}>
              {renderEmptySlot(index)}
            </div>
          ))
          : null}
      </div>
    );
  }

  return (
    <div className="terra-pane-grid" data-layout-mode={mode}>
      <Group
        key={`${projection.container.id}:${mode}:${mode === "spotlight" ? activePaneId ?? "none" : "stable"}:${panes.map(({ pane }) => pane.id).join(",")}`}
        id={`pane-group-${projection.container.id}`}
        className="terra-pane-grid"
        orientation={orientation}
        defaultLayout={sizes}
        onLayoutChanged={(layout, meta) => {
          if (!meta.isUserInteraction) return;
          const nextSizes = Object.fromEntries(
            Object.entries(layout).map(([id, value]) => [id, value]),
          );
          onLayoutChange?.(
            persistedLayout(
              projection.container.id,
              mode,
              panes.map(({ pane }) => pane.id),
              nextSizes,
              projection.container.layout,
            ),
          );
        }}
        resizeTargetMinimumSize={{ coarse: 28, fine: 16 }}
      >
        {panes.flatMap((paneProjection, index) => [
          <Panel
            key={paneProjection.pane.id}
            id={paneProjection.pane.id}
            className="terra-pane-panel"
            defaultSize={sizes[paneProjection.pane.id] ?? undefined}
            minSize={panes.length > 1 ? "8%" : "100%"}
          >
            {renderPane(paneProjection)}
          </Panel>,
          ...(index < panes.length - 1
            ? [
                <Separator
                  key={`separator-${projection.container.id}-${paneProjection.pane.id}`}
                  id={`separator-${projection.container.id}-${paneProjection.pane.id}`}
                  className="terra-pane-separator"
                  aria-label="Redimensionar painel"
                />,
              ]
            : []),
        ])}
      </Group>
    </div>
  );
}
