import { useState } from "react";
import { api } from "../api";
import type { Workspace } from "../domain/workspace.model";
import type { WorktreeStatus } from "../domain/worktree.model";
import { translateNow } from "../i18n";
import { agentLabelText, buildAgentLabels } from "../domain/agentLabels";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useReviewStore } from "../stores/reviewStore";
import { useTerminalRuntimeStore } from "../stores/terminalRuntimeStore";
import type { TerminalSessions } from "./useTerminalSessions";

interface PendingClose {
  terminalId: string;
  workspaceId: string;
  label: string;
  status: WorktreeStatus;
}

export type WorktreeCloseSessions = Pick<TerminalSessions, "close">;

export function useWorktreeClose(workspaces: readonly Workspace[], sessions: WorktreeCloseSessions) {
  const [pending, setPending] = useState<PendingClose | null>(null);

  const removeWorktree = async (workspaceId: string, terminalId: string, shouldDeleteBranch: boolean) => {
    await api.stopTerminal(terminalId).catch((error) => console.warn(`failed to stop ${terminalId}:`, error));
    await api.worktreeRemove(workspaceId, terminalId, shouldDeleteBranch).catch((error) => {
      console.error(`failed to remove the worktree of ${terminalId}:`, error);
      useTerminalRuntimeStore.getState().pushSystemNotification(translateNow("app.worktreeRemoveFailed", { detail: String(error) }));
    });
  };

  const request = async (terminalId: string) => {
    const workspace = workspaces.find((candidate) => candidate.terminals.some((terminal) => terminal.id === terminalId));
    const terminal = workspace?.terminals.find((candidate) => candidate.id === terminalId);
    if (!workspace || !terminal?.worktree) {
      await sessions.close(terminalId);
      return;
    }
    let status: WorktreeStatus | null;
    try {
      status = await api.worktreeStatus(workspace.id, terminalId);
    } catch (error) {
      console.error(`failed to read the worktree status of ${terminalId}:`, error);
      useTerminalRuntimeStore.getState().pushSystemNotification(translateNow("app.worktreeStatusFailed", { detail: String(error) }));
      return;
    }
    if (!status || !status.exists) {
      await sessions.close(terminalId);
      return;
    }
    if (status.dirty.length === 0 && status.ahead === 0) {
      await removeWorktree(workspace.id, terminalId, true);
      await sessions.close(terminalId);
      return;
    }
    const labels = buildAgentLabels(workspaces as Workspace[], {
      titles: useTerminalRuntimeStore.getState().titles,
      names: usePreferencesStore.getState().agentNames,
    });
    const label = labels[terminalId];
    setPending({ terminalId, workspaceId: workspace.id, label: label ? agentLabelText(label) : terminalId, status });
  };

  const keep = async () => {
    if (!pending) return;
    setPending(null);
    await sessions.close(pending.terminalId);
  };

  const remove = async (shouldDeleteBranch: boolean) => {
    if (!pending) return;
    setPending(null);
    await removeWorktree(pending.workspaceId, pending.terminalId, shouldDeleteBranch);
    await sessions.close(pending.terminalId);
  };

  return {
    request,
    dialog: {
      target: pending ? { label: pending.label, status: pending.status } : null,
      onKeep: () => void keep(),
      onDelete: (shouldDeleteBranch: boolean) => void remove(shouldDeleteBranch),
      onCancel: () => setPending(null),
      onReview: () => {
        if (!pending) return;
        setPending(null);
        useReviewStore.getState().open({ workspaceId: pending.workspaceId, terminalId: pending.terminalId, label: pending.label });
      },
    },
  };
}
