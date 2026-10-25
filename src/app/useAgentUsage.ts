import { useEffect } from "react";
import { useUsageStore } from "../stores/usageStore";
import type { AgentTokenUsage } from "../domain/agent.model";

/** How often a shown workspace's token usage is read again. */
export const USAGE_REFRESH_MS = 15_000;

/** Keep a workspace's token usage fresh while something shows it. */
export function useAgentUsage(workspaceId: string | null, terminalId: string | null, isActive: boolean): AgentTokenUsage | null {
  const usage = useUsageStore((state) => (terminalId ? state.usage[terminalId] ?? null : null));
  useEffect(() => {
    if (!isActive || !workspaceId) return;
    void useUsageStore.getState().load(workspaceId);
    const timer = window.setInterval(() => void useUsageStore.getState().load(workspaceId), USAGE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [isActive, workspaceId]);
  return usage;
}
