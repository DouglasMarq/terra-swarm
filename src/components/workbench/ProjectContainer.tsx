import type { CSSProperties } from "react";
import { CSS } from "@dnd-kit/utilities";
import { ContainerLayout } from "./ContainerLayout";
import {
  GRID_DIMENSION_VALUES,
  gridDimensionsForLayout,
  workbenchModeForLayout,
  workspaceLayoutForGrid,
} from "./layout";
import type { ProjectContainerProps, WorkbenchLayoutMode } from "./types";

function projectLabel(props: ProjectContainerProps): string {
  return props.projection.project?.name || props.projection.container.id;
}

export function ProjectContainer({
  projection,
  renderTab,
  dragHandle,
  sortable = false,
  visible = projection.container.visible && !projection.container.closed,
  onCollapseContainer,
  onFullscreenContainer,
  onHideContainer,
  onLayoutChange,
  onWorkspaceLayoutChange,
  ...actions
}: ProjectContainerProps) {
  const { container } = projection;
  const label = projectLabel({ projection, renderTab, visible, ...actions });
  const paneCount = projection.panes.length;
  const gridDimensions = gridDimensionsForLayout(container.layout, paneCount);
  const mode: WorkbenchLayoutMode = projection.project
    ? workbenchModeForLayout(projection.project.layout)
    : container.layout.mode;

  const updateGrid = (dimensions: Partial<typeof gridDimensions>): void => {
    if (!onLayoutChange) return;
    onLayoutChange({
      containerId: container.id,
      layout: workspaceLayoutForGrid(container.layout, paneCount, dimensions),
    });
  };

  return (
    <section
      className="terra-project-container"
      data-container-id={container.id}
      data-visible={visible}
      data-collapsed={container.collapsed}
      data-fullscreen={container.fullscreen}
      aria-hidden={!visible}
    >
      <header className="terra-project-container__header">
        {dragHandle ? (
          <button
            type="button"
            className="terra-project-container__drag"
            aria-label={`Reordenar ${label}`}
            {...dragHandle.attributes}
            {...dragHandle.listeners}
          >
            ⠿
          </button>
        ) : null}
        <button
          type="button"
          className="terra-project-container__action"
          aria-label={container.collapsed ? `Expandir ${label}` : `Recolher ${label}`}
          aria-expanded={!container.collapsed}
          onClick={() => onCollapseContainer?.(container.id, !container.collapsed)}
        >
          {container.collapsed ? "⌄" : "⌃"}
        </button>
        <span className="terra-project-container__title">
          {label}
        </span>
        {projection.project && onWorkspaceLayoutChange ? (
          <label className="terra-project-container__layout-select">
            <span className="terra-visually-hidden">Layout de {label}</span>
            <select
              aria-label={`Layout de ${label}`}
              value={mode}
              onChange={(event) => {
                const nextMode = event.target.value as WorkbenchLayoutMode;
                onWorkspaceLayoutChange(projection.project!.id, {
                  ...projection.project!.layout,
                  mode: nextMode === "sidebar" ? "auto" : nextMode,
                  metadata: {
                    ...(projection.project!.layout.metadata ?? {}),
                    workbenchMode: nextMode,
                  },
                });
              }}
            >
              <option value="auto">Auto</option>
              <option value="spotlight">Spotlight</option>
              <option value="sidebar">Sidebar</option>
              <option value="grid">Grid</option>
            </select>
          </label>
        ) : null}
        {mode === "grid" ? (
          <div
            className="terra-project-container__grid-controls"
            role="group"
            aria-label={`Configuração da grade de ${label}`}
          >
            <div className="terra-project-container__grid-control" role="group" aria-label="Colunas">
              <span className="terra-project-container__grid-label">Colunas</span>
              {GRID_DIMENSION_VALUES.map((value) => (
                <button
                  type="button"
                  className="terra-project-container__grid-button"
                  key={`column-${value}`}
                  aria-label={`${value} ${value === 1 ? "coluna" : "colunas"}`}
                  aria-pressed={gridDimensions.columns === value}
                  disabled={!onLayoutChange}
                  onClick={() => updateGrid({ columns: value })}
                >
                  {value}
                </button>
              ))}
            </div>
            <div className="terra-project-container__grid-control" role="group" aria-label="Linhas">
              <span className="terra-project-container__grid-label">Linhas</span>
              {GRID_DIMENSION_VALUES.map((value) => (
                <button
                  type="button"
                  className="terra-project-container__grid-button"
                  key={`row-${value}`}
                  aria-label={`${value} ${value === 1 ? "linha" : "linhas"}`}
                  aria-pressed={gridDimensions.rows === value}
                  disabled={!onLayoutChange}
                  onClick={() => updateGrid({ rows: value })}
                >
                  {value}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="terra-project-container__grid-auto"
              aria-label="Ajustar grade automaticamente"
              title="Ajustar grade automaticamente"
              disabled={!onLayoutChange}
              onClick={() => updateGrid(gridDimensionsForLayout(undefined, paneCount))}
            >
              Auto
            </button>
          </div>
        ) : null}
        <div className="terra-project-container__actions">
          {onFullscreenContainer ? (
            <button
              type="button"
              className="terra-project-container__action"
              aria-label={container.fullscreen ? `Sair da tela cheia de ${label}` : `Tela cheia de ${label}`}
              aria-pressed={container.fullscreen}
              onClick={() => onFullscreenContainer(container.id, !container.fullscreen)}
            >
              {container.fullscreen ? "↙" : "↗"}
            </button>
          ) : null}
          {onHideContainer ? (
            <button
              type="button"
              className="terra-project-container__action"
              aria-label={`Ocultar ${label}`}
              title="Ocultar container (os terminais continuam ativos)"
              onClick={() => onHideContainer(container.id)}
            >
              ×
            </button>
          ) : null}
        </div>
      </header>
      <div className="terra-project-container__surface">
        <ContainerLayout
          projection={projection}
          renderTab={renderTab}
          mode={mode}
          sortable={sortable}
          {...actions}
        />
      </div>
    </section>
  );
}

/**
 * Style helper for consumers that want to compose a sortable card without
 * coupling their app shell to dnd-kit's transform shape.
 */
export function sortableTransformStyle(
  transform: Parameters<typeof CSS.Transform.toString>[0],
  transition?: string,
): CSSProperties {
  return {
    transform: CSS.Transform.toString(transform),
    transition,
  };
}
