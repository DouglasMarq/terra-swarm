import { useMemo } from "react";
import { create } from "zustand";
import {
  mcpApi,
  onMcpAgentStatus,
  onMcpNudge,
  onMcpTasksChanged,
  type McpAgentStatusPayload,
  type McpNudgePayload,
} from "../lib/tauri/mcp";
import { errorMessage } from "../lib/errors/errorMessage";
import type { McpAgentState, McpAgentStatus, McpServerInfo, McpTask, McpTaskPatch, McpTaskPriority } from "../domain/mcp.model";

export interface McpState {
  server: McpServerInfo | null;
  /** Tasks by workspace id; a workspace appears once it has been loaded. */
  tasks: Record<string, McpTask[]>;
  /** Reported agent states by terminal id. */
  statuses: Record<string, McpAgentStatus>;
  error: string | null;
  loadServer: () => Promise<void>;
  setEnabled: (isEnabled: boolean) => Promise<void>;
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

  setEnabled: async (isEnabled) => {
    try {
      set({ server: await mcpApi.mcpSetEnabled(isEnabled) });
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
export function startMcpEventBridge(onNudge: (payload: McpNudgePayload) => void): () => void {
  const pending = [
    onMcpTasksChanged((payload) => {
      const workspaceId = payload?.workspace_id;
      if (workspaceId && workspaceId in useMcpStore.getState().tasks) {
        void useMcpStore.getState().loadTasks(workspaceId);
      }
    }),
    onMcpAgentStatus((payload) => {
      if (payload?.terminal_id) useMcpStore.getState().applyStatus(payload);
    }),
    onMcpNudge((payload) => {
      if (payload?.terminal_id && payload.prompt) onNudge(payload);
    }),
  ];
  return () => {
    for (const unlisten of pending) void unlisten.then((stop) => stop()).catch((error) => console.warn("failed to stop listening for MCP events:", error));
  };
}
