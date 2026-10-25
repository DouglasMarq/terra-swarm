// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResumeItem, RunningTerminal, SpawnedTerminal } from "../domain/terminal.model";
import type { Workspace } from "../domain/workspace.model";

const tauri = vi.hoisted(() => {
  const handlers = new Map<string, (event: { payload: unknown }) => void>();
  const unlisten = vi.fn();
  return {
    handlers,
    unlisten,
    invoke: vi.fn(),
    listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
      handlers.set(name, handler);
      return unlisten;
    }),
  };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));

import { registerTerminal, unregisterTerminal } from "../terminalRegistry";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useTerminalRuntimeStore } from "../stores/terminalRuntimeStore";
import { useUiStore } from "../stores/uiStore";
import { useTerminalSessions } from "./useTerminalSessions";

const workspaces: Workspace[] = [
  {
    id: "ws-1",
    name: "terra",
    cwd: "/repo",
    terminals: [
      { id: "pty-1", command: "claude", width: null },
      { id: "pty-2", command: "codex", width: null },
    ],
  },
];

const runtime = () => useTerminalRuntimeStore.getState();

function spawned(id: string, seq = 1): SpawnedTerminal {
  return { meta: { id, command: "claude", width: null }, seq };
}

function resumeItem(terminalId: string): ResumeItem {
  return { terminalId, wsId: "ws-1", wsName: "terra", cwd: "/repo", command: "claude", agentId: "claude", resumeCommand: "claude --continue" };
}

type Backend = {
  spawn?: (request: { terminalId: string | null }) => Promise<SpawnedTerminal>;
  running?: () => Promise<RunningTerminal[]>;
  failing?: string[];
};

function backend({ spawn = async () => spawned("pty-9"), running = async () => [{ id: "pty-9", seq: 1 }], failing = [] }: Backend = {}) {
  tauri.invoke.mockImplementation(async (command: string, payload?: { request?: { terminalId: string | null } }) => {
    if (failing.includes(command)) throw new Error(`${command} failed`);
    if (command === "spawn_terminal") return spawn(payload?.request ?? { terminalId: null });
    if (command === "running_terminals") return running();
    return undefined;
  });
}

function emit(name: string, payload: unknown) {
  act(() => tauri.handlers.get(name)?.({ payload }));
}

function renderSessions(list: readonly Workspace[] = workspaces) {
  const refresh = vi.fn(async () => undefined);
  const view = renderHook(() => useTerminalSessions({ workspaces: list, snapshot: null, refresh }));
  return { ...view, refresh, sessions: () => view.result.current };
}

describe("useTerminalSessions", () => {
  let consoleSpies: ReturnType<typeof vi.spyOn>[];

  beforeEach(() => {
    tauri.handlers.clear();
    tauri.invoke.mockReset();
    tauri.unlisten.mockReset();
    backend();
    consoleSpies = [vi.spyOn(console, "warn").mockImplementation(() => undefined), vi.spyOn(console, "error").mockImplementation(() => undefined)];
    usePreferencesStore.setState({ defaultShell: "", agentLaunch: {}, shouldAutoNameAgents: false, agentNames: {} });
    useUiStore.setState({ focusedId: null, expandedId: null });
  });

  afterEach(() => {
    for (const spy of consoleSpies) spy.mockRestore();
    runtime().reset();
  });

  it("Given a tracked terminal, when its exit, notification, context and title events arrive, then the runtime store records them", () => {
    const { sessions } = renderSessions();
    sessions().track(["pty-1"], [{ id: "pty-1", seq: 2 }]);

    emit("terminal-context", { id: "pty-1", workspace_id: "ws-1", used: 42 });
    emit("terminal-title", { id: "pty-1", workspace_id: "ws-1", title: "tests" });
    emit("terminal-notification", { id: "pty-1", workspace_id: "ws-1", count: 1, messages: ["done"] });
    expect(runtime().contextUsage).toEqual({ "pty-1": 42 });
    expect(runtime().titles).toEqual({ "pty-1": "tests" });
    expect(runtime().notifications).toEqual({ "pty-1": 1 });

    emit("terminal-exit", { id: "pty-1", workspace_id: "ws-1", code: 0, seq: 1 });
    expect(runtime().exited).toEqual({});

    emit("terminal-exit", { id: "pty-1", workspace_id: "ws-1", code: 0, seq: 2 });
    expect(runtime().exited).toEqual({ "pty-1": 0 });
    expect(runtime().contextUsage).toEqual({});
  });

  it("Given an untracked terminal, when its events arrive, then they are ignored", () => {
    renderSessions();

    emit("terminal-context", { id: "pty-7", workspace_id: "ws-1", used: 42 });
    emit("terminal-title", { id: "pty-7", workspace_id: "ws-1", title: "tests" });
    emit("terminal-notification", { id: "pty-7", workspace_id: "ws-1", count: 1, messages: ["done"] });
    emit("terminal-exit", { id: "pty-7", workspace_id: "ws-1", code: 0, seq: 1 });

    expect(runtime().contextUsage).toEqual({});
    expect(runtime().titles).toEqual({});
    expect(runtime().notifications).toEqual({});
    expect(runtime().exited).toEqual({});
  });

  it("Given a forgotten terminal, when it exits, then the exit is ignored, and forgetting all returns what was tracked", () => {
    const { sessions } = renderSessions();
    sessions().track(["pty-1", "pty-2"], []);

    sessions().forget(["pty-1"]);
    emit("terminal-exit", { id: "pty-1", workspace_id: "ws-1", code: 0, seq: 1 });
    expect(runtime().exited).toEqual({});

    expect(sessions().forgetAll()).toEqual(["pty-2"]);
    emit("terminal-exit", { id: "pty-2", workspace_id: "ws-1", code: 1, seq: 1 });
    expect(runtime().exited).toEqual({});
  });

  it("Given a burst of workspace changes, when they settle, then workspaces refresh once, and unmounting stops listening", async () => {
    const { refresh, unmount } = renderSessions();

    emit("workspaces-changed", null);
    emit("workspaces-changed", null);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

    unmount();
    await vi.waitFor(() => expect(tauri.unlisten).toHaveBeenCalledTimes(5));
  });

  it("Given a sibling terminal with a size and a placement, when spawning, then it uses that size, places the tab and focuses it", async () => {
    // Only cols and rows are read from registered terminals; a live xterm instance needs a DOM renderer.
    const sibling = { cols: 120, rows: 40 } as Terminal;
    registerTerminal("pty-1", sibling);
    usePreferencesStore.setState({ defaultShell: "/bin/zsh", agentLaunch: { claude: { args: "--fast", env: "" } } });
    const { sessions, refresh } = renderSessions();

    await act(() => sessions().spawnInto("ws-1", "claude", { placement: { paneId: "pane-1" }, shouldUseWorktree: true, role: "reviewer" }));

    expect(tauri.invoke).toHaveBeenCalledWith("spawn_terminal", {
      request: expect.objectContaining({ cols: 120, rows: 40, shell: "/bin/zsh", launch: expect.objectContaining({ shouldUseWorktree: true, role: "reviewer" }) }),
    });
    expect(tauri.invoke).toHaveBeenCalledWith("set_terminal_placement", {
      request: { workspaceId: "ws-1", terminalId: "pty-9", paneId: "pane-1", tabId: "tab-pty-9" },
    });
    expect(useUiStore.getState().focusedId).toBe("pty-9");
    expect(refresh).toHaveBeenCalled();
    unregisterTerminal("pty-1", sibling);
  });

  it("Given automatic agent names, when spawning, then the new agent gets a name", async () => {
    usePreferencesStore.setState({ shouldAutoNameAgents: true, agentNameList: ["Vega", "Lyra"], agentNames: {} });
    const { sessions } = renderSessions();

    await act(() => sessions().spawnInto("ws-1", "claude"));

    expect(usePreferencesStore.getState().agentNames["pty-9"]).toBe("Vega");
  });

  it("Given a placement the backend cannot save, when spawning, then the user is told and the terminal is still focused", async () => {
    backend({ failing: ["set_terminal_placement"] });
    const { sessions } = renderSessions();

    await act(() => sessions().spawnInto("ws-1", "claude", { placement: { paneId: "pane-1", tabId: "tab-x" } }));

    expect(runtime().notifItems[0]?.message).toBe("O terminal iniciou, mas a posição da aba não foi salva.");
    expect(useUiStore.getState().focusedId).toBe("pty-9");
  });

  it("Given a spawned terminal that is no longer running, when registering it, then it is marked exited", async () => {
    backend({ running: async () => [] });
    const { sessions } = renderSessions();
    act(() => runtime().setContextUsage({ "pty-9": 10 }));

    await act(() => sessions().registerSpawned(spawned("pty-9")));

    expect(runtime().exited).toEqual({ "pty-9": null });
    expect(runtime().contextUsage).toEqual({});
  });

  it("Given a spawned terminal already marked exited, when it turns out to be running, then the exit mark is cleared", async () => {
    const { sessions } = renderSessions();
    act(() => runtime().setExited({ "pty-9": 1 }));

    await act(() => sessions().registerSpawned(spawned("pty-9")));

    expect(runtime().exited).toEqual({});
  });

  it("Given the running list cannot be read, when registering a spawn, then the exit state is left alone", async () => {
    backend({ failing: ["running_terminals"] });
    const { sessions } = renderSessions();

    await act(() => sessions().registerSpawned(spawned("pty-9")));

    expect(runtime().exited).toEqual({});
    expect(console.warn).toHaveBeenCalled();
  });

  it("Given a spawn error, when reporting it, then the user sees its detail", () => {
    const { sessions } = renderSessions();

    act(() => sessions().reportSpawnError("no shell"));

    expect(runtime().notifItems[0]?.message).toBe("Não foi possível iniciar o terminal: no shell");
  });

  it("Given the focused and expanded terminal, when closing it even though the kill fails, then focus moves to its neighbor", async () => {
    backend({ failing: ["kill_terminal"] });
    usePreferencesStore.setState({ agentNames: { "pty-2": "Lyra" } });
    useUiStore.setState({ focusedId: "pty-2", expandedId: "pty-2" });
    const { sessions, refresh } = renderSessions();

    await act(() => sessions().close("pty-2"));

    expect(useUiStore.getState()).toMatchObject({ focusedId: "pty-1", expandedId: null });
    expect(usePreferencesStore.getState().agentNames).toEqual({});
    expect(refresh).toHaveBeenCalled();
  });

  it("Given another terminal focused, when closing one, then focus and expansion stay", async () => {
    useUiStore.setState({ focusedId: "pty-1", expandedId: "pty-1" });
    const { sessions } = renderSessions();

    await act(() => sessions().close("pty-2"));

    expect(useUiStore.getState()).toMatchObject({ focusedId: "pty-1", expandedId: "pty-1" });
  });

  it("Given a terminal without a known workspace, when restarting it, then nothing is sent", async () => {
    const { sessions } = renderSessions();

    await act(() => sessions().restart("pty-ghost", "claude"));

    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("Given a known terminal, when restarting it, then it is stopped, respawned in place and its runtime state is cleared", async () => {
    backend({ spawn: async (request) => spawned(request.terminalId ?? "pty-x", 2), running: async () => [{ id: "pty-1", seq: 2 }] });
    const { sessions, refresh } = renderSessions();
    act(() => runtime().setTitles({ "pty-1": "old" }));

    await act(() => sessions().restart("pty-1", "claude"));

    expect(tauri.invoke).toHaveBeenCalledWith("stop_terminal", { id: "pty-1" });
    expect(tauri.invoke).toHaveBeenCalledWith("spawn_terminal", { request: expect.objectContaining({ terminalId: "pty-1", command: "claude" }) });
    expect(runtime().titles).toEqual({});
    expect(refresh).toHaveBeenCalled();
  });

  it("Given a restart whose respawn fails, when restarting, then the terminal is marked exited", async () => {
    backend({ failing: ["spawn_terminal"] });
    const { sessions, refresh } = renderSessions();

    await act(() => sessions().restart("pty-1", "claude"));

    expect(runtime().exited).toEqual({ "pty-1": null });
    expect(refresh).toHaveBeenCalled();
  });

  it("Given a resume that fails, when resuming the item, then it rethrows and marks the terminal exited", async () => {
    backend({ failing: ["spawn_terminal"] });
    const { sessions } = renderSessions();

    await expect(act(() => sessions().resumeItem(resumeItem("pty-1")))).rejects.toThrow("spawn_terminal failed");

    expect(runtime().exited).toEqual({ "pty-1": null });
  });

  it("Given two resume items where one fails, when resuming them and notifying, then only the failure is reported with its label", async () => {
    backend({ spawn: async (request) => (request.terminalId === "pty-2" ? Promise.reject(new Error("busy")) : spawned(request.terminalId ?? "", 1)) });
    const { sessions } = renderSessions();

    let results: Awaited<ReturnType<ReturnType<typeof useTerminalSessions>["resumeItems"]>> = [];
    await act(async () => {
      results = await sessions().resumeItems([resumeItem("pty-1"), resumeItem("pty-2")]);
    });
    act(() => sessions().notifyResumeFailures(results, new Map([["pty-2", "Codex"]])));

    expect(results.map((result) => result.status)).toEqual(["succeeded", "failed"]);
    expect(runtime().notifItems.map((item) => item.message)).toEqual(["Não foi possível retomar Codex: busy"]);
  });

  it("Given a failure without a label, when notifying, then the terminal id is used", () => {
    const { sessions } = renderSessions();

    act(() => sessions().notifyResumeFailures([{ id: "pty-5", status: "failed", error: new Error("gone"), startedAt: 0, finishedAt: 0 }], new Map()));

    expect(runtime().notifItems[0]?.message).toBe("Não foi possível retomar pty-5: gone");
  });

  it("Given no exited or suspended terminals, when resuming them, then nothing is spawned", async () => {
    const { sessions, refresh } = renderSessions();

    await act(() => sessions().resumeTerminals(["pty-1"]));

    expect(tauri.invoke).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("Given exited terminals where one fails to resume, when resuming them, then the failure is reported by agent label", async () => {
    backend({ spawn: async (request) => (request.terminalId === "pty-2" ? Promise.reject(new Error("busy")) : spawned(request.terminalId ?? "", 1)) });
    usePreferencesStore.setState({ agentNames: { "pty-2": "Lyra" } });
    const { sessions, refresh } = renderSessions();
    act(() => runtime().setExited({ "pty-1": 0, "pty-2": 0 }));

    await act(() => sessions().resumeTerminals(["pty-1", "pty-2"]));

    expect(runtime().notifItems).toHaveLength(1);
    expect(runtime().notifItems[0]?.message).toContain("Lyra");
    expect(runtime().notifItems[0]?.message).toContain("busy");
    expect(refresh).toHaveBeenCalled();
  });

  it("Given an exited terminal missing from the label map, when its resume fails, then its id is reported", async () => {
    backend({ failing: ["spawn_terminal"] });
    const orphan: Workspace[] = [{ id: "ws-1", name: "terra", cwd: "/repo", terminals: [{ id: "pty-1", command: "claude", width: null, isSuspended: true }] }];
    const { sessions } = renderSessions(orphan);

    await act(() => sessions().resumeTerminals(["pty-1"]));

    expect(runtime().notifItems[0]?.message).toContain("spawn_terminal failed");
  });
});
