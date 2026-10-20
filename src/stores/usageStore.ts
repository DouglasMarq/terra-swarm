import { useEffect } from "react";
import { create } from "zustand";
import { invokeCommand } from "../lib/tauri/commands";
import type { AgentTokenUsage } from "../types";

interface UsageState {
  /** Usage by terminal id. */
  usage: Record<string, AgentTokenUsage>;
  load: (workspaceId: string) => Promise<void>;
}

export const useUsageStore = create<UsageState>((set) => ({
  usage: {},
  load: async (workspaceId) => {
    try {
      const list = await invokeCommand("agentUsage", { workspaceId });
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

const REFRESH_MS = 15_000;

/** Keep a workspace's token usage fresh while something shows it. */
export function useAgentUsage(workspaceId: string | null, terminalId: string | null, active: boolean): AgentTokenUsage | null {
  const usage = useUsageStore((state) => (terminalId ? state.usage[terminalId] ?? null : null));
  useEffect(() => {
    if (!active || !workspaceId) return;
    void useUsageStore.getState().load(workspaceId);
    const timer = window.setInterval(() => void useUsageStore.getState().load(workspaceId), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [active, workspaceId]);
  return usage;
}
