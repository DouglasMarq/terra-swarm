import { useT } from "../../i18n";
import { useMemo } from "react";
import { EmptyPaneCell } from "./EmptyPaneCell";
import { projectWorkbench } from "./projection";
import { ProjectContainer } from "./ProjectContainer";
import type {
  WorkbenchActionCallbacks,
  WorkbenchContainerProjection,
  WorkspaceWorkbenchProps,
} from "./types";
import "./workbench.css";

function ContainerItem({
  projection,
  renderTab,
  actions,
}: {
  projection: WorkbenchContainerProjection;
  renderTab: WorkspaceWorkbenchProps["renderTab"];
  actions: WorkbenchActionCallbacks;
}) {
  return (
    <div
      className="terra-workbench__container"
      data-visible={projection.container.visible && !projection.container.closed}
      data-collapsed={projection.container.collapsed}
      data-fullscreen={projection.container.fullscreen}
    >
      <ProjectContainer
        projection={projection}
        renderTab={renderTab}
        {...actions}
      />
    </div>
  );
}

/**
 * Multi-container Terra workbench.
 *
 * Agent panels are intentionally static. Layout presets and resize separators
 * remain available, but containers, panes and agent tabs cannot be dragged or
 * reordered from this surface.
 */
export function WorkspaceWorkbench({
  source,
  renderTab,
  className,
  emptyState,
  onNewContainer,
  ...actions
}: WorkspaceWorkbenchProps) {
  const translate = useT();
  const projection = useMemo(() => projectWorkbench(source), [source]);
  const rootClassName = className ? `terra-workbench ${className}` : "terra-workbench";

  return (
    <main
      className={rootClassName}
      data-workbench-version={projection.source.version}
    >
      {projection.containers.length > 0 ? (
        <div className="terra-workbench__list" data-container-count={projection.containers.length}>
          {projection.containers.map((containerProjection) => (
            <ContainerItem
              key={containerProjection.container.id}
              projection={containerProjection}
              renderTab={renderTab}
              actions={actions}
            />
          ))}
        </div>
      ) : (
        <div className="terra-workbench__list">
          {emptyState ?? (
            <EmptyPaneCell
              label={translate("workbench.noProject")}
              description={translate("workbench.noProjectHint")}
              actionLabel={translate("workbench.createProject")}
              onNewTab={onNewContainer}
            />
          )}
        </div>
      )}
    </main>
  );
}
