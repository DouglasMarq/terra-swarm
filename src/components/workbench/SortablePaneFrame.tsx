import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { CSSProperties } from "react";
import { PaneFrame } from "./PaneFrame";
import type { PaneFrameProps } from "./types";

export const PANE_DND_PREFIX = "terra-pane:";

export function paneDndId(containerId: string, paneId: string): string {
  return `${PANE_DND_PREFIX}${containerId}:${paneId}`;
}

function parsePaneDndId(value: string): { containerId: string; paneId: string } | null {
  if (!value.startsWith(PANE_DND_PREFIX)) return null;
  const body = value.slice(PANE_DND_PREFIX.length);
  const separator = body.indexOf(":");
  if (separator < 1) return null;
  return { containerId: body.slice(0, separator), paneId: body.slice(separator + 1) };
}

export function SortablePaneFrame(props: PaneFrameProps) {
  const id = paneDndId(props.container.id, props.projection.pane.id);
  const sortable = useSortable({
    id,
    data: {
      type: "pane",
      paneId: props.projection.pane.id,
      containerId: props.container.id,
    },
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };
  return (
    <div
      ref={sortable.setNodeRef}
      className="terra-pane-sortable"
      style={style}
      data-dragging={sortable.isDragging}
      data-pane-dnd-id={id}
    >
      <PaneFrame
        {...props}
        dragHandle={{ attributes: sortable.attributes, listeners: sortable.listeners }}
      />
    </div>
  );
}

export function readPaneDndId(value: string): { containerId: string; paneId: string } | null {
  return parsePaneDndId(value);
}

