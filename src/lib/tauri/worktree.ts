import type { WorktreeDiff, WorktreeStatus } from "../../domain/worktree.model";
import { invokeCommand } from "./commands";

function worktreeStatus(workspaceId: string, terminalId: string): Promise<WorktreeStatus | null> {
  return invokeCommand("worktreeStatus", { workspaceId, terminalId });
}

function worktreeRemove(workspaceId: string, terminalId: string, shouldDeleteBranch: boolean): Promise<void> {
  return invokeCommand("worktreeRemove", { workspaceId, terminalId, deleteBranch: shouldDeleteBranch });
}

function worktreeDiff(workspaceId: string, terminalId: string): Promise<WorktreeDiff> {
  return invokeCommand("worktreeDiff", { workspaceId, terminalId });
}

function worktreeCommit(workspaceId: string, terminalId: string, message: string): Promise<WorktreeStatus> {
  return invokeCommand("worktreeCommit", { workspaceId, terminalId, message });
}

function worktreeMerge(workspaceId: string, terminalId: string): Promise<WorktreeStatus> {
  return invokeCommand("worktreeMerge", { workspaceId, terminalId });
}

/** Pushes the agent's branch to origin and opens a pull request; returns its URL. */
function worktreeOpenPr(workspaceId: string, terminalId: string, title: string, body: string): Promise<string> {
  return invokeCommand("worktreeOpenPr", { workspaceId, terminalId, title, body });
}

export const worktreeApi = {
  worktreeStatus,
  worktreeRemove,
  worktreeDiff,
  worktreeCommit,
  worktreeMerge,
  worktreeOpenPr,
} as const;
