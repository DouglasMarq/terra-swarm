import { create } from "zustand";
import { mcpApi } from "../lib/tauri/mcp";
import type { AgentTokenUsage } from "../domain/agent.model";

interface UsageState {
  /** Usage by terminal id. */
  usage: Record<string, AgentTokenUsage>;
  load: (workspaceId: string) => Promise<void>;
}

export const useUsageStore = create<UsageState>((set) => ({
  usage: {},
  load: async (workspaceId) => {
    try {
      const list = await mcpApi.agentUsage(workspaceId);
      set((state) => {
        const usage = { ...state.usage };
        for (const item of list) usage[item.terminal_id] = item;
        return { usage };
      });
    } catch (error) {
      console.warn("token usage unavailable:", error);
    }
  },
}));
