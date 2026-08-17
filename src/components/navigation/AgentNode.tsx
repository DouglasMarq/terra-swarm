import { NavigatorNodeRow } from "./NavigatorNodeRow";
import type { NavigatorAgentNode, NavigatorNodeActions } from "./types";

export interface AgentNodeProps {
  node: NavigatorAgentNode;
  expanded?: boolean;
  selected?: boolean;
  active?: boolean;
  actions?: NavigatorNodeActions;
  onSelect?: (node: NavigatorAgentNode) => void;
  dropIntent?: "before" | "inside" | "after" | null;
}

/** Agent rows expose PTY status and remain independently focusable. */
export function AgentNode({ node, actions = {}, onSelect, selected = false, active = false, ...props }: AgentNodeProps) {
  return <NavigatorNodeRow {...props} actions={actions} active={active} expanded={false} node={node} onSelect={(selected) => onSelect?.(selected as typeof node)} selected={selected} visible />;
}
