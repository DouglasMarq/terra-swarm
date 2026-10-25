import type { WorktreeDiff, WorktreePullRequest, WorktreeStatus } from "../../domain/worktree.model";
import { invokeCommand } from "./commands";

function worktreeStatus(workspaceId: string, terminalId: string): Promise<WorktreeStatus | null> {
  return invokeCommand("worktreeStatus", { workspaceId, terminalId });
}

function worktreeRemove(workspaceId: string, terminalId: string, shouldDeleteBranch: boolean): Promise<void> {
  return invokeCommand("worktreeRemove", { request: { workspaceId, terminalId, shouldDeleteBranch } });
}

function worktreeDiff(workspaceId: string, terminalId: string): Promise<WorktreeDiff> {
  return invokeCommand("worktreeDiff", { workspaceId, terminalId });
}

function worktreeCommit(workspaceId: string, terminalId: string, message: string): Promise<WorktreeStatus> {
  return invokeCommand("worktreeCommit", { request: { workspaceId, terminalId, message } });
}

function worktreeMerge(workspaceId: string, terminalId: string): Promise<WorktreeStatus> {
  return invokeCommand("worktreeMerge", { workspaceId, terminalId });
}

function worktreeOpenPr(pullRequest: WorktreePullRequest): Promise<string> {
  return invokeCommand("worktreeOpenPr", { request: pullRequest });
}

export const worktreeApi = {
  worktreeStatus,
  worktreeRemove,
  worktreeDiff,
  worktreeCommit,
  worktreeMerge,
  worktreeOpenPr,
} as const;
