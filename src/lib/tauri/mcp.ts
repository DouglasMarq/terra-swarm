import type { AgentTokenUsage } from "../../domain/agent.model";
import type { McpAgentStatus, McpServerInfo, McpTask, McpTaskPatch, McpTaskPriority } from "../../domain/mcp.model";
import { invokeCommand } from "./commands";
import { listenPayload, type UnlistenFn } from "./events";

export const MCP_EVENTS = {
  tasksChanged: "mcp-tasks-changed",
  message: "mcp-message",
  agentStatus: "mcp-agent-status",
  nudge: "mcp-nudge",
} as const;

export interface McpNudgePayload {
  workspace_id: string;
  terminal_id: string;
  prompt: string;
}

export interface McpTasksChangedPayload {
  workspace_id: string;
}

export interface McpAgentStatusPayload {
  workspace_id: string;
  terminal_id: string;
  status: McpAgentStatus | null;
}

export function mcpServerInfo(): Promise<McpServerInfo> {
  return invokeCommand("mcpServerInfo");
}

export function mcpSetEnabled(isEnabled: boolean): Promise<McpServerInfo> {
  return invokeCommand("mcpSetEnabled", { isEnabled });
}

export function mcpListTasks(workspaceId: string): Promise<McpTask[]> {
  return invokeCommand("mcpListTasks", { workspaceId });
}

export function mcpCreateTask(
  workspaceId: string,
  input: { title: string; description?: string; priority?: McpTaskPriority; assignee?: string | null },
): Promise<McpTask> {
  return invokeCommand("mcpCreateTask", {
    request: {
      workspaceId,
      title: input.title,
      description: input.description ?? null,
      priority: input.priority ?? null,
      assignee: input.assignee ?? null,
    },
  });
}

export function mcpUpdateTask(workspaceId: string, id: string, patch: McpTaskPatch): Promise<McpTask> {
  return invokeCommand("mcpUpdateTask", { request: { workspaceId, id, patch } });
}

export function mcpDeleteTask(workspaceId: string, id: string): Promise<void> {
  return invokeCommand("mcpDeleteTask", { workspaceId, id });
}

export function mcpAgentStatuses(workspaceId: string): Promise<McpAgentStatus[]> {
  return invokeCommand("mcpAgentStatuses", { workspaceId });
}

export function agentUsage(workspaceId: string): Promise<AgentTokenUsage[]> {
  return invokeCommand("agentUsage", { workspaceId });
}

export function onMcpTasksChanged(handler: (payload: McpTasksChangedPayload) => void): Promise<UnlistenFn> {
  return listenPayload(MCP_EVENTS.tasksChanged, handler);
}

export function onMcpAgentStatus(handler: (payload: McpAgentStatusPayload) => void): Promise<UnlistenFn> {
  return listenPayload(MCP_EVENTS.agentStatus, handler);
}

export function onMcpNudge(handler: (payload: McpNudgePayload) => void): Promise<UnlistenFn> {
  return listenPayload(MCP_EVENTS.nudge, handler);
}

export const mcpApi = {
  mcpServerInfo,
  mcpSetEnabled,
  mcpListTasks,
  mcpCreateTask,
  mcpUpdateTask,
  mcpDeleteTask,
  mcpAgentStatuses,
  agentUsage,
} as const;
