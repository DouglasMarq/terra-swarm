import { useEffect } from "react";
import { useMcpStore } from "../../stores/mcpStore";

export function useWorkspaceTasks(workspaceId: string | null) {
  const tasks = useMcpStore((state) => (workspaceId ? state.tasks[workspaceId] : undefined));
  const statuses = useMcpStore((state) => state.statuses);
  const server = useMcpStore((state) => state.server);
  const error = useMcpStore((state) => state.error);
  const { loadTasks, loadStatuses, loadServer } = useMcpStore.getState();

  useEffect(() => {
    void loadServer();
  }, [loadServer]);

  useEffect(() => {
    if (!workspaceId) return;
    void loadTasks(workspaceId);
    void loadStatuses(workspaceId);
  }, [workspaceId, loadTasks, loadStatuses]);

  return { tasks, statuses, server, error };
}
