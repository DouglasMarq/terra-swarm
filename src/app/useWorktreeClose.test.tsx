// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../domain/workspace.model";
import type { WorktreeStatus } from "../domain/worktree.model";

const api = vi.hoisted(() => ({
  stopTerminal: vi.fn(),
  worktreeStatus: vi.fn(),
  worktreeRemove: vi.fn(),
}));
vi.mock("../api", () => ({ api }));

import { useTerminalRuntimeStore } from "../stores/terminalRuntimeStore";
import { useWorktreeClose } from "./useWorktreeClose";
import type { WorktreeCloseSessions } from "./useWorktreeClose";

const worktree = { path: "/wt/t-1", cwd: "/wt/t-1", branch: "terra/t-1", base: "main", repo: "/repo" };
const workspaces: Workspace[] = [
  { id: "ws", name: "ws", cwd: "/repo", terminals: [
    { id: "t-1", command: "claude", width: null, worktree },
    { id: "t-2", command: "claude", width: null },
  ] },
];

function status(extra: Partial<WorktreeStatus> = {}): WorktreeStatus {
  return { branch: "terra/t-1", base: "main", path: "/wt/t-1", dirty: [], ahead: 0, behind: 0, isPresent: true, ...extra };
}

describe("useWorktreeClose", () => {
  let sessions: WorktreeCloseSessions;
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    api.stopTerminal.mockResolvedValue(undefined);
    api.worktreeRemove.mockResolvedValue(undefined);
    sessions = { close: vi.fn(async () => {}) };
    useTerminalRuntimeStore.setState({ notifItems: [] });
  });

  it("Given the worktree status can't be read, when closing the agent, then it notifies and keeps the agent open", async () => {
    api.worktreeStatus.mockRejectedValue(new Error("status unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = renderHook(() => useWorktreeClose(workspaces, sessions));
    await act(() => result.current.request("t-1"));
    expect(sessions.close).not.toHaveBeenCalled();
    expect(api.worktreeRemove).not.toHaveBeenCalled();
    const [notification] = useTerminalRuntimeStore.getState().notifItems;
    expect(notification?.message).toContain("status unavailable");
    expect(notification?.isSystem).toBe(true);
    consoleError.mockRestore();
  });

  it("Given a plain agent, when closing it, then it closes directly", async () => {
    const { result } = renderHook(() => useWorktreeClose(workspaces, sessions));
    await act(() => result.current.request("t-2"));
    expect(sessions.close).toHaveBeenCalledWith("t-2");
    expect(api.worktreeStatus).not.toHaveBeenCalled();
  });

  it("Given a clean worktree, when closing its agent, then the worktree and its branch are removed without asking", async () => {
    api.worktreeStatus.mockResolvedValue(status());
    const { result } = renderHook(() => useWorktreeClose(workspaces, sessions));
    await act(() => result.current.request("t-1"));
    expect(api.stopTerminal).toHaveBeenCalledWith("t-1");
    expect(api.worktreeRemove).toHaveBeenCalledWith("ws", "t-1", true);
    expect(sessions.close).toHaveBeenCalledWith("t-1");
    expect(result.current.dialog.target).toBeNull();
  });

  it("Given a worktree with work to lose, when closing its agent, then it asks first and keeps or deletes as chosen", async () => {
    api.worktreeStatus.mockResolvedValue(status({ dirty: ["app/a.ts"], ahead: 2 }));
    const { result } = renderHook(() => useWorktreeClose(workspaces, sessions));
    await act(() => result.current.request("t-1"));
    expect(sessions.close).not.toHaveBeenCalled();
    expect(result.current.dialog.target?.status.ahead).toBe(2);

    await act(async () => result.current.dialog.onKeep());
    expect(api.worktreeRemove).not.toHaveBeenCalled();
    expect(sessions.close).toHaveBeenCalledWith("t-1");

    await act(() => result.current.request("t-1"));
    await act(async () => result.current.dialog.onDelete(false));
    await vi.waitFor(() => expect(api.worktreeRemove).toHaveBeenCalledWith("ws", "t-1", false));
  });
});
