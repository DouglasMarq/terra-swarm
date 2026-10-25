// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../domain/workspace.model";
import { DEFAULT_HOTKEYS, type Hotkey, type HotkeyActionId, usePreferencesStore } from "../stores/preferencesStore";
import { useTerminalRuntimeStore } from "../stores/terminalRuntimeStore";
import { useUiStore } from "../stores/uiStore";
import { useGlobalHotkeys } from "./useGlobalHotkeys";

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
  { id: "ws-beta", name: "Beta", cwd: "/work/beta", terminals: [] },
];

function metaKey(key: string): Hotkey {
  return { key, meta: true, shift: false, ctrl: false, alt: false };
}

const hotkeys: Record<HotkeyActionId, Hotkey> = {
  ...DEFAULT_HOTKEYS,
  selectWorkspace2: metaKey("2"),
  selectTerminal2: { ...metaKey("2"), shift: true },
  maximizeTerminal: metaKey("Enter"),
  newTerminal: metaKey("t"),
  renameWorkspace: metaKey("r"),
};

function actions() {
  return {
    openWorkspaceCreator: vi.fn(),
    renameWorkspace: vi.fn(),
    closeWorkspace: vi.fn(),
    quickNewTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    toggleVoice: vi.fn(),
  };
}

interface HotkeyHarness {
  modalOpen?: boolean;
  capturing?: HotkeyActionId | null;
  focusedId?: string | null;
}

function renderHotkeys(harness: HotkeyHarness = {}) {
  const handlers = actions();
  const setCapturing = vi.fn();
  renderHook(() =>
    useGlobalHotkeys({
      modalOpen: harness.modalOpen ?? false,
      capturing: harness.capturing ?? null,
      setCapturing,
      shortcutsSectionOpen: true,
      active: workspaces[0] ?? null,
      focusedId: harness.focusedId ?? null,
      workspaces,
      actions: handlers,
    }),
  );
  return { handlers, setCapturing };
}

function press(init: KeyboardEventInit, target: EventTarget = document.body) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
}

beforeEach(() => {
  usePreferencesStore.setState({ hotkeys });
  useUiStore.setState({ activeId: "ws-alpha", expandedId: null, focusedId: null });
  useTerminalRuntimeStore.setState({ notifItems: [] });
});

describe("useGlobalHotkeys", () => {
  it("Given two workspaces, when the second workspace shortcut is pressed, then it becomes active", () => {
    renderHotkeys();

    press({ key: "2", metaKey: true });

    expect(useUiStore.getState().activeId).toBe("ws-beta");
  });

  it("Given an active workspace with two agents, when the second agent shortcut is pressed, then that agent is focused", () => {
    renderHotkeys();

    press({ key: "2", metaKey: true, shiftKey: true });

    expect(useUiStore.getState().focusedId).toBe("term-two");
  });

  it("Given a focused agent, when maximize is pressed twice, then it expands and then restores", () => {
    renderHotkeys({ focusedId: "term-one" });

    press({ key: "Enter", metaKey: true });
    expect(useUiStore.getState().expandedId).toBe("term-one");

    press({ key: "Enter", metaKey: true });
    expect(useUiStore.getState().expandedId).toBeNull();
  });

  it("Given no focused agent, when maximize is pressed, then the last agent of the workspace expands", () => {
    renderHotkeys();

    press({ key: "Enter", metaKey: true });

    expect(useUiStore.getState().expandedId).toBe("term-two");
  });

  it("Given an active workspace, when the new-agent and rename shortcuts are pressed, then the actions run for it", () => {
    const { handlers } = renderHotkeys();

    press({ key: "t", metaKey: true });
    press({ key: "r", metaKey: true });

    expect(handlers.quickNewTerminal).toHaveBeenCalledWith("ws-alpha");
    expect(handlers.renameWorkspace).toHaveBeenCalledWith(workspaces[0]);
  });

  it("Given an open dialog, when a shortcut is pressed, then nothing happens", () => {
    const { handlers } = renderHotkeys({ modalOpen: true });

    press({ key: "t", metaKey: true });

    expect(handlers.quickNewTerminal).not.toHaveBeenCalled();
  });

  it("Given focus in a text input, when a shortcut is pressed, then nothing happens", () => {
    const { handlers } = renderHotkeys();
    const input = document.createElement("input");
    document.body.append(input);

    press({ key: "t", metaKey: true }, input);

    expect(handlers.quickNewTerminal).not.toHaveBeenCalled();
    input.remove();
  });

  it("Given a shortcut being recorded, when a free combo is pressed, then it is saved and recording ends", () => {
    const { setCapturing } = renderHotkeys({ capturing: "newWorkspace" });

    press({ key: "y", metaKey: true });

    expect(usePreferencesStore.getState().hotkeys.newWorkspace).toEqual(metaKey("y"));
    expect(setCapturing).toHaveBeenCalledWith(null);
  });

  it("Given a shortcut being recorded, when a combo bound to another action is pressed, then it is refused with a notice", () => {
    const { setCapturing } = renderHotkeys({ capturing: "newWorkspace" });

    press({ key: "t", metaKey: true });

    expect(usePreferencesStore.getState().hotkeys.newWorkspace).toEqual(DEFAULT_HOTKEYS.newWorkspace);
    expect(useTerminalRuntimeStore.getState().notifItems).toHaveLength(1);
    expect(setCapturing).toHaveBeenCalledWith(null);
  });

  it("Given a shortcut being recorded, when only a modifier or a plain key is pressed, then recording continues", () => {
    const { setCapturing } = renderHotkeys({ capturing: "newWorkspace" });

    press({ key: "Shift", shiftKey: true });
    press({ key: "y" });

    expect(setCapturing).not.toHaveBeenCalled();
  });

  it("Given a shortcut being recorded, when Escape is pressed, then recording ends without saving", () => {
    const { setCapturing } = renderHotkeys({ capturing: "newWorkspace" });

    press({ key: "Escape" });

    expect(usePreferencesStore.getState().hotkeys.newWorkspace).toEqual(DEFAULT_HOTKEYS.newWorkspace);
    expect(setCapturing).toHaveBeenCalledWith(null);
  });
});
