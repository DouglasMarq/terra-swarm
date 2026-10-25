import { NavigatorNodeRow } from "./NavigatorNodeRow";
import type { NavigatorGroupNode, NavigatorNodeActions } from "./types";

export interface GroupNodeProps {
  node: NavigatorGroupNode;
  isExpanded: boolean;
  isSelected?: boolean;
  isActive?: boolean;
  actions?: NavigatorNodeActions;
  onToggle?: (id: string) => void;
  onSelect?: (node: NavigatorGroupNode) => void;
}

/** Terra's group row: a calm container for related projects and agents. */
export function GroupNode({ node, actions = {}, onSelect, isSelected = false, isActive = false, ...props }: GroupNodeProps) {
  return <NavigatorNodeRow {...props} actions={actions} isActive={isActive} node={node} onSelect={(selected) => onSelect?.(selected as typeof node)} isSelected={isSelected} isVisible />;
}
