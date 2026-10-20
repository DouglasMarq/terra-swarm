import type {
  McpAgentStatus,
  McpServerInfo,
  McpTask,
  McpTaskPatch,
  McpTaskPriority,
} from "../../types";
import { invokeCommand } from "./commands";

/** Window events emitted by the embedded MCP server (see `src-tauri/src/mcp`). */
export const MCP_EVENTS = {
  tasksChanged: "mcp-tasks-changed",
  message: "mcp-message",
  agentStatus: "mcp-agent-status",
  nudge: "mcp-nudge",
} as const;

/** The orchestrator assigned a task to an idle agent: type this prompt into it. */
export interface McpNudgePayload {
  workspace_id: string;
  terminal_id: string;
  prompt: string;
}

export interface McpTasksChangedPayload {
  workspace_id: string;
}

/** `status: null` means the terminal disconnected. */
export interface McpAgentStatusPayload {
  workspace_id: string;
  terminal_id: string;
  status: McpAgentStatus | null;
}

export function mcpServerInfo(): Promise<McpServerInfo> {
  return invokeCommand("mcpServerInfo");
}

export function mcpSetEnabled(enabled: boolean): Promise<McpServerInfo> {
  return invokeCommand("mcpSetEnabled", { enabled });
}

export function mcpListTasks(workspaceId: string): Promise<McpTask[]> {
  return invokeCommand("mcpListTasks", { workspaceId });
}

export function mcpCreateTask(
  workspaceId: string,
  input: { title: string; description?: string; priority?: McpTaskPriority; assignee?: string | null },
): Promise<McpTask> {
  return invokeCommand("mcpCreateTask", {
    workspaceId,
    title: input.title,
    description: input.description ?? null,
    priority: input.priority ?? null,
    assignee: input.assignee ?? null,
  });
}

export function mcpUpdateTask(workspaceId: string, id: string, patch: McpTaskPatch): Promise<McpTask> {
  return invokeCommand("mcpUpdateTask", { workspaceId, id, patch });
}

export function mcpDeleteTask(workspaceId: string, id: string): Promise<void> {
  return invokeCommand("mcpDeleteTask", { workspaceId, id });
}

export function mcpAgentStatuses(workspaceId: string): Promise<McpAgentStatus[]> {
  return invokeCommand("mcpAgentStatuses", { workspaceId });
}

export const mcpApi = {
  mcpServerInfo,
  mcpSetEnabled,
  mcpListTasks,
  mcpCreateTask,
  mcpUpdateTask,
  mcpDeleteTask,
  mcpAgentStatuses,
} as const;
