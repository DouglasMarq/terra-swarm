import type { McpAgentState } from "./mcp.model";
import type { TerminalMeta } from "./terminal.model";

export function isTerminalRunning(
  terminal: Pick<TerminalMeta, "id" | "isSuspended">,
  exited: Readonly<Record<string, unknown>>,
): boolean {
  return !terminal.isSuspended && !(terminal.id in exited);
}

export const CONTEXT_ATTENTION_PERCENT = 85;

export const CONTEXT_WARNING_PERCENT = 60;

export type AgentRunStatus = "working" | "idle" | "attention" | "suspended" | "exited";

export interface AgentStatusSignals {
  isSuspended?: boolean;
  hasExited?: boolean;
  notifications?: number;
  contextUsed?: number;
  reported?: McpAgentState | null;
}

export function deriveAgentStatus(signals: AgentStatusSignals): AgentRunStatus {
  if (signals.isSuspended) return "suspended";
  if (signals.hasExited) return "exited";
  if (signals.reported === "needs_input" || signals.reported === "blocked") return "attention";
  if ((signals.notifications ?? 0) > 0 || (signals.contextUsed ?? 0) >= CONTEXT_ATTENTION_PERCENT) return "attention";
  if (signals.reported === "idle") return "idle";
  return "working";
}
