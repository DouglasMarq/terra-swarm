// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../domain/workspace.model";

const apiMock = vi.hoisted(() => ({
  gitBranch: vi.fn<(cwd: string) => Promise<string | null>>(),
}));

vi.mock("../api", () => ({ api: apiMock }));

import { useTerminalRuntimeStore } from "../stores/terminalRuntimeStore";
import { useBranchPolling } from "./useBranchPolling";

beforeEach(() => {
  vi.clearAllMocks();
  useTerminalRuntimeStore.setState({ branches: {} });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useBranchPolling", () => {
  const workspaces: Workspace[] = [
    { id: "ws-alpha", name: "Alpha", cwd: "/alpha", terminals: [] },
    { id: "ws-beta", name: "Beta", cwd: "/beta", terminals: [] },
  ];

  it("Given two project folders, when polling runs, then the branch of each repository is stored", async () => {
    apiMock.gitBranch.mockImplementation((cwd) => Promise.resolve(cwd === "/alpha" ? "main" : null));

    renderHook(() => useBranchPolling(workspaces));

    await waitFor(() => expect(useTerminalRuntimeStore.getState().branches).toEqual({ "ws-alpha": "main" }));
  });

  it("Given unchanged branches, when the next poll runs, then the stored map is kept as is", async () => {
    vi.useFakeTimers();
    apiMock.gitBranch.mockResolvedValue("main");
    renderHook(() => useBranchPolling(workspaces));
    await act(() => vi.advanceTimersByTimeAsync(0));
    const first = useTerminalRuntimeStore.getState().branches;

    await act(() => vi.advanceTimersByTimeAsync(10_000));

    expect(apiMock.gitBranch).toHaveBeenCalledTimes(4);
    expect(useTerminalRuntimeStore.getState().branches).toBe(first);
  });

  it("Given an unmounted poller, when a slow branch lookup resolves, then nothing is stored", async () => {
    let resolveBranch: (branch: string) => void = () => undefined;
    apiMock.gitBranch.mockReturnValue(new Promise((resolve) => { resolveBranch = resolve; }));
    const { unmount } = renderHook(() => useBranchPolling(workspaces.slice(0, 1)));

    unmount();
    await act(async () => resolveBranch("main"));

    expect(useTerminalRuntimeStore.getState().branches).toEqual({});
  });
});
