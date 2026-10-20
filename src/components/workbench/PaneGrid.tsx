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
import { useT } from "../../i18n";

export interface PaneGridProps {
  projection: WorkbenchContainerProjection;
  mode?: WorkbenchLayoutMode;
  activePaneId?: string | null;
  renderPane: (pane: WorkbenchPaneProjection) => ReactNode;
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
  onLayoutChange,
}: PaneGridProps) {
  const t = useT();
  const mode = resolveLayoutMode(projection.container.layout, explicitMode);
  const isSpotlight = mode === "spotlight";
  // Grade and Foco share one CSS grid with cells in a stable order, so
  // focusing a pane or switching modes only moves cells; the terminals inside
  // are never remounted (that lost scrollback, selection and keyboard focus).
  const panes = paneOrder(projection, isSpotlight ? "grid" : mode, activePaneId);
  if (panes.length === 0) return null;

  const sizes = panelSizes(projection, mode, activePaneId);
  const orientation = mode === "vertical" || mode === "stack" ? "vertical" : "horizontal";
  const isGrid = mode === "grid" || isSpotlight;

  if (isGrid) {
    const { columns, rows } = gridDimensionsForLayout(
      projection.container.layout,
      panes.length,
    );
    const spotlightId = isSpotlight
      ? (panes.find(({ pane }) => pane.id === activePaneId) ?? panes[0]).pane.id
      : null;
    const sideCount = panes.length - 1;
    // A fixed grid with free slots: the last row's agents share the whole
    // width instead of leaving empty cells. Columns are subdivided by the
    // last row's count so both rows split evenly (4 cols, 3 in the last row
    // → 12 tracks: full rows span 3, the last row spans 4).
    const usedRows = Math.max(1, Math.ceil(panes.length / columns));
    const lastRowStart = (usedRows - 1) * columns;
    const lastRowCount = panes.length - lastRowStart;
    const unit = lastRowCount < columns ? lastRowCount : 1;
    const gridStyle = isSpotlight
      ? {
          gridTemplateColumns: sideCount > 0 ? "minmax(0, 72fr) minmax(0, 28fr)" : "minmax(0, 1fr)",
          gridTemplateRows: `repeat(${Math.max(1, sideCount)}, minmax(0, 1fr))`,
        }
      : {
          gridTemplateColumns: `repeat(${columns * unit}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${usedRows}, minmax(0, 1fr))`,
          gridAutoRows: "minmax(0, 1fr)",
        };
    let sideIndex = 0;
    return (
      <div
        className="terra-pane-grid terra-pane-grid--grid"
        data-layout-mode={mode}
        data-grid-columns={isSpotlight ? undefined : columns}
        data-grid-rows={isSpotlight ? undefined : rows}
        style={gridStyle}
      >
        {panes.map((paneProjection, index) => {
          let placement: { gridColumn: string; gridRow?: string } | undefined;
          if (!isSpotlight && lastRowCount < columns) {
            placement = { gridColumn: `span ${index >= lastRowStart ? columns : unit}` };
          }
          if (isSpotlight) {
            if (paneProjection.pane.id === spotlightId) placement = { gridColumn: "1", gridRow: "1 / -1" };
            else {
              sideIndex += 1;
              placement = { gridColumn: "2", gridRow: String(sideIndex) };
            }
          }
          return (
            <div
              className="terra-pane-grid__cell terra-anim-rise"
              key={paneProjection.pane.id}
              style={placement}
            >
              {renderPane(paneProjection)}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="terra-pane-grid" data-layout-mode={mode}>
      <Group
        key={`${projection.container.id}:${mode}:${panes.map(({ pane }) => pane.id).join(",")}`}
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
                  aria-label={t("grid.resize")}
                />,
              ]
            : []),
        ])}
      </Group>
    </div>
  );
}
