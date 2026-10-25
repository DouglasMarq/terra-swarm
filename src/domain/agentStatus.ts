import type { McpAgentState } from "./mcp.model";
import type { TerminalMeta } from "./terminal.model";

export function isTerminalRunning(
  terminal: Pick<TerminalMeta, "id" | "suspended">,
  exited: Readonly<Record<string, unknown>>,
): boolean {
  return !terminal.suspended && !(terminal.id in exited);
}

/** Context window use, in percent, from which an agent needs attention. */
export const CONTEXT_ATTENTION_PERCENT = 85;

/** Context window use, in percent, from which a pane shows the context as filling up. */
export const CONTEXT_WARNING_PERCENT = 60;

/** What the UI shows for an agent, everywhere: dots, chips, Fleet, panes. */
export type AgentRunStatus = "working" | "idle" | "attention" | "suspended" | "exited";

export interface AgentStatusSignals {
  suspended?: boolean;
  exited?: boolean;
  /** Unread terminal notifications (BEL, OSC 9/777…). */
  notifications?: number;
  /** Context window used, in percent. */
  contextUsed?: number;
  /** What the agent itself reported through its hooks or `report_status`. */
  reported?: McpAgentState | null;
}

/**
 * One rule for every surface. A suspended or exited process wins; then
 * anything that needs a human (a reported question or permission prompt, an
 * unread notification, an almost full context); then what the agent
 * reported. Agents without hooks keep the old assumption: alive = working.
 */
export function deriveAgentStatus(signals: AgentStatusSignals): AgentRunStatus {
  if (signals.suspended) return "suspended";
  if (signals.exited) return "exited";
  if (signals.reported === "needs_input" || signals.reported === "blocked") return "attention";
  if ((signals.notifications ?? 0) > 0 || (signals.contextUsed ?? 0) >= CONTEXT_ATTENTION_PERCENT) return "attention";
  if (signals.reported === "idle") return "idle";
  return "working";
}
