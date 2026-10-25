import { NavigatorNodeRow } from "./NavigatorNodeRow";
import type { NavigatorAgentNode, NavigatorNodeActions } from "./types";

export interface AgentNodeProps {
  node: NavigatorAgentNode;
  isExpanded?: boolean;
  isSelected?: boolean;
  isActive?: boolean;
  actions?: NavigatorNodeActions;
  onSelect?: (node: NavigatorAgentNode) => void;
}

/** Agent rows expose PTY status and remain independently focusable. */
export function AgentNode({ node, actions = {}, onSelect, isSelected = false, isActive = false, ...props }: AgentNodeProps) {
  return <NavigatorNodeRow {...props} actions={actions} isActive={isActive} isExpanded={false} node={node} onSelect={(selected) => onSelect?.(selected as typeof node)} isSelected={isSelected} isVisible />;
}
