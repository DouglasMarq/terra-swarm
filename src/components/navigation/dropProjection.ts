import type { NavigatorNode, NavigatorNodeKind, NavigatorTree, DropIntent, FlatNavigatorNode, MoveNodePayload } from "./types";

export interface ProjectionRect {
  top: number;
  bottom: number;
  height: number;
  left?: number;
}

export interface DropProjectionInput {
  activeId: string;
  overId: string;
  overRect: ProjectionRect;
  pointerY?: number;
  pointerX?: number;
  indentationWidth?: number;
  /** Visible or complete flattened tree. Complete trees provide better sibling indexes. */
  nodes: NavigatorTree | readonly FlatNavigatorNode[];
}

export interface DropProjection extends MoveNodePayload {
  depth: number;
  canDrop: boolean;
}

function flattenInput(input: NavigatorTree | readonly FlatNavigatorNode[]): FlatNavigatorNode[] {
  if (!('roots' in input)) return [...input];
  const result: FlatNavigatorNode[] = [];
  const visit = (node: NavigatorNode) => {
    result.push({
      id: node.id,
      dragId: node.dragId,
      kind: node.kind,
      name: node.name,
      parentId: node.parentId,
      depth: node.depth,
      hasChildren: node.children.length > 0,
      status: node.status,
      count: node.count,
      node,
    });
    node.children.forEach(visit);
  };
  input.roots.forEach(visit);
  return result;
}

function acceptsChildren(kind: NavigatorNodeKind, childKind: NavigatorNodeKind): boolean {
  return (kind === "group" && (childKind === "group" || childKind === "project")) || (kind === "project" && childKind === "agent");
}

function isDescendant(nodes: ReadonlyMap<string, FlatNavigatorNode>, possibleParentId: string, childId: string): boolean {
  let current = nodes.get(childId)?.parentId ?? null;
  while (current) {
    if (current === possibleParentId) return true;
    current = nodes.get(current)?.parentId ?? null;
  }
  return false;
}

function intentFor(pointerY: number | undefined, rect: ProjectionRect, canNest: boolean): DropIntent {
  if (pointerY === undefined || rect.height <= 0) return canNest ? "inside" : "after";
  const relative = (pointerY - rect.top) / rect.height;
  if (relative <= 0.25) return "before";
  if (relative >= 0.75) return "after";
  return canNest ? "inside" : relative < 0.5 ? "before" : "after";
}

function childrenOf(nodes: readonly FlatNavigatorNode[], parentId: string | null): FlatNavigatorNode[] {
  return nodes.filter((node) => node.parentId === parentId);
}

/**
 * Projects a pointer/keyboard drag onto the normalized tree. The small pure
 * function makes drop behavior testable without a browser and keeps React
 * concerns out of the domain operation emitted by NavigatorPanel.
 */
export function getDropProjection(input: DropProjectionInput): DropProjection | null {
  const nodes = flattenInput(input.nodes);
  const byId = new Map<string, FlatNavigatorNode>();
  nodes.forEach((node) => {
    byId.set(node.id, node);
    byId.set(node.dragId, node);
  });
  const active = byId.get(input.activeId);
  const over = byId.get(input.overId);
  if (!active || !over || active.id === over.id) return null;
  if (isDescendant(byId, active.id, over.id)) return null;

  const canNest = acceptsChildren(over.kind, active.kind);
  const intent = intentFor(input.pointerY, input.overRect, canNest);
  const useInside = intent === "inside" && canNest;
  const parentId = useInside ? over.id : over.parentId;
  if (parentId === active.id || (parentId !== null && isDescendant(byId, active.id, parentId))) return null;

  const siblings = childrenOf(nodes, parentId).filter((node) => node.id !== active.id);
  let index = useInside ? siblings.length : siblings.findIndex((node) => node.id === over.id);
  if (!useInside && index < 0) index = siblings.length;
  if (!useInside && intent === "after") index += 1;
  index = Math.max(0, Math.min(index, siblings.length));

  const indentationWidth = Math.max(1, input.indentationWidth ?? 18);
  const horizontalOffset = input.pointerX === undefined || input.overRect.left === undefined ? 0 : input.pointerX - input.overRect.left;
  const requestedDepth = Math.max(0, over.depth + Math.round(horizontalOffset / indentationWidth));
  const depth = useInside ? Math.min(requestedDepth, over.depth + 1) : Math.min(requestedDepth, over.depth);

  return {
    id: active.id,
    kind: active.kind,
    parentId,
    index,
    intent,
    targetId: over.id,
    depth,
    canDrop: true,
  };
}
