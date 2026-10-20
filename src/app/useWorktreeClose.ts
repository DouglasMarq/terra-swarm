import { useState } from "react";
import { api } from "../api";
import type { Workspace, WorktreeStatus } from "../types";
import { t } from "../i18n";
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

/**
 * Closing an agent that works in its own worktree. A worktree with nothing
 * to lose is removed with its branch; one with uncommitted changes or
 * unmerged commits asks first.
 */
export function useWorktreeClose(workspaces: readonly Workspace[], sessions: TerminalSessions) {
  const [pending, setPending] = useState<PendingClose | null>(null);

  const removeWorktree = async (workspaceId: string, terminalId: string, deleteBranch: boolean) => {
    // The agent's shell must not keep running inside the folder.
    await api.stopTerminal(terminalId).catch((error) => console.warn(`failed to stop ${terminalId}:`, error));
    await api.worktreeRemove(workspaceId, terminalId, deleteBranch).catch((error) => {
      console.error(`failed to remove the worktree of ${terminalId}:`, error);
      useTerminalRuntimeStore.getState().pushSystemNotification(t("app.worktreeRemoveFailed", { detail: String(error) }));
    });
  };

  /** Close an agent, asking about its worktree when there is work to lose. */
  const request = async (terminalId: string) => {
    const workspace = workspaces.find((candidate) => candidate.terminals.some((terminal) => terminal.id === terminalId));
    const terminal = workspace?.terminals.find((candidate) => candidate.id === terminalId);
    if (!workspace || !terminal?.worktree) {
      await sessions.close(terminalId);
      return;
    }
    const status = await api.worktreeStatus(workspace.id, terminalId).catch(() => null);
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

  const remove = async (deleteBranch: boolean) => {
    if (!pending) return;
    setPending(null);
    await removeWorktree(pending.workspaceId, pending.terminalId, deleteBranch);
    await sessions.close(pending.terminalId);
  };

  return {
    request,
    dialog: {
      target: pending ? { label: pending.label, status: pending.status } : null,
      onKeep: () => void keep(),
      onDelete: (deleteBranch: boolean) => void remove(deleteBranch),
      onCancel: () => setPending(null),
      /** Look at the work before deciding; the agent stays open. */
      onReview: () => {
        if (!pending) return;
        setPending(null);
        useReviewStore.getState().open({ workspaceId: pending.workspaceId, terminalId: pending.terminalId, label: pending.label });
      },
    },
  };
}
