import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { CSSProperties } from "react";
import { ProjectContainer } from "./ProjectContainer";
import type { ProjectContainerProps } from "./types";

export const CONTAINER_DND_PREFIX = "terra-container:";

export function containerDndId(containerId: string): string {
  return `${CONTAINER_DND_PREFIX}${containerId}`;
}

export function readContainerDndId(value: string): string | null {
  return value.startsWith(CONTAINER_DND_PREFIX)
    ? value.slice(CONTAINER_DND_PREFIX.length) || null
    : null;
}

export function SortableProjectContainer({ invalidPaneDropContainerId, ...props }: ProjectContainerProps) {
  const id = containerDndId(props.projection.container.id);
  const sortable = useSortable({
    id,
    data: {
      type: "container",
      containerId: props.projection.container.id,
    },
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };
  return (
    <div
      ref={sortable.setNodeRef}
      className="terra-workbench__sortable"
      style={style}
      data-visible={props.visible ?? (props.projection.container.visible && !props.projection.container.closed)}
      data-collapsed={props.projection.container.collapsed}
      data-fullscreen={props.projection.container.fullscreen}
      data-drop-invalid={invalidPaneDropContainerId === props.projection.container.id ? "true" : undefined}
      data-dragging={sortable.isDragging}
      data-container-dnd-id={id}
    >
      <ProjectContainer
        {...props}
        dragHandle={{ attributes: sortable.attributes, listeners: sortable.listeners }}
      />
    </div>
  );
}
