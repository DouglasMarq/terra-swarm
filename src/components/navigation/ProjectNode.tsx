import { NavigatorNodeRow } from "./NavigatorNodeRow";
import type { NavigatorNodeActions, NavigatorProjectNode } from "./types";

export interface ProjectNodeProps {
  node: NavigatorProjectNode;
  expanded: boolean;
  selected?: boolean;
  active?: boolean;
  actions?: NavigatorNodeActions;
  onToggle?: (id: string) => void;
  onSelect?: (node: NavigatorProjectNode) => void;
  dropIntent?: "before" | "inside" | "after" | null;
}

/** Project rows represent visible containers while preserving PTY identity underneath. */
export function ProjectNode({ node, actions = {}, onSelect, selected = false, active = false, ...props }: ProjectNodeProps) {
  return <NavigatorNodeRow {...props} actions={actions} active={active} node={node} onSelect={(selected) => onSelect?.(selected as typeof node)} selected={selected} visible={node.visible} />;
}
