/** Tokens an agent used, from its CLI's own session log. */
export interface AgentTokenUsage {
  terminal_id: string;
  agent: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  turns: number;
  model: string | null;
}

/** Team roles agents can be started with (see the MCP `whoami` tool). */
export type AgentRole = "orchestrator" | "planner" | "executor" | "reviewer" | "tester";

export interface AgentInfo {
  id: string;
  label: string;
  available: boolean;
}

/** Per-agent launch settings applied on every spawn, never stored with the terminal. */
export interface AgentLaunchExtras {
  args?: string;
  env?: Record<string, string>;
  /** Isolate a new agent in its own git worktree. */
  worktree?: boolean;
  /** Team role for a new agent. */
  role?: AgentRole;
}
