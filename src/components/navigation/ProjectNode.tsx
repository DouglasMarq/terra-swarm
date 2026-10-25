import { NavigatorNodeRow } from "./NavigatorNodeRow";
import type { NavigatorNodeActions, NavigatorProjectNode } from "./types";

export interface ProjectNodeProps {
  node: NavigatorProjectNode;
  isExpanded: boolean;
  isSelected?: boolean;
  isActive?: boolean;
  actions?: NavigatorNodeActions;
  onToggle?: (id: string) => void;
  onSelect?: (node: NavigatorProjectNode) => void;
}

export function ProjectNode({ node, actions = {}, onSelect, isSelected = false, isActive = false, ...props }: ProjectNodeProps) {
  return <NavigatorNodeRow {...props} actions={actions} isActive={isActive} node={node} onSelect={(selected) => onSelect?.(selected as typeof node)} isSelected={isSelected} isVisible={node.isVisible} />;
}
