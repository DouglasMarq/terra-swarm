// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerInfo, McpTask } from "../../domain/mcp.model";

const api = vi.hoisted(() => ({
  mcpServerInfo: vi.fn(),
  mcpListTasks: vi.fn(),
  mcpAgentStatuses: vi.fn(),
}));

vi.mock("../../lib/tauri/mcp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/tauri/mcp")>()),
  mcpApi: api,
}));

import { useMcpStore } from "../../stores/mcpStore";
import { useWorkspaceTasks } from "./useWorkspaceTasks";

const server: McpServerInfo = {
  isEnabled: true,
  isAvailable: true,
  isRunning: true,
  url: "http://127.0.0.1:9/mcp",
  port: 9,
  dbPath: "/tmp/mcp.db",
  error: null,
};

const task: McpTask = {
  id: "1",
  workspace_id: "ws-1",
  title: "Write the docs",
  description: "",
  status: "todo",
  assignee: null,
  created_by: "t-1",
  priority: "medium",
  labels: [],
  position: 1,
  depends_on: [],
  blocked_by: [],
  created_at: 1,
  updated_at: 1,
};

describe("useWorkspaceTasks", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    api.mcpServerInfo.mockResolvedValue(server);
    api.mcpListTasks.mockResolvedValue([task]);
    api.mcpAgentStatuses.mockResolvedValue([
      { terminal_id: "t-1", workspace_id: "ws-1", state: "working", summary: "on it", updated_at: 1 },
    ]);
    useMcpStore.getState().reset();
  });

  it("Given a workspace, when the hook mounts, then it loads the server, the tasks and the agent statuses", async () => {
    const { result } = renderHook(() => useWorkspaceTasks("ws-1"));

    await waitFor(() => expect(result.current.tasks).toEqual([task]));
    expect(result.current.server).toEqual(server);
    expect(result.current.statuses["t-1"]?.state).toBe("working");
    expect(result.current.error).toBeNull();
  });

  it("Given no workspace, when the hook mounts, then it loads only the server", async () => {
    const { result } = renderHook(() => useWorkspaceTasks(null));

    await waitFor(() => expect(result.current.server).toEqual(server));
    expect(result.current.tasks).toBeUndefined();
    expect(api.mcpListTasks).not.toHaveBeenCalled();
    expect(api.mcpAgentStatuses).not.toHaveBeenCalled();
  });
});
