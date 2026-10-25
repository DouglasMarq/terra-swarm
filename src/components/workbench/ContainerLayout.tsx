import { EmptyPaneCell } from "./EmptyPaneCell";
import { PaneGrid } from "./PaneGrid";
import type { ContainerLayoutProps } from "./types";

export function ContainerLayout({
  projection,
  renderTab,
  mode,
  onLayoutChange,
  ...actions
}: ContainerLayoutProps) {
  const activePaneId = projection.container.activePaneId
    ?? projection.project?.activePaneId
    ?? projection.panes[0]?.pane.id
    ?? null;
  if (projection.panes.length === 0) {
    return (
      <EmptyPaneCell
        projectName={projection.project?.name}
        onNewTab={() => actions.onNewTab?.({
          projectId: projection.project?.id ?? projection.container.projectId ?? null,
          containerId: projection.container.id,
          paneId: null,
        })}
      />
    );
  }
  return (
    <PaneGrid
      projection={projection}
      mode={mode}
      activePaneId={activePaneId}
      onLayoutChange={onLayoutChange}
      renderPane={(paneProjection) => (
        <ContainerPaneSurface
          projection={projection}
          paneProjection={paneProjection}
          renderTab={renderTab}
          isActive={paneProjection.pane.id === activePaneId}
          {...actions}
        />
      )}
    />
  );
}

import { PaneFrame } from "./PaneFrame";
import type { PaneFrameProps, WorkbenchContainerProjection, WorkbenchPaneProjection } from "./types";

interface ContainerPaneSurface
  extends Omit<PaneFrameProps, "projection" | "container" | "project" | "group" | "renderTab"> {
  projection: WorkbenchContainerProjection;
  paneProjection: WorkbenchPaneProjection;
  renderTab: PaneFrameProps["renderTab"];
}

function ContainerPaneSurface({
  projection,
  paneProjection,
  renderTab,
  ...actions
}: ContainerPaneSurface) {
  const paneProps = {
    projection: paneProjection,
    container: projection.container,
    project: projection.project,
    group: projection.group,
    renderTab,
    ...actions,
  };
  return <PaneFrame {...paneProps} />;
}
