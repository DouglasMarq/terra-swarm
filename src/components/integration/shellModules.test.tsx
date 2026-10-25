// @vitest-environment jsdom

import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceContainer, WorkspaceSnapshotV2 } from "../../domain/workspace.model";
import { useLocaleStore } from "../../i18n";
import type { CommandConfirmRequest } from "../overlays/CommandPalette";
import type { InspectorTarget } from "../inspector/inspectorModel";
import { ShellConfirmDialogs, type PendingInspectorAction } from "./ShellConfirmDialogs";
import { useShellShortcuts } from "./shellShortcuts";
import { useFullscreenExit } from "./useFullscreenExit";

function pressKey(init: KeyboardEventInit, target: EventTarget = window) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
}

function fullscreenContainer(id: string): WorkspaceContainer {
  return { id, projectId: null, paneIds: [], layout: { mode: "grid" }, visible: true, collapsed: false, closed: false, fullscreen: true };
}

function snapshotWithFullscreen(containerIds: readonly string[]): WorkspaceSnapshotV2 {
  return {
    version: 2,
    projects: [],
    groups: [],
    containers: containerIds.map(fullscreenContainer),
    panes: [],
    tabs: [],
    orphanedTabIds: [],
    activeProjectId: null,
    activeGroupId: null,
    activeContainerId: null,
    activePaneId: null,
    activeTabId: null,
    layout: { mode: "grid" },
  };
}

const inspectorTarget: InspectorTarget = {
  terminalId: "term-claude",
  displayName: "Claude",
  workspaceId: "ws-alpha",
  workspaceName: "Alpha",
  projectName: "Alpha",
  groupName: null,
  containerId: null,
  paneId: null,
  tabId: null,
  command: "claude",
  profileId: "claude",
  profileLabel: "Claude Code",
  cwd: "/work/alpha",
  state: "ativo",
  contextUsage: null,
  detached: false,
};

describe("useShellShortcuts", () => {
  function renderShortcuts(dockOpen: boolean) {
    const handlers = { toggleSidebar: vi.fn(), dockOpen, setDockOpen: vi.fn(), setCommandPaletteOpen: vi.fn() };
    renderHook(() => useShellShortcuts(handlers));
    return handlers;
  }

  it("Given the shell shortcuts, when ⌘B is pressed, then the sidebar toggles", () => {
    const handlers = renderShortcuts(false);

    pressKey({ key: "b", metaKey: true });

    expect(handlers.toggleSidebar).toHaveBeenCalledTimes(1);
  });

  it("Given an open dock, when Ctrl+I is pressed, then the dock closes", () => {
    const handlers = renderShortcuts(true);

    pressKey({ key: "i", ctrlKey: true });

    expect(handlers.setDockOpen).toHaveBeenCalledWith(false);
  });

  it("Given the shell shortcuts, when ⌘K is pressed, then the command palette opens", () => {
    const handlers = renderShortcuts(false);

    pressKey({ key: "k", metaKey: true });

    expect(handlers.setCommandPaletteOpen).toHaveBeenCalledWith(true);
    expect(handlers.toggleSidebar).not.toHaveBeenCalled();
  });
});

describe("useFullscreenExit", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("Given a fullscreen container, when Escape is pressed outside a terminal, then it leaves fullscreen", () => {
    const setContainerFullscreen = vi.fn();
    renderHook(() => useFullscreenExit({ snapshot: snapshotWithFullscreen(["container-a"]), dockOpen: false, setContainerFullscreen }));

    pressKey({ key: "Escape" }, document.body);

    expect(setContainerFullscreen).toHaveBeenCalledWith("container-a", false);
  });

  it("Given a fullscreen container, when Escape is pressed inside a terminal, then it stays fullscreen", () => {
    const setContainerFullscreen = vi.fn();
    const terminal = document.createElement("div");
    terminal.className = "xterm";
    document.body.append(terminal);
    renderHook(() => useFullscreenExit({ snapshot: snapshotWithFullscreen(["container-a"]), dockOpen: false, setContainerFullscreen }));

    pressKey({ key: "Escape" }, terminal);

    expect(setContainerFullscreen).not.toHaveBeenCalled();
  });

  it("Given a fullscreen container, when the dock opens, then it leaves fullscreen", () => {
    const setContainerFullscreen = vi.fn();
    const snapshot = snapshotWithFullscreen(["container-a"]);
    const { rerender } = renderHook(
      ({ dockOpen }) => useFullscreenExit({ snapshot, dockOpen, setContainerFullscreen }),
      { initialProps: { dockOpen: false } },
    );

    expect(setContainerFullscreen).not.toHaveBeenCalled();
    rerender({ dockOpen: true });

    expect(setContainerFullscreen).toHaveBeenCalledWith("container-a", false);
  });
});

describe("ShellConfirmDialogs", () => {
  beforeEach(() => {
    act(() => useLocaleStore.getState().setLocale("en"));
  });

  function renderDialogs(commandRequest: CommandConfirmRequest | null, inspectorRequest: PendingInspectorAction | null) {
    const callbacks = {
      onCommandRequestChange: vi.fn(),
      onInspectorRequestChange: vi.fn(),
      onImportWorkspace: vi.fn(),
      onFocusedAgentAction: vi.fn(),
      onKill: vi.fn(),
      onRestart: vi.fn(),
    };
    render(<ShellConfirmDialogs commandRequest={commandRequest} inspectorRequest={inspectorRequest} {...callbacks} />);
    return callbacks;
  }

  it("Given a pending stop-agent request, when confirmed, then the focused agent action runs and the request clears", async () => {
    const callbacks = renderDialogs({
      kind: "stop-agent",
      commandId: "pane:kill:term-claude",
      title: "End session?",
      description: "The process stops.",
      resourceId: "term-claude",
      resourceLabel: "claude",
      workspaceId: "ws-alpha",
      terminalId: "term-claude",
      action: "stop",
    }, null);

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "End session" })));

    expect(callbacks.onCommandRequestChange).toHaveBeenCalledWith(null);
    expect(callbacks.onFocusedAgentAction).toHaveBeenCalledWith("stop", { workspaceId: "ws-alpha", terminalId: "term-claude", command: "claude" });
  });

  it("Given a pending import request, when confirmed, then the import continues", async () => {
    const callbacks = renderDialogs({
      kind: "import-snapshot",
      commandId: "workspace:import",
      title: "Import",
      description: "Replaces the layout.",
      resourceId: "snapshot",
      resourceLabel: "snapshot.json",
    }, null);

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Continue import" })));

    expect(callbacks.onImportWorkspace).toHaveBeenCalledTimes(1);
    expect(callbacks.onFocusedAgentAction).not.toHaveBeenCalled();
  });

  it("Given a pending inspector kill, when confirmed, then the terminal is killed", async () => {
    const callbacks = renderDialogs(null, { action: "kill", target: inspectorTarget });

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "End session" })));

    expect(callbacks.onInspectorRequestChange).toHaveBeenCalledWith(null);
    expect(callbacks.onKill).toHaveBeenCalledWith("term-claude");
  });

  it("Given a pending inspector restart, when confirmed, then the terminal restarts with its command", async () => {
    const callbacks = renderDialogs(null, { action: "restart", target: inspectorTarget });

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Restart session" })));

    expect(callbacks.onRestart).toHaveBeenCalledWith("term-claude", "claude");
    expect(callbacks.onKill).not.toHaveBeenCalled();
  });
});
