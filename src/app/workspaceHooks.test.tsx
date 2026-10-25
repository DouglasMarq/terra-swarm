// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../domain/workspace.model";

const api = vi.hoisted(() => ({
  createWorkspace: vi.fn(),
  setWorkspaceGroup: vi.fn(),
  setTerminalWidth: vi.fn(),
}));
const openDialog = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ api }));
vi.mock("../lib/tauri/system", () => ({ openDialog }));

import { usePreferencesStore } from "../stores/preferencesStore";
import { useTerminalRuntimeStore } from "../stores/terminalRuntimeStore";
import { useUiStore } from "../stores/uiStore";
import { useAgentPicker } from "./useAgentPicker";
import { useGridLayout } from "./useGridLayout";
import { useWorkspaceCreator } from "./useWorkspaceCreator";

const workspaces: Workspace[] = [
  {
    id: "ws-alpha",
    name: "Alpha",
    cwd: "/work/alpha",
    terminals: [
      { id: "term-one", command: "claude", width: null },
      { id: "term-two", command: "zsh", width: null },
    ],
  },
];

function fakeCatalog(available: readonly string[]) {
  return {
    whenReady: vi.fn(async () => undefined),
    isAvailable: (agentId: string) => available.includes(agentId),
  };
}

function fakeSessions() {
  return {
    spawnInto: vi.fn(async () => undefined),
    reportSpawnError: vi.fn(),
  };
}

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  openDialog.mockReset();
  useTerminalRuntimeStore.getState().reset();
  useUiStore.setState({ activeId: null, expandedId: "term-one" });
  usePreferencesStore.setState({ defaultAgent: null, gridCols: 2 });
});

describe("useWorkspaceCreator", () => {
  it("Given an empty name, when a folder is picked, then the folder name fills the name", async () => {
    openDialog.mockResolvedValue("/work/terra");
    const { result } = renderHook(() => useWorkspaceCreator(async () => undefined));

    await act(() => result.current.pickFolder());

    expect(result.current.cwd).toBe("/work/terra");
    expect(result.current.name).toBe("terra");
  });

  it("Given a typed name, when a folder is picked, then the name is kept", async () => {
    openDialog.mockResolvedValue("/work/terra");
    const { result } = renderHook(() => useWorkspaceCreator(async () => undefined));

    act(() => result.current.setName("Mine"));
    await act(() => result.current.pickFolder());

    expect(result.current.name).toBe("Mine");
  });

  it("Given a cancelled folder dialog, when picking, then nothing changes", async () => {
    openDialog.mockResolvedValue(null);
    const { result } = renderHook(() => useWorkspaceCreator(async () => undefined));

    await act(() => result.current.pickFolder());

    expect(result.current.cwd).toBe("");
  });

  it("Given a creator opened for a group, when created, then the project joins the group, the form resets and it becomes active", async () => {
    api.createWorkspace.mockResolvedValue({ id: "ws-new" });
    api.setWorkspaceGroup.mockResolvedValue(undefined);
    const refresh = vi.fn(async () => undefined);
    const { result } = renderHook(() => useWorkspaceCreator(refresh));

    act(() => result.current.openCreator("group-front"));
    act(() => result.current.setName("  Gamma  "));
    act(() => result.current.setCwd("/work/gamma"));
    await act(() => result.current.create());

    expect(api.createWorkspace).toHaveBeenCalledWith("Gamma", "/work/gamma");
    expect(api.setWorkspaceGroup).toHaveBeenCalledWith("ws-new", "group-front");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().activeId).toBe("ws-new");
    expect(result.current.open).toBe(false);
    expect(result.current.groupId).toBeNull();
    expect(result.current.name).toBe("");
  });

  it("Given the backend refuses the project, when created, then the user is notified and the form stays open", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    api.createWorkspace.mockRejectedValue(new Error("disk full"));
    const { result } = renderHook(() => useWorkspaceCreator(async () => undefined));

    act(() => result.current.openCreator());
    await act(() => result.current.create());

    expect(api.setWorkspaceGroup).not.toHaveBeenCalled();
    expect(result.current.open).toBe(true);
    expect(useTerminalRuntimeStore.getState().notifItems).toHaveLength(1);
    consoleError.mockRestore();
  });
});

describe("useAgentPicker", () => {
  it("Given an available default agent, when a quick terminal is requested, then it spawns without opening the picker", async () => {
    usePreferencesStore.setState({ defaultAgent: "claude" });
    const sessions = fakeSessions();
    const { result } = renderHook(() => useAgentPicker(fakeCatalog(["claude"]), sessions));

    await act(() => result.current.quickNewTerminal("ws-alpha", "pane-1"));

    expect(sessions.spawnInto).toHaveBeenCalledWith("ws-alpha", "claude", { placement: { paneId: "pane-1" } });
    expect(result.current.open).toBe(false);
    expect(useUiStore.getState().activeId).toBe("ws-alpha");
    expect(useUiStore.getState().expandedId).toBeNull();
  });

  it("Given no usable default agent, when a quick terminal is requested, then the picker opens for that project", async () => {
    usePreferencesStore.setState({ defaultAgent: "gemini" });
    const sessions = fakeSessions();
    const { result } = renderHook(() => useAgentPicker(fakeCatalog(["claude"]), sessions));

    await act(() => result.current.quickNewTerminal("ws-alpha"));

    expect(sessions.spawnInto).not.toHaveBeenCalled();
    expect(result.current.open).toBe(true);
    expect(result.current.target).toBe("ws-alpha");
    expect(result.current.saveDefault).toBe(false);
  });

  it("Given the panel chooser with isolation and a role, when an agent is chosen, then it becomes the default and spawns with those options", async () => {
    const sessions = fakeSessions();
    const { result } = renderHook(() => useAgentPicker(fakeCatalog(["claude"]), sessions));

    await act(() => result.current.chooseForPanel("ws-alpha", "pane-2"));
    act(() => result.current.setIsolate(true));
    act(() => result.current.setRole("executor"));
    await act(() => result.current.choose("codex"));

    expect(usePreferencesStore.getState().defaultAgent).toBe("codex");
    expect(sessions.spawnInto).toHaveBeenCalledWith("ws-alpha", "codex", { placement: { paneId: "pane-2" }, worktree: true, role: "executor" });
    expect(result.current.open).toBe(false);
    expect(result.current.target).toBeNull();
    expect(result.current.isolate).toBe(false);
    expect(result.current.role).toBeNull();
  });

  it("Given an open picker, when it is dismissed, then the choice resets and nothing spawns", async () => {
    const sessions = fakeSessions();
    const { result } = renderHook(() => useAgentPicker(fakeCatalog([]), sessions));

    await act(() => result.current.chooseForPanel("ws-alpha"));
    act(() => result.current.setOpen(false));

    expect(result.current.target).toBeNull();
    expect(result.current.saveDefault).toBe(false);
    await act(() => result.current.choose("claude"));
    expect(sessions.spawnInto).not.toHaveBeenCalled();
  });
});

describe("useGridLayout", () => {
  it("Given a supported column count, when applied, then every terminal gets the even width and the layout is saved", async () => {
    api.setTerminalWidth.mockResolvedValue(undefined);
    const setWorkspaces = vi.fn();
    const refresh = vi.fn(async () => undefined);
    const { result } = renderHook(() => useGridLayout({ workspaces, setWorkspaces, refresh }));

    await act(() => result.current(3));

    expect(usePreferencesStore.getState().gridCols).toBe(3);
    expect(api.setTerminalWidth).toHaveBeenCalledWith("ws-alpha", "term-one", 33);
    expect(api.setTerminalWidth).toHaveBeenCalledWith("ws-alpha", "term-two", 33);
    const update = setWorkspaces.mock.calls[0][0];
    expect(update(workspaces)[0].terminals.map((terminal: { width: number | null }) => terminal.width)).toEqual([33, 33]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("Given an unsupported column count, when applied, then nothing changes", async () => {
    const setWorkspaces = vi.fn();
    const { result } = renderHook(() => useGridLayout({ workspaces, setWorkspaces, refresh: vi.fn(async () => undefined) }));

    await act(() => result.current(1));

    expect(usePreferencesStore.getState().gridCols).toBe(2);
    expect(setWorkspaces).not.toHaveBeenCalled();
    expect(api.setTerminalWidth).not.toHaveBeenCalled();
  });
});
