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

export type AgentRole = "orchestrator" | "planner" | "executor" | "reviewer" | "tester";

export interface AgentInfo {
  id: string;
  label: string;
  available: boolean;
}

export interface AgentLaunchExtras {
  args?: string;
  env?: Record<string, string>;
  worktree?: boolean;
  role?: AgentRole;
}
