export type McpTaskStatus = "todo" | "in_progress" | "review" | "done" | "blocked";
export type McpTaskPriority = "low" | "medium" | "high" | "urgent";
export type McpAgentState = "working" | "idle" | "needs_input" | "blocked";

export type McpTaskEventKind = "created" | "claimed" | "status" | "assigned" | "note" | "completed";

export interface McpTaskEvent {
  actor: string;
  kind: McpTaskEventKind;
  body: string;
  created_at: number;
}

export interface McpTask {
  id: string;
  workspace_id: string;
  title: string;
  description: string;
  status: McpTaskStatus;
  assignee: string | null;
  created_by: string;
  priority: McpTaskPriority;
  labels: string[];
  position: number;
  depends_on: string[];
  blocked_by: string[];
  created_at: number;
  updated_at: number;
  events?: McpTaskEvent[];
}

export interface McpTaskPatch {
  title?: string;
  description?: string;
  status?: McpTaskStatus;
  priority?: McpTaskPriority;
  assignee?: string | null;
  position?: number;
  note?: string;
}

export interface McpMessage {
  id: number;
  workspace_id: string;
  from: string;
  to: string;
  body: string;
  created_at: number;
  read_by: string[];
}

export interface McpAgentStatus {
  terminal_id: string;
  workspace_id: string;
  state: McpAgentState;
  summary: string;
  updated_at: number;
}

export interface McpServerInfo {
  enabled: boolean;
  available: boolean;
  running: boolean;
  url: string | null;
  port: number | null;
  db_path: string | null;
  error: string | null;
}
