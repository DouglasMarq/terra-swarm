// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace, WorkspaceSnapshotV2 } from "../domain/workspace.model";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { registerTerminal, unregisterTerminal } from "../terminalRegistry";
import { useOrchestrationStore } from "../stores/orchestrationStore";
import { useUiStore } from "../stores/uiStore";
import { defined } from "../test/defined";
import { useFocusTracking } from "./useFocusTracking";

const workspaces: Workspace[] = [
  { id: "ws-1", name: "one", cwd: "/one", terminals: [{ id: "pty-1", command: "claude", width: null }, { id: "pty-2", command: "codex", width: null }] },
  { id: "ws-2", name: "two", cwd: "/two", terminals: [{ id: "pty-3", command: "zsh", width: null, paneId: "pane-custom", tabId: "tab-custom" }] },
];

type Props = {
  workspaces: readonly Workspace[];
  activeId: string | null;
  focusedId: string | null;
  snapshot: WorkspaceSnapshotV2 | null;
  isModalOpen: boolean;
};

function derivedSnapshot(): WorkspaceSnapshotV2 {
  useOrchestrationStore.getState().sync(workspaces);
  return defined(useOrchestrationStore.getState().snapshot);
}

function renderTracking(initial: Partial<Props> = {}) {
  const props: Props = { workspaces, activeId: null, focusedId: null, snapshot: null, isModalOpen: false, ...initial };
  return renderHook((current: Props) => useFocusTracking(current), { initialProps: props });
}

const placements = () => invoke.mock.calls.filter(([command]) => command === "set_terminal_placement").map(([, payload]) => payload);

describe("useFocusTracking", () => {
  beforeEach(() => {
    invoke.mockReset().mockResolvedValue(undefined);
    useUiStore.setState({ focusedId: null });
  });

  afterEach(() => {
    vi.useRealTimers();
    useOrchestrationStore.getState().reset();
  });

  it("Given a focus remembered per workspace, when switching away and back, then the remembered terminal is focused again", () => {
    const view = renderTracking({ activeId: "ws-1", focusedId: "pty-2" });

    view.rerender({ workspaces, activeId: "ws-2", focusedId: null, snapshot: null, isModalOpen: false });
    expect(useUiStore.getState().focusedId).toBeNull();

    view.rerender({ workspaces, activeId: "ws-1", focusedId: null, snapshot: null, isModalOpen: false });
    expect(useUiStore.getState().focusedId).toBe("pty-2");
  });

  it("Given a forgotten workspace, when switching back to it, then no terminal is refocused", () => {
    const view = renderTracking({ activeId: "ws-1", focusedId: "pty-2" });
    view.rerender({ workspaces, activeId: "ws-2", focusedId: null, snapshot: null, isModalOpen: false });

    act(() => view.result.current.forgetWorkspace("ws-1"));
    view.rerender({ workspaces, activeId: "ws-1", focusedId: null, snapshot: null, isModalOpen: false });

    expect(useUiStore.getState().focusedId).toBeNull();
  });

  it("Given a focus already inside the newly active workspace, when switching, then it is kept", () => {
    const view = renderTracking({ activeId: "ws-2" });
    act(() => useUiStore.setState({ focusedId: "pty-1" }));

    view.rerender({ workspaces, activeId: "ws-1", focusedId: "pty-1", snapshot: null, isModalOpen: false });

    expect(useUiStore.getState().focusedId).toBe("pty-1");
  });

  it("Given an unknown active workspace, when switching to it, then focus is left alone", () => {
    act(() => useUiStore.setState({ focusedId: "pty-1" }));

    renderTracking({ activeId: "ws-ghost" });

    expect(useUiStore.getState().focusedId).toBe("pty-1");
  });

  it("Given a focused terminal and a snapshot, when the focus settles, then its pane and tab are persisted once", async () => {
    vi.useFakeTimers();
    const snapshot = derivedSnapshot();
    invoke.mockClear();
    const view = renderTracking({ activeId: "ws-1", focusedId: "pty-2", snapshot });

    view.rerender({ workspaces, activeId: "ws-1", focusedId: "pty-2", snapshot, isModalOpen: false });
    await act(() => vi.advanceTimersByTimeAsync(100));

    expect(placements()).toEqual([{ request: { workspaceId: "ws-1", terminalId: "pty-2", paneId: "pane-ws-1-2", tabId: "tab-ws-1-2" } }]);
    expect(invoke).toHaveBeenCalledWith("set_active_pane", { request: { workspaceId: "ws-1", paneId: "pane-ws-1-2" } });
  });

  it("Given a terminal with its own pane and tab, when focused, then those ids are persisted", async () => {
    vi.useFakeTimers();
    const snapshot = derivedSnapshot();
    invoke.mockClear();

    renderTracking({ activeId: "ws-2", focusedId: "pty-3", snapshot });
    await act(() => vi.advanceTimersByTimeAsync(100));

    expect(placements()).toEqual([{ request: { workspaceId: "ws-2", terminalId: "pty-3", paneId: "pane-custom", tabId: "tab-custom" } }]);
  });

  it("Given the placement cannot be saved, when the focus settles, then the failure is only logged", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const snapshot = derivedSnapshot();
    invoke.mockRejectedValue(new Error("offline"));

    renderTracking({ activeId: "ws-1", focusedId: "pty-1", snapshot });
    await act(() => vi.advanceTimersByTimeAsync(100));

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("Given no focus or a focus outside the workspace, when a snapshot is present, then nothing is persisted", async () => {
    vi.useFakeTimers();
    const snapshot = derivedSnapshot();
    invoke.mockClear();

    const view = renderTracking({ activeId: "ws-1", focusedId: null, snapshot });
    view.rerender({ workspaces, activeId: "ws-1", focusedId: "pty-3", snapshot, isModalOpen: false });
    view.rerender({ workspaces, activeId: "ws-ghost", focusedId: "pty-3", snapshot, isModalOpen: false });
    await act(() => vi.advanceTimersByTimeAsync(100));

    expect(placements()).toEqual([]);
  });

  it("Given a registered focused terminal, when no modal is open, then the terminal receives keyboard focus on the next frame", async () => {
    const focus = vi.fn();
    const partial: Pick<Terminal, "focus"> = { focus };
    // Only focus() is called on registered terminals here; a live xterm needs a DOM renderer.
    const term = partial as Terminal;
    registerTerminal("pty-1", term);

    renderTracking({ activeId: "ws-1", focusedId: "pty-1" });

    await vi.waitFor(() => expect(focus).toHaveBeenCalled());
    unregisterTerminal("pty-1", term);
  });

  it("Given a text input focused or a modal open, when a terminal is focused, then keyboard focus is not stolen", async () => {
    const focus = vi.fn();
    const partial: Pick<Terminal, "focus"> = { focus };
    // Only focus() is called on registered terminals here; a live xterm needs a DOM renderer.
    const term = partial as Terminal;
    registerTerminal("pty-1", term);
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();

    renderTracking({ activeId: "ws-1", focusedId: "pty-1" });
    input.remove();
    renderTracking({ activeId: "ws-1", focusedId: "pty-1", isModalOpen: true });
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(focus).not.toHaveBeenCalled();
    unregisterTerminal("pty-1", term);
  });
});
