import type { AgentRole } from "./agent.model";
import type { Workspace } from "./workspace.model";
import { isTerminalRunning } from "./agentStatus";

/** In the order a team is usually built. */
export const AGENT_ROLES: readonly AgentRole[] = ["orchestrator", "planner", "executor", "reviewer", "tester"];

export function isAgentRole(value: unknown): value is AgentRole {
  return typeof value === "string" && (AGENT_ROLES as readonly string[]).includes(value);
}

/** The running orchestrator of a project, which voice dictation goes to. */
export function orchestratorOf(
  workspace: Pick<Workspace, "terminals"> | null | undefined,
  exited: Readonly<Record<string, unknown>>,
): string | null {
  return workspace?.terminals.find((terminal) => terminal.role === "orchestrator" && isTerminalRunning(terminal, exited))?.id ?? null;
}
