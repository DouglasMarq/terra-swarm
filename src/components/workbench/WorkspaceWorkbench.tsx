import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragOverEvent,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useMemo, useState } from "react";
import { EmptyPaneCell } from "./EmptyPaneCell";
import { projectWorkbench } from "./projection";
import { containerDndId, readContainerDndId, SortableProjectContainer } from "./SortableProjectContainer";
import { readPaneDndId } from "./SortablePaneFrame";
import type {
  WorkbenchContainerProjection,
  WorkspaceWorkbenchProps,
} from "./types";
import "./workbench.css";

interface DragData {
  type?: string;
  containerId?: string;
  paneId?: string;
  tabId?: string;
}

function dragData(value: unknown): DragData {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return {
    type: typeof record.type === "string" ? record.type : undefined,
    containerId: typeof record.containerId === "string" ? record.containerId : undefined,
    paneId: typeof record.paneId === "string" ? record.paneId : undefined,
    tabId: typeof record.tabId === "string" ? record.tabId : undefined,
  };
}

function dataFromDndId(value: string): DragData {
  const containerId = readContainerDndId(value);
  if (containerId) return { type: "container", containerId };
  const pane = readPaneDndId(value);
  if (pane) return { type: "pane", ...pane };
  return {};
}

function containerProjectionFor(
  projection: ReturnType<typeof projectWorkbench>,
  containerId: string | undefined,
) {
  return containerId
    ? projection.containers.find(({ container }) => container.id === containerId)
    : undefined;
}

export function invalidPaneDropTarget(
  projection: ReturnType<typeof projectWorkbench>,
  active: DragData,
  over: DragData,
): string | null {
  if (active.type !== "pane" || !active.containerId) return null;
  if (over.type !== "pane" && over.type !== "container") return null;
  const source = containerProjectionFor(projection, active.containerId);
  const target = containerProjectionFor(projection, over.containerId);
  const sourceProjectId = source?.container.projectId;
  const targetProjectId = target?.container.projectId;
  if (!source || !target || !sourceProjectId || !targetProjectId) return null;
  return sourceProjectId !== targetProjectId ? target.container.id : null;
}

function SortableContainerItem({
  projection,
  sortable,
  invalidPaneDropContainerId,
  ...props
}: {
  projection: WorkbenchContainerProjection;
  sortable: boolean;
  invalidPaneDropContainerId?: string | null;
} & Omit<WorkspaceWorkbenchProps, "source" | "className" | "emptyState" | "onNewContainer" | "sortable">) {
  return sortable ? (
    <SortableProjectContainer
      invalidPaneDropContainerId={invalidPaneDropContainerId}
      projection={projection}
      sortable
      {...props}
    />
  ) : (
    <div
      className="terra-workbench__sortable"
      data-visible={projection.container.visible && !projection.container.closed}
      data-collapsed={projection.container.collapsed}
      data-fullscreen={projection.container.fullscreen}
      data-drop-invalid={invalidPaneDropContainerId === projection.container.id ? "true" : undefined}
    >
      <ProjectContainerWithoutDnd projection={projection} {...props} />
    </div>
  );
}

import { ProjectContainer } from "./ProjectContainer";

function ProjectContainerWithoutDnd(
  props: Omit<Parameters<typeof ProjectContainer>[0], "dragHandle">,
) {
  return <ProjectContainer {...props} />;
}

/**
 * Multi-container Terra workbench.
 *
 * The component owns only visual projection and drag gestures. PTY lifecycle
 * remains with the caller: hide, collapse and detach are separate callbacks
 * from the explicit kill action.
 */
export function WorkspaceWorkbench({
  source,
  renderTab,
  className,
  emptyState,
  onNewContainer,
  sortable = true,
  onReorderContainers,
  onReorderPanes,
  onReorderTabs,
  onMovePane,
  ...actions
}: WorkspaceWorkbenchProps) {
  const projection = useMemo(() => projectWorkbench(source), [source]);
  const [invalidPaneDropContainerId, setInvalidPaneDropContainerId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragEnd(event: DragEndEvent): void {
    setInvalidPaneDropContainerId(null);
    if (!sortable || !event.over) return;
    const active = {
      ...dataFromDndId(String(event.active.id)),
      ...dragData(event.active.data.current),
    };
    const over = {
      ...dataFromDndId(String(event.over.id)),
      ...dragData(event.over.data.current),
    };

    if (active.type === "container" && over.type === "container") {
      const activeContainer = projection.containers.find(
        ({ container }) => container.id === active.containerId,
      )?.container;
      const overContainer = projection.containers.find(
        ({ container }) => container.id === over.containerId,
      )?.container;
      // The visual DndContext spans the entire workbench, while durable
      // container order is scoped to one project. Ignore cross-project drags.
      if (
        !activeContainer ||
        !overContainer ||
        !activeContainer.projectId ||
        activeContainer.projectId !== overContainer.projectId
      ) return;
      const ids = projection.containers
        .filter(({ container }) => container.projectId === activeContainer.projectId)
        .map(({ container }) => container.id);
      const from = active.containerId ? ids.indexOf(active.containerId) : -1;
      const to = over.containerId ? ids.indexOf(over.containerId) : -1;
      if (from >= 0 && to >= 0 && from !== to) {
        onReorderContainers?.(activeContainer.projectId, arrayMove(ids, from, to));
      }
      return;
    }

    if (active.type === "tab" && over.type === "tab") {
      if (
        !active.tabId ||
        !over.tabId ||
        !active.containerId ||
        active.containerId !== over.containerId ||
        !active.paneId ||
        active.paneId !== over.paneId
      ) return;
      const pane = projection.containers
        .find(({ container }) => container.id === active.containerId)
        ?.panes.find(({ pane: candidate }) => candidate.id === active.paneId);
      if (!pane) return;
      const ids = pane.tabs.map((tab) => tab.id);
      const from = ids.indexOf(active.tabId);
      const to = ids.indexOf(over.tabId);
      if (from >= 0 && to >= 0 && from !== to) {
        onReorderTabs?.(active.paneId, arrayMove(ids, from, to));
      }
      return;
    }

    if (active.type !== "pane" || !active.paneId || !active.containerId) return;
    if (over.type !== "pane" && over.type !== "container") return;
    if (!over.containerId) return;

    if (active.containerId === over.containerId) {
      const container = projection.containers.find(
        ({ container: candidate }) => candidate.id === active.containerId,
      );
      if (!container) return;
      const ids = container.panes.map(({ pane }) => pane.id);
      const from = ids.indexOf(active.paneId);
      if (!over.paneId) return;
      const to = ids.indexOf(over.paneId);
      if (from >= 0 && to >= 0 && from !== to) {
        onReorderPanes?.(active.containerId, arrayMove(ids, from, to));
      }
      return;
    }

    const target = projection.containers.find(
      ({ container: candidate }) => candidate.id === over.containerId,
    );
    if (!target) return;
    const source = projection.containers.find(
      ({ container: candidate }) => candidate.id === active.containerId,
    );
    // A pane is a project-scoped visual resource. Reject a cross-project
    // destination before invoking the optimistic store/API callback.
    if (
      !source?.container.projectId ||
      !target.container.projectId ||
      source.container.projectId !== target.container.projectId
    ) return;
    const toIndex = over.type === "pane" && over.paneId
      ? target.panes.findIndex(({ pane }) => pane.id === over.paneId)
      : target.panes.length;
    onMovePane?.(active.paneId, active.containerId, over.containerId, Math.max(0, toIndex));
  }

  function onDragStart(_event: DragStartEvent): void {
    setInvalidPaneDropContainerId(null);
  }

  function onDragOver(event: DragOverEvent): void {
    if (!sortable || !event.over) {
      setInvalidPaneDropContainerId(null);
      return;
    }
    const active = {
      ...dataFromDndId(String(event.active.id)),
      ...dragData(event.active.data.current),
    };
    const over = {
      ...dataFromDndId(String(event.over.id)),
      ...dragData(event.over.data.current),
    };
    setInvalidPaneDropContainerId(invalidPaneDropTarget(projection, active, over));
  }

  function onDragCancel(): void {
    setInvalidPaneDropContainerId(null);
  }

  const containerIds = projection.containers.map(({ container }) => container.id);
  const rootClassName = className ? `terra-workbench ${className}` : "terra-workbench";

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragCancel={onDragCancel}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragStart={onDragStart}
    >
      <main
        className={rootClassName}
        data-dnd-drop-invalid={invalidPaneDropContainerId ? "true" : undefined}
        data-workbench-version={projection.source.version}
      >
        {projection.containers.length > 0 ? (
          <div className="terra-workbench__list" data-container-count={projection.containers.length}>
            <SortableContext
              items={containerIds.map(containerDndId)}
              strategy={verticalListSortingStrategy}
            >
              {projection.containers.map((containerProjection) => (
                <SortableContainerItem
                  key={containerProjection.container.id}
                  projection={containerProjection}
                  sortable={sortable}
                  invalidPaneDropContainerId={invalidPaneDropContainerId}
                  renderTab={renderTab}
                  {...actions}
                  onReorderContainers={onReorderContainers}
                  onReorderPanes={onReorderPanes}
                  onReorderTabs={onReorderTabs}
                  onMovePane={onMovePane}
                />
              ))}
            </SortableContext>
          </div>
        ) : (
          <div className="terra-workbench__list">
            {emptyState ?? (
              <EmptyPaneCell
                label="Nenhum projeto aberto"
                description="Abra um projeto para criar agentes e acompanhar o trabalho neste espaço."
                actionLabel="Criar projeto"
                onNewTab={onNewContainer}
              />
            )}
          </div>
        )}
      </main>
    </DndContext>
  );
}
