// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../domain/workspace.model";

const api = vi.hoisted(() => ({ listWorkspaces: vi.fn(), listGroups: vi.fn() }));
vi.mock("../api", () => ({ api }));

import { useOrchestrationStore } from "../stores/orchestrationStore";
import { useUiStore } from "../stores/uiStore";
import { useWorkspaces } from "./useWorkspaces";

const workspaces: Workspace[] = [
  { id: "ws-1", name: "one", cwd: "/one", terminals: [] },
  { id: "ws-2", name: "two", cwd: "/two", terminals: [] },
];

describe("useWorkspaces", () => {
  let consoleSpies: ReturnType<typeof vi.spyOn>[];

  beforeEach(() => {
    api.listWorkspaces.mockReset().mockResolvedValue(workspaces);
    api.listGroups.mockReset().mockResolvedValue([]);
    consoleSpies = [vi.spyOn(console, "warn").mockImplementation(() => undefined), vi.spyOn(console, "error").mockImplementation(() => undefined)];
    useUiStore.setState({ activeId: null });
  });

  afterEach(() => {
    for (const spy of consoleSpies) spy.mockRestore();
    useOrchestrationStore.getState().reset();
  });

  it("Given workspaces with visible containers, when refreshing, then the first visible one becomes active", async () => {
    const { result } = renderHook(() => useWorkspaces());

    await act(() => result.current.refresh());

    expect(result.current.workspaces).toEqual(workspaces);
    expect(useUiStore.getState().activeId).toBe("ws-1");
  });

  it("Given an active workspace that is still visible, when refreshing, then it stays active", async () => {
    const { result } = renderHook(() => useWorkspaces());
    await act(() => result.current.refresh());
    act(() => useUiStore.setState({ activeId: "ws-2" }));

    await act(() => result.current.refresh());

    expect(useUiStore.getState().activeId).toBe("ws-2");
  });

  it("Given no workspaces, when applying them, then nothing is active", () => {
    const { result } = renderHook(() => useWorkspaces());

    act(() => result.current.apply([], []));

    expect(useUiStore.getState().activeId).toBeNull();
  });

  it("Given the group list fails, when refreshing, then workspaces still load without groups", async () => {
    api.listGroups.mockRejectedValue(new Error("no groups"));
    const { result } = renderHook(() => useWorkspaces());

    await act(() => result.current.refresh());

    expect(result.current.workspaces).toEqual(workspaces);
    expect(console.warn).toHaveBeenCalled();
  });

  it("Given the workspace list fails, when refreshing, then the error is logged and nothing changes", async () => {
    api.listWorkspaces.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useWorkspaces());

    await act(() => result.current.refresh());

    expect(result.current.workspaces).toEqual([]);
    expect(console.error).toHaveBeenCalledWith("failed to list workspaces:", expect.any(Error));
  });
});
