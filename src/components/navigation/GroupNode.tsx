import { NavigatorNodeRow } from "./NavigatorNodeRow";
import type { NavigatorGroupNode, NavigatorNodeActions } from "./types";

export interface GroupNodeProps {
  node: NavigatorGroupNode;
  expanded: boolean;
  selected?: boolean;
  active?: boolean;
  actions?: NavigatorNodeActions;
  onToggle?: (id: string) => void;
  onSelect?: (node: NavigatorGroupNode) => void;
  dropIntent?: "before" | "inside" | "after" | null;
}

/** Terra's group row: a calm container for related projects and agents. */
export function GroupNode({ node, actions = {}, onSelect, selected = false, active = false, ...props }: GroupNodeProps) {
  return <NavigatorNodeRow {...props} actions={actions} active={active} node={node} onSelect={(selected) => onSelect?.(selected as typeof node)} selected={selected} visible />;
}
