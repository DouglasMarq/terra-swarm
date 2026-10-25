import { useEffect } from "react";
import { api } from "../api";
import type { Workspace } from "../domain/workspace.model";
import { useTerminalRuntimeStore } from "../stores/terminalRuntimeStore";

const BRANCH_POLL_MS = 10000;

export function useBranchPolling(workspaces: readonly Workspace[]) {
  const signature = workspaces.map((workspace) => `${workspace.id}:${workspace.cwd}`).join("|");
  useEffect(() => {
    const targets = signature
      ? signature.split("|").map((entry) => {
          const separator = entry.indexOf(":");
          return { id: entry.slice(0, separator), cwd: entry.slice(separator + 1) };
        })
      : [];
    let isCancelled = false;
    const poll = async () => {
      const entries = await Promise.all(
        targets.map(async (target) => [target.id, await api.gitBranch(target.cwd).catch(() => null)] as const),
      );
      if (isCancelled) return;
      useTerminalRuntimeStore.getState().setBranches((previous) => {
        const next: Record<string, string> = {};
        for (const [id, branch] of entries) if (branch) next[id] = branch;
        const keys = Object.keys(next);
        const isSame = keys.length === Object.keys(previous).length && keys.every((key) => previous[key] === next[key]);
        return isSame ? previous : next;
      });
    };
    void poll();
    const interval = setInterval(poll, BRANCH_POLL_MS);
    return () => {
      isCancelled = true;
      clearInterval(interval);
    };
  }, [signature]);
}
