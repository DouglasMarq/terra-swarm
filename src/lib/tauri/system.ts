import type { AgentInfo, WorkspaceGitStatus } from "../../types";
import { invokeCommand } from "./commands";

/** Last persistence timestamp used by the session-resume flow. */
export function storeSavedAt(): Promise<number | null> {
  return invokeCommand("storeSavedAt");
}

/** Discover shells and locally installed coding agents. */
export function listShells(): Promise<string[]> {
  return invokeCommand("listShells");
}

export function detectAgents(): Promise<AgentInfo[]> {
  return invokeCommand("detectAgents");
}

export function gitBranch(cwd: string): Promise<string | null> {
  return invokeCommand("gitBranch", { cwd });
}

export function gitStatus(workspaceId: string): Promise<WorkspaceGitStatus> {
  return invokeCommand("gitStatus", { workspaceId });
}

export const systemApi = {
  storeSavedAt,
  listShells,
  detectAgents,
  gitBranch,
  gitStatus,
} as const;
