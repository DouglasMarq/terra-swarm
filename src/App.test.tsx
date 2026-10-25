// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VisualShellSurfaceProps } from "./components/integration/VisualShellSurface";
import type { RunningTerminal } from "./domain/terminal.model";
import type { Workspace, WorkspaceGroup } from "./domain/workspace.model";

const tauri = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
  invoke: vi.fn(),
  shell: { props: null as VisualShellSurfaceProps | null },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    tauri.handlers.set(name, handler);
    return () => undefined;
  },
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "1.0.0" }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: async () => null }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: async () => undefined }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null, save: async () => null }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: async () => undefined }) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => undefined }) }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: async () => true,
  requestPermission: async () => "granted",
  sendNotification: () => undefined,
}));
vi.mock("./components/integration/VisualShellSurface", () => ({
  VisualShellSurface: (props: VisualShellSurfaceProps) => {
    tauri.shell.props = props;
    return <div data-testid="shell-surface" />;
  },
}));

import App from "./App";
import { translateNow } from "./i18n";
import { usePreferencesStore } from "./stores/preferencesStore";
import { useOrchestrationStore } from "./stores/orchestrationStore";
import { useShellStore } from "./stores/shellStore";
import { useTerminalRuntimeStore } from "./stores/terminalRuntimeStore";
import { useUiStore } from "./stores/uiStore";
import { defined } from "./test/defined";

const baseWorkspaces: Workspace[] = [
  {
    id: "ws-1",
    name: "terra",
    cwd: "/repo",
    terminals: [
      { id: "pty-1", command: "claude", width: null },
      { id: "pty-2", command: "codex", width: null },
    ],
  },
  { id: "ws-2", name: "swarm", cwd: "/swarm", terminals: [] },
];

type Backend = {
  workspaces: Workspace[];
  groups: WorkspaceGroup[];
  running: RunningTerminal[];
  failing: Record<string, unknown>;
};

let backend: Backend;

function answer(command: string): unknown {
  if (command in backend.failing) throw backend.failing[command];
  switch (command) {
    case "create_workspace":
      backend.workspaces = baseWorkspaces;
      return baseWorkspaces[0];
    case "create_group":
      return { id: "g-new", name: "Reviewers", projectIds: [], parentGroupId: null, isCollapsed: false, isSuspended: false };
    case "list_workspaces":
      return backend.workspaces;
    case "list_groups":
      return backend.groups;
    case "running_terminals":
      return backend.running;
    case "detect_agents":
      return [{ id: "claude", label: "Claude", isAvailable: true }];
    case "voice_list_models":
    case "voice_list_input_devices":
    case "list_available_shells":
      return [];
    case "git_branch":
      return "main";
    case "spawn_terminal":
      return { meta: { id: "pty-new", command: "claude", width: null }, seq: 1 };
    default:
      return undefined;
  }
}

const shell = () => defined(tauri.shell.props);
const sent = (command: string) => tauri.invoke.mock.calls.filter(([name]) => name === command).map(([, payload]) => payload);
const notices = () => useTerminalRuntimeStore.getState().notifItems.map((item) => item.message);

const agentsGroup: WorkspaceGroup = { id: "g-1", name: "Agents", projectIds: ["ws-1"], parentGroupId: null, isCollapsed: false, isSuspended: false };

async function submitName(value: string) {
  const input = await screen.findByLabelText(translateNow("rename.name"));
  fireEvent.change(input, { target: { value } });
  fireEvent.submit(defined(input.closest("form")));
}

async function renderApp() {
  render(<App />);
  await screen.findByTestId("shell-surface");
  await vi.waitFor(() => expect(sent("detect_agents")).toHaveLength(1));
  await vi.waitFor(() => expect(shell().workspaces).toHaveLength(backend.workspaces.length));
}

describe("App", () => {
  let consoleSpies: ReturnType<typeof vi.spyOn>[];

  beforeEach(() => {
    backend = {
      workspaces: baseWorkspaces,
      groups: [],
      running: [{ id: "pty-1", seq: 1 }, { id: "pty-2", seq: 1 }],
      failing: {},
    };
    tauri.handlers.clear();
    tauri.shell.props = null;
    tauri.invoke.mockReset().mockImplementation(async (command: string) => answer(command));
    consoleSpies = [
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
    ];
    useUiStore.setState({ activeId: null, focusedId: null, expandedId: null });
    usePreferencesStore.setState({ shouldAutoResume: false, isVoiceEnabled: false, agentNames: {} });
  });

  afterEach(() => {
    for (const spy of consoleSpies) spy.mockRestore();
    useTerminalRuntimeStore.getState().reset();
    useOrchestrationStore.getState().reset();
    localStorage.clear();
  });

  it("Given a backend with workspaces, when the app starts, then the shell shows them and the first one is active", async () => {
    await renderApp();

    expect(shell().workspaces.map((workspace) => workspace.id)).toEqual(["ws-1", "ws-2"]);
    expect(useUiStore.getState().activeId).toBe("ws-1");
    expect(sent("set_durable_scrollback_enabled")).toEqual([{ isEnabled: false }]);
  });

  it("Given a backend without workspaces, when the app starts, then a default workspace is created", async () => {
    backend.workspaces = [];

    await renderApp();

    expect(sent("create_workspace")).toEqual([{ request: { name: "default", cwd: "" } }]);
  });

  it("Given terminals that are no longer running, when the app starts, then they are offered for resume", async () => {
    backend.running = [];

    await renderApp();

    await vi.waitFor(() => expect(shell().resumeCount).toBe(2));
    expect(useTerminalRuntimeStore.getState().exited).toMatchObject({ "pty-1": null, "pty-2": null });
  });

  it("Given the backend fails at startup, when retrying after it recovers, then the error goes away", async () => {
    backend.failing = { list_workspaces: new Error("store locked") };
    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent("store locked");

    backend.failing = {};
    fireEvent.click(screen.getByRole("button", { name: translateNow("nav.retry") }));

    await vi.waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("Given a persistence failure, when it is reported, then the user is told and the error is cleared", async () => {
    await renderApp();

    act(() => useOrchestrationStore.setState({ persistenceError: { operation: "layout", message: "disk full", at: 1 } }));

    expect(notices()).toContain(translateNow("app.saveFailed", { what: "layout", detail: "disk full" }));
    expect(useOrchestrationStore.getState().persistenceError).toBeNull();
  });

  it("Given reduced motion, when it is switched on, then the document is marked", async () => {
    await renderApp();

    act(() => usePreferencesStore.getState().setReduceMotion(true));

    expect(document.documentElement.classList.contains("reduce-motion")).toBe(true);
    act(() => usePreferencesStore.getState().setReduceMotion(false));
  });

  it("Given a notification for a live terminal, when jumping to it, then that terminal is focused and its notices are read", async () => {
    await renderApp();
    act(() => useTerminalRuntimeStore.getState().addNotification({ id: "pty-2", workspace_id: "ws-1", count: 1, messages: ["done"] }));

    act(() => shell().onJumpToNotification(useTerminalRuntimeStore.getState().notifItems[0]));

    expect(useUiStore.getState().focusedId).toBe("pty-2");
    expect(useTerminalRuntimeStore.getState().notifItems[0].isRead).toBe(true);
  });

  it("Given a notification for a terminal that is gone, when jumping to it, then only its notices are read", async () => {
    await renderApp();
    act(() => useTerminalRuntimeStore.getState().addNotification({ id: "pty-9", workspace_id: "ws-1", count: 1, messages: ["old"] }));

    act(() => shell().onJumpToNotification(useTerminalRuntimeStore.getState().notifItems[0]));

    expect(useUiStore.getState().focusedId).not.toBe("pty-9");
    expect(useTerminalRuntimeStore.getState().notifItems[0].isRead).toBe(true);
  });

  it("Given an agent, when renaming it through the dialog, then its name is stored", async () => {
    await renderApp();

    act(() => shell().onRenameAgent?.("pty-1"));
    await submitName("  Vega ");

    await vi.waitFor(() => expect(usePreferencesStore.getState().agentNames["pty-1"]).toBe("Vega"));
  });

  it("Given a project, when renaming it through the dialog, then the backend renames it", async () => {
    await renderApp();

    act(() => shell().onRenameNode({ kind: "project", id: "ws-1" }));
    expect(await screen.findByLabelText(translateNow("rename.name"))).toHaveValue("terra");
    await submitName("terra-2");

    await vi.waitFor(() => expect(sent("rename_workspace")).toEqual([{ request: { id: "ws-1", name: "terra-2" } }]));
  });

  it("Given a rename the backend rejects, when submitting it, then the user is told", async () => {
    backend.failing = { rename_workspace: "name taken" };
    await renderApp();

    act(() => shell().onRenameNode({ kind: "project", id: "ws-2" }));
    await submitName("other");

    await vi.waitFor(() => expect(notices()).toContain(translateNow("app.renameFailed", { detail: "name taken" })));
  });

  it("Given a group, when renaming it and creating another through the dialogs, then the backend receives both", async () => {
    backend.groups = [agentsGroup];
    await renderApp();

    act(() => shell().onRenameNode({ kind: "group", id: "g-1" }));
    expect(await screen.findByLabelText(translateNow("rename.name"))).toHaveValue("Agents");
    await submitName("Bots");
    await vi.waitFor(() => expect(sent("rename_group")).toEqual([{ request: { id: "g-1", name: "Bots" } }]));

    act(() => shell().onCreateGroup());
    await submitName("  Reviewers ");
    await vi.waitFor(() => expect(sent("create_group")).toEqual([{ name: "Reviewers" }]));
  });

  it("Given a project, when confirming its deletion, then it is closed and focus inside it is dropped", async () => {
    await renderApp();
    act(() => useUiStore.setState({ focusedId: "pty-1", expandedId: "pty-1" }));

    act(() => shell().onDeleteWorkspace?.("ws-1"));
    fireEvent.click(await screen.findByRole("button", { name: translateNow("app.deleteConfirm") }));

    await vi.waitFor(() => expect(sent("close_workspace")).toEqual([{ id: "ws-1" }]));
    await vi.waitFor(() => expect(useUiStore.getState()).toMatchObject({ focusedId: null, expandedId: null }));
  });

  it("Given a deletion the backend rejects, when confirming it, then the user is told", async () => {
    backend.failing = { close_workspace: "in use" };
    await renderApp();

    act(() => shell().onDeleteWorkspace?.("ws-2"));
    fireEvent.click(await screen.findByRole("button", { name: translateNow("app.deleteConfirm") }));

    await vi.waitFor(() => expect(notices()).toContain(translateNow("app.deleteFailed", { detail: "in use" })));
  });

  it("Given an unknown project, when asking to delete it, then no confirmation opens", async () => {
    await renderApp();

    act(() => shell().onDeleteWorkspace?.("ws-ghost"));

    expect(screen.queryByRole("button", { name: translateNow("app.deleteConfirm") })).toBeNull();
  });

  it("Given fleet terminals, when stopping them in batch, then each is stopped, and a failure is reported", async () => {
    await renderApp();

    act(() => shell().onBatchStop(["pty-1", "pty-2"]));
    await vi.waitFor(() => expect(sent("stop_terminal")).toEqual([{ id: "pty-1" }, { id: "pty-2" }]));

    backend.failing = { stop_terminal: new Error("gone") };
    act(() => shell().onBatchStop(["pty-1"]));
    await vi.waitFor(() => expect(notices()).toContain(translateNow("app.stopSomeFailed")));
  });

  it("Given the focused terminal, when detaching and reattaching it, then focus leaves and returns", async () => {
    await renderApp();
    act(() => useUiStore.setState({ focusedId: "pty-1", expandedId: "pty-1" }));

    act(() => shell().onDetach("pty-1"));
    expect(useOrchestrationStore.getState().detachedTerminalIds).toContain("pty-1");
    expect(useUiStore.getState()).toMatchObject({ focusedId: null, expandedId: null });

    act(() => shell().onReattach("pty-1"));
    expect(useOrchestrationStore.getState().detachedTerminalIds).not.toContain("pty-1");
    expect(useUiStore.getState().focusedId).toBe("pty-1");
  });

  it("Given a focused agent, when running each palette action, then the matching backend calls are made", async () => {
    await renderApp();
    const context = { workspaceId: "ws-1", terminalId: "pty-1", command: "claude" };

    act(() => shell().onFocusedAgentAction?.("interrupt", context));
    await vi.waitFor(() => expect(sent("write_terminal")).toEqual([{ id: "pty-1", data: "\u0003" }]));

    act(() => shell().onFocusedAgentAction?.("clear-scrollback", context));
    expect(notices()).toContain(translateNow("app.historyCleared"));

    act(() => shell().onFocusedAgentAction?.("restart", context));
    await vi.waitFor(() => expect(sent("stop_terminal")).toEqual([{ id: "pty-1" }]));
    await vi.waitFor(() => expect(sent("spawn_terminal")).toHaveLength(1));

    act(() => shell().onFocusedAgentAction?.("resume", context));
    await vi.waitFor(() => expect(sent("spawn_terminal")).toHaveLength(2));

    act(() => shell().onFocusedAgentAction?.("stop", context));
    await vi.waitFor(() => expect(sent("kill_terminal")).toEqual([{ id: "pty-1" }]));
  });

  it("Given a palette action for an unknown terminal, when run, then nothing is sent", async () => {
    await renderApp();

    act(() => shell().onFocusedAgentAction?.("interrupt", { workspaceId: "ws-1", terminalId: "pty-ghost", command: "claude" }));

    expect(sent("write_terminal")).toEqual([]);
  });

  it("Given a pane, when starting a specific agent, then it is spawned, and a spawn failure is reported", async () => {
    await renderApp();

    act(() => shell().onNewAgent("ws-1", "pane-ws-1-1", "claude"));
    await vi.waitFor(() => expect(sent("spawn_terminal")).toHaveLength(1));

    backend.failing = { spawn_terminal: "no pty" };
    act(() => shell().onNewAgent("ws-1", null, "claude"));
    await vi.waitFor(() => expect(notices()).toContain(translateNow("app.spawnFailed", { detail: "no pty" })));
  });

  it("Given exited terminals, when resuming them in batch, then each is respawned", async () => {
    backend.running = [];
    await renderApp();

    act(() => shell().onBatchResume(["pty-1"]));

    await vi.waitFor(() => expect(sent("spawn_terminal")).toHaveLength(1));
  });

  it("Given a group, when suspending and resuming it from the shell, then the backend is told", async () => {
    backend.groups = [agentsGroup];
    await renderApp();

    act(() => shell().onSuspendGroup("g-1"));
    await vi.waitFor(() => expect(sent("suspend_group")).toEqual([{ id: "g-1" }]));

    act(() => shell().onResumeGroup("g-1"));
    await vi.waitFor(() => expect(sent("resume_group")).toEqual([{ id: "g-1" }]));
  });

  it("Given the shell, when opening settings, then the settings page is rendered and can be closed", async () => {
    await renderApp();

    act(() => shell().onOpenSettings());

    expect(useShellStore.getState().activeSurface).toBe("settings");
    await vi.waitFor(() => expect(shell().settingsPage).toBeTruthy());
    act(() => useShellStore.getState().navigate("workbench"));
    await vi.waitFor(() => expect(shell().settingsPage).toBeNull());
  });

  it("Given voice settings requested, when opened from the shell, then the settings surface shows", async () => {
    await renderApp();

    act(() => shell().onOpenVoiceSettings?.());

    expect(useShellStore.getState().activeSurface).toBe("settings");
    act(() => useShellStore.getState().navigate("workbench"));
  });
});
