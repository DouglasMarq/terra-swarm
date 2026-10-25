import { ChevronDown, ChevronRight, Maximize2, Minimize2, Plus, X } from "lucide-react";
import { useT } from "../../i18n";
import { DEFAULT_HOTKEYS, formatHotkey, usePreferencesStore } from "../../stores/preferencesStore";
import { ContainerLayout } from "./ContainerLayout";
import { GridSizePicker } from "./GridSizePicker";
import {
  gridDimensionsForLayout,
  isAutoGrid,
  visibleWorkbenchMode,
  workbenchModeForLayout,
  workspaceLayoutForAutoGrid,
  workspaceLayoutForGrid,
} from "./layout";
import type { ProjectContainerProps, WorkbenchLayoutMode } from "./types";

function projectLabel(props: ProjectContainerProps): string {
  return props.projection.project?.name || props.projection.container.id;
}

export function ProjectContainer({
  projection,
  renderTab,
  visible = projection.container.visible && !projection.container.closed,
  onCollapseContainer,
  onFullscreenContainer,
  onHideContainer,
  onLayoutChange,
  onWorkspaceLayoutChange,
  ...actions
}: ProjectContainerProps) {
  const translate = useT();
  const newAgentHotkey = usePreferencesStore((state) => state.hotkeys.newTerminal ?? DEFAULT_HOTKEYS.newTerminal);
  const { container } = projection;
  const label = projectLabel({ projection, renderTab, visible, ...actions });
  const paneCount = projection.panes.length;
  const gridDimensions = gridDimensionsForLayout(container.layout, paneCount);
  const storedMode: WorkbenchLayoutMode = projection.project
    ? workbenchModeForLayout(projection.project.layout)
    : container.layout.mode;
  const visibleMode = visibleWorkbenchMode(storedMode);
  const autoGrid = isAutoGrid(container.layout);

  const setMode = (nextMode: "grid" | "spotlight"): void => {
    const project = projection.project;
    if (!project || !onWorkspaceLayoutChange) return;
    onWorkspaceLayoutChange(project.id, {
      ...project.layout,
      mode: nextMode,
      metadata: {
        ...(project.layout.metadata ?? {}),
        workbenchMode: nextMode,
      },
    });
  };

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
        <button
          type="button"
          className="terra-project-container__action"
          aria-label={translate(container.collapsed ? "workbench.expand" : "workbench.collapse", { name: label })}
          aria-expanded={!container.collapsed}
          onClick={() => onCollapseContainer?.(container.id, !container.collapsed)}
        >
          {container.collapsed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
        </button>
        <span className="terra-project-container__title">
          {label}
        </span>
        {projection.project && onWorkspaceLayoutChange ? (
          <div className="terra-segmented terra-project-container__modes" role="group" aria-label={translate("workbench.layout", { name: label })}>
            <button type="button" aria-pressed={visibleMode === "grid"} data-active={visibleMode === "grid"} onClick={() => setMode("grid")}>
              {translate("workbench.grid")}
            </button>
            <button type="button" aria-pressed={visibleMode === "spotlight"} data-active={visibleMode === "spotlight"} onClick={() => setMode("spotlight")}>
              {translate("workbench.focus")}
            </button>
          </div>
        ) : null}
        {visibleMode === "grid" ? (
          <GridSizePicker
            dimensions={gridDimensions}
            auto={autoGrid}
            paneCount={paneCount}
            disabled={!onLayoutChange}
            onSelect={(dimensions) => updateGrid(dimensions)}
            onAuto={() => onLayoutChange?.({ containerId: container.id, layout: workspaceLayoutForAutoGrid(container.layout) })}
          />
        ) : null}
        {actions.onNewTab ? (
          <button
            type="button"
            className="terra-button terra-button-primary terra-project-container__new"
            onClick={() => (actions.onQuickNewTab ?? actions.onNewTab)?.({
              projectId: projection.project?.id ?? container.projectId ?? null,
              containerId: container.id,
              paneId: null,
            })}
          >
            <Plus size={13} aria-hidden="true" />
            {translate("grid.newAgent")}
            <kbd>{formatHotkey(newAgentHotkey)}</kbd>
          </button>
        ) : null}
        <div className="terra-project-container__actions">
          {onFullscreenContainer ? (
            <button
              type="button"
              className="terra-project-container__action"
              aria-label={translate(container.fullscreen ? "workbench.exitFullscreen" : "workbench.fullscreen", { name: label })}
              aria-pressed={container.fullscreen}
              onClick={() => onFullscreenContainer(container.id, !container.fullscreen)}
            >
              {container.fullscreen ? <Minimize2 size={13} aria-hidden="true" /> : <Maximize2 size={13} aria-hidden="true" />}
            </button>
          ) : null}
          {onHideContainer ? (
            <button
              type="button"
              className="terra-project-container__action"
              aria-label={translate("workbench.hide", { name: label })}
              title={translate("workbench.hideTitle")}
              onClick={() => onHideContainer(container.id)}
            >
              <X size={13} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </header>
      <div className="terra-project-container__surface">
        <ContainerLayout
          projection={projection}
          renderTab={renderTab}
          mode={visibleMode}
          {...actions}
        />
      </div>
    </section>
  );
}
