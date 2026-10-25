import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { translateNow } from "../i18n";
import { errorMessage } from "../lib/errors/errorMessage";
import type { ReviewTarget } from "../stores/reviewStore";
import type { WorktreeDiff } from "../domain/worktree.model";

export type WorktreeReviewAction = "load" | "commit" | "merge" | "pr";

export interface WorktreeReview {
  diff: WorktreeDiff | null;
  /** The action in flight; every action waits for the previous one. */
  busy: WorktreeReviewAction | null;
  error: string | null;
  /** What the last action did, for the user. */
  notice: string | null;
  /** The pull request opened from this dialog, if any. */
  prUrl: string | null;
  load: () => Promise<void>;
  /** Each action reloads the diff afterwards and resolves to whether it succeeded. */
  commit: (message: string) => Promise<boolean>;
  merge: () => Promise<boolean>;
  openPullRequest: (title: string, body: string) => Promise<boolean>;
}

/**
 * The diff of an isolated agent's branch and the git actions on it (commit,
 * merge into the base branch, push and open a pull request). Loads when the
 * target changes; nothing runs unless the user asks for it.
 */
export function useWorktreeReview(target: ReviewTarget | null): WorktreeReview {
  const [diff, setDiff] = useState<WorktreeDiff | null>(null);
  const [busy, setBusy] = useState<WorktreeReviewAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [prUrl, setPrUrl] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!target) return;
    setBusy("load");
    setError(null);
    try {
      setDiff(await api.worktreeDiff(target.workspaceId, target.terminalId));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  }, [target]);

  useEffect(() => {
    setDiff(null);
    setNotice(null);
    setError(null);
    setPrUrl(null);
    void load();
  }, [load]);

  const run = async (
    kind: Exclude<WorktreeReviewAction, "load">,
    action: (target: ReviewTarget) => Promise<string>,
  ): Promise<boolean> => {
    if (!target) return false;
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      setNotice(await action(target));
      await load();
      return true;
    } catch (failure) {
      setError(errorMessage(failure));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const commit = (message: string) =>
    run("commit", async ({ workspaceId, terminalId }) => {
      await api.worktreeCommit(workspaceId, terminalId, message);
      return translateNow("review.committed");
    });

  const merge = () => {
    const status = diff?.status;
    return run("merge", async ({ workspaceId, terminalId }) => {
      await api.worktreeMerge(workspaceId, terminalId);
      return translateNow("review.merged", { branch: status?.branch ?? "", base: status?.base ?? "" });
    });
  };

  const openPullRequest = (title: string, body: string) =>
    run("pr", async ({ workspaceId, terminalId }) => {
      setPrUrl(await api.worktreeOpenPr(workspaceId, terminalId, title, body));
      return translateNow("review.prOpened");
    });

  return { diff, busy, error, notice, prUrl, load, commit, merge, openPullRequest };
}
