import { rectSortingStrategy, SortableContext } from "@dnd-kit/sortable";
import { EmptyPaneCell } from "./EmptyPaneCell";
import { PaneGrid } from "./PaneGrid";
import { paneDndId } from "./SortablePaneFrame";
import type { ContainerLayoutProps } from "./types";

/**
 * Container-level layout boundary. Keeping this component separate gives the
 * workbench a stable place to add a persisted custom-grid editor later while
 * the three useful modes share the same mounted pane surface today.
 */
export function ContainerLayout({
  projection,
  renderTab,
  mode,
  sortable,
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
    <SortableContext
      items={projection.panes.map(({ pane }) => paneDndId(projection.container.id, pane.id))}
      strategy={rectSortingStrategy}
    >
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
            active={paneProjection.pane.id === activePaneId}
            sortable={sortable}
            {...actions}
          />
        )}
      />
    </SortableContext>
  );
}

import { PaneFrame } from "./PaneFrame";
import type { PaneFrameProps, WorkbenchContainerProjection, WorkbenchPaneProjection } from "./types";
import { SortablePaneFrame } from "./SortablePaneFrame";

interface ContainerPaneSurface
  extends Omit<PaneFrameProps, "projection" | "container" | "project" | "group" | "renderTab"> {
  projection: WorkbenchContainerProjection;
  paneProjection: WorkbenchPaneProjection;
  renderTab: PaneFrameProps["renderTab"];
  sortable?: boolean;
}

function ContainerPaneSurface({
  projection,
  paneProjection,
  renderTab,
  sortable,
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
  return sortable ? <SortablePaneFrame {...paneProps} /> : <PaneFrame {...paneProps} />;
}
