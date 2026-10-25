// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResumeItem } from "../domain/terminal.model";
import type { Workspace } from "../domain/workspace.model";

const api = vi.hoisted(() => ({
  killTerminal: vi.fn(),
  storeSavedAt: vi.fn(),
  listWorkspaces: vi.fn(),
  listGroups: vi.fn(),
}));
vi.mock("../api", () => ({ api }));

import { useResumeQueue } from "./useResumeQueue";
import { useWorkspaces } from "./useWorkspaces";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useTerminalRuntimeStore } from "../stores/terminalRuntimeStore";
import { useOrchestrationStore } from "../stores/orchestrationStore";
import { useUiStore } from "../stores/uiStore";

function item(id: string): ResumeItem {
  return { terminalId: id, wsId: "ws-1", wsName: "terra", cwd: "/tmp", command: "claude", agentId: "claude", resumeCommand: "claude --continue" };
}

function fakeSessions(failing: string[] = []) {
  return {
    forget: vi.fn(),
    resumeItem: vi.fn(async (resume: ResumeItem) => {
      if (failing.includes(resume.terminalId)) throw new Error("boom");
    }),
    resumeItems: vi.fn(async (items: readonly ResumeItem[]) =>
      items.map((resume) => ({
        id: resume.terminalId,
        status: failing.includes(resume.terminalId) ? ("failed" as const) : ("succeeded" as const),
        error: failing.includes(resume.terminalId) ? new Error("boom") : undefined,
        startedAt: 0,
        finishedAt: 0,
      })),
    ),
    notifyResumeFailures: vi.fn(),
  };
}

describe("useResumeQueue", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    api.storeSavedAt.mockResolvedValue(123);
    api.killTerminal.mockResolvedValue(undefined);
    usePreferencesStore.setState({ shouldAutoResume: false });
  });
  afterEach(() => useTerminalRuntimeStore.getState().reset());

  it("offers sessions, then resumes all and keeps only the failures", async () => {
    const sessions = fakeSessions(["t-2"]);
    const refresh = vi.fn(async () => {});
    const { result } = renderHook(() => useResumeQueue(sessions, refresh));
    act(() => result.current.offer([item("t-1"), item("t-2")]));
    expect(result.current.isOpen).toBe(true);
    await act(() => result.current.resumeAll());
    expect(useTerminalRuntimeStore.getState().resumeItems?.map((entry) => entry.terminalId)).toEqual(["t-2"]);
    expect(refresh).toHaveBeenCalled();
  });

  it("resumes automatically when the user chose it", async () => {
    usePreferencesStore.setState({ shouldAutoResume: true });
    const sessions = fakeSessions();
    const { result } = renderHook(() => useResumeQueue(sessions, vi.fn(async () => {})));
    await act(async () => result.current.offer([item("t-1")]));
    await vi.waitFor(() => expect(sessions.resumeItems).toHaveBeenCalled());
    expect(result.current.isOpen).toBe(false);
  });

  it("only forgets a dismissed session after the backend deleted it", async () => {
    const sessions = fakeSessions();
    const { result } = renderHook(() => useResumeQueue(sessions, vi.fn(async () => {})));
    act(() => result.current.offer([item("t-1")]));
    api.killTerminal.mockRejectedValueOnce(new Error("busy"));
    await act(() => result.current.dismissOne(item("t-1")));
    expect(sessions.forget).not.toHaveBeenCalled();
    expect(useTerminalRuntimeStore.getState().resumeItems).toHaveLength(1);
    await act(() => result.current.dismissOne(item("t-1")));
    expect(sessions.forget).toHaveBeenCalledWith(["t-1"]);
    expect(useTerminalRuntimeStore.getState().resumeItems ?? []).toHaveLength(0);
  });
});

describe("useWorkspaces", () => {
  it("loads projects and keeps a visible active one", async () => {
    const list: Workspace[] = [
      { id: "ws-1", name: "one", cwd: "/a", terminals: [] },
      { id: "ws-2", name: "two", cwd: "/b", terminals: [] },
    ];
    api.listWorkspaces.mockResolvedValue(list);
    api.listGroups.mockRejectedValue(new Error("old binary"));
    useUiStore.setState({ activeId: "ws-2" });
    const { result } = renderHook(() => useWorkspaces());
    await act(() => result.current.refresh());
    expect(result.current.workspaces).toHaveLength(2);
    expect(useOrchestrationStore.getState().snapshot?.projects.map((project) => project.id)).toEqual(["ws-1", "ws-2"]);
    expect(useUiStore.getState().activeId).toBe("ws-2");
  });
});
