import type { AgentRole } from "../types";

/** In the order a team is usually built. */
export const AGENT_ROLES: readonly AgentRole[] = ["orchestrator", "planner", "executor", "reviewer", "tester"];

export function isAgentRole(value: unknown): value is AgentRole {
  return typeof value === "string" && (AGENT_ROLES as readonly string[]).includes(value);
}
