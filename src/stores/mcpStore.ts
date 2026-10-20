import { useMemo } from "react";
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  MCP_EVENTS,
  mcpApi,
  type McpAgentStatusPayload,
  type McpNudgePayload,
  type McpTasksChangedPayload,
} from "../lib/tauri/mcp";
import { sendPromptToTerminal } from "../app/sendPromptToTerminal";
import { taskNumber } from "../domain/tasks";
import { errorMessage } from "../lib/errors/errorMessage";
import type {
  McpAgentState,
  McpAgentStatus,
  McpServerInfo,
  McpTask,
  McpTaskPatch,
  McpTaskPriority,
  McpTaskStatus,
} from "../types";

/** Column order of the board: what is moving first, finished work last. */
export const TASK_STATUS_ORDER: readonly McpTaskStatus[] = ["in_progress", "todo", "blocked", "review", "done"];
export const TASK_PRIORITIES: readonly McpTaskPriority[] = ["urgent", "high", "medium", "low"];

const PRIORITY_RANK: Record<McpTaskPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

/** Tasks bucketed by status, each bucket sorted by priority, then board position. */
export function groupTasksByStatus(tasks: readonly McpTask[]): Record<McpTaskStatus, McpTask[]> {
  const groups = Object.fromEntries(TASK_STATUS_ORDER.map((status) => [status, [] as McpTask[]])) as Record<
    McpTaskStatus,
    McpTask[]
  >;
  for (const task of tasks) (groups[task.status] ?? groups.todo).push(task);
  for (const status of TASK_STATUS_ORDER) {
    groups[status].sort(
      (a, b) =>
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
        a.position - b.position ||
        taskNumber(a.id) - taskNumber(b.id),
    );
  }
  return groups;
}

export interface McpState {
  server: McpServerInfo | null;
  /** Tasks by workspace id; a workspace appears once it has been loaded. */
  tasks: Record<string, McpTask[]>;
  /** Reported agent states by terminal id. */
  statuses: Record<string, McpAgentStatus>;
  error: string | null;
  loadServer: () => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
  loadTasks: (workspaceId: string) => Promise<void>;
  loadStatuses: (workspaceId: string) => Promise<void>;
  createTask: (
    workspaceId: string,
    input: { title: string; description?: string; priority?: McpTaskPriority; assignee?: string | null },
  ) => Promise<McpTask | null>;
  /** Resolves to the updated task, or null when the update failed (the reason is in `error`). */
  updateTask: (workspaceId: string, id: string, patch: McpTaskPatch) => Promise<McpTask | null>;
  deleteTask: (workspaceId: string, id: string) => Promise<void>;
  applyStatus: (payload: McpAgentStatusPayload) => void;
  clearError: () => void;
  reset: () => void;
}

function upsert(list: readonly McpTask[] | undefined, task: McpTask): McpTask[] {
  const next = (list ?? []).filter((candidate) => candidate.id !== task.id);
  next.push(task);
  return next;
}

export const useMcpStore = create<McpState>((set, get) => ({
  server: null,
  tasks: {},
  statuses: {},
  error: null,

  loadServer: async () => {
    try {
      set({ server: await mcpApi.mcpServerInfo() });
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  setEnabled: async (enabled) => {
    try {
      set({ server: await mcpApi.mcpSetEnabled(enabled) });
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  loadTasks: async (workspaceId) => {
    try {
      const list = await mcpApi.mcpListTasks(workspaceId);
      set((state) => ({ tasks: { ...state.tasks, [workspaceId]: list } }));
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  loadStatuses: async (workspaceId) => {
    try {
      const list = await mcpApi.mcpAgentStatuses(workspaceId);
      set((state) => {
        const statuses = Object.fromEntries(
          Object.entries(state.statuses).filter(([, status]) => status.workspace_id !== workspaceId),
        );
        for (const status of list) statuses[status.terminal_id] = status;
        return { statuses };
      });
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  createTask: async (workspaceId, input) => {
    try {
      const task = await mcpApi.mcpCreateTask(workspaceId, input);
      set((state) => ({ tasks: { ...state.tasks, [workspaceId]: upsert(state.tasks[workspaceId], task) } }));
      return task;
    } catch (error) {
      set({ error: errorMessage(error) });
      return null;
    }
  },

  updateTask: async (workspaceId, id, patch) => {
    try {
      const task = await mcpApi.mcpUpdateTask(workspaceId, id, patch);
      set((state) => ({ tasks: { ...state.tasks, [workspaceId]: upsert(state.tasks[workspaceId], task) } }));
      return task;
    } catch (error) {
      set({ error: errorMessage(error) });
      return null;
    }
  },

  deleteTask: async (workspaceId, id) => {
    try {
      await mcpApi.mcpDeleteTask(workspaceId, id);
      set((state) => ({
        tasks: { ...state.tasks, [workspaceId]: (state.tasks[workspaceId] ?? []).filter((task) => task.id !== id) },
      }));
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  applyStatus: ({ terminal_id, status }) => {
    const statuses = { ...get().statuses };
    if (status) statuses[terminal_id] = status;
    else delete statuses[terminal_id];
    set({ statuses });
  },

  clearError: () => set({ error: null }),
  reset: () => set({ server: null, tasks: {}, statuses: {}, error: null }),
}));

/** Reported agent states by terminal id, for the status dots everywhere. */
export function useReportedStates(): Record<string, McpAgentState> {
  const statuses = useMcpStore((state) => state.statuses);
  return useMemo(
    () => Object.fromEntries(Object.values(statuses).map((status) => [status.terminal_id, status.state])),
    [statuses],
  );
}

/**
 * Keep the store in step with agent activity. A board is refetched only for
 * workspaces that have been opened, so idle projects cost nothing.
 */
export function startMcpEventBridge(
  onNudge: (payload: McpNudgePayload) => void = (payload) => {
    void sendPromptToTerminal(payload.terminal_id, payload.prompt).catch((error) =>
      console.warn(`failed to wake ${payload.terminal_id}:`, error),
    );
  },
): () => void {
  const pending = [
    listen<McpTasksChangedPayload>(MCP_EVENTS.tasksChanged, (event) => {
      const workspaceId = event.payload?.workspace_id;
      if (workspaceId && workspaceId in useMcpStore.getState().tasks) {
        void useMcpStore.getState().loadTasks(workspaceId);
      }
    }),
    listen<McpAgentStatusPayload>(MCP_EVENTS.agentStatus, (event) => {
      if (event.payload?.terminal_id) useMcpStore.getState().applyStatus(event.payload);
    }),
    listen<McpNudgePayload>(MCP_EVENTS.nudge, (event) => {
      if (event.payload?.terminal_id && event.payload.prompt) onNudge(event.payload);
    }),
  ];
  return () => {
    for (const unlisten of pending) void unlisten.then((stop) => stop()).catch((error) => console.warn("failed to stop listening for MCP events:", error));
  };
}
