import type { WorktreeStatus } from "../../types";
import { invokeCommand } from "./commands";

function worktreeStatus(workspaceId: string, terminalId: string): Promise<WorktreeStatus | null> {
  return invokeCommand("worktreeStatus", { workspaceId, terminalId });
}

function worktreeRemove(workspaceId: string, terminalId: string, deleteBranch: boolean): Promise<void> {
  return invokeCommand("worktreeRemove", { workspaceId, terminalId, deleteBranch });
}

export const worktreeApi = { worktreeStatus, worktreeRemove } as const;
