// @vitest-environment jsdom

import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { translateNow } from "../../i18n";
import { buildPaneMenu, type PaneMenuActions, type PaneMenuTarget } from "./paneMenu";
import { shellShortcutLabels } from "./shellShortcuts";
import { ShellVoiceOverlay, type ShellVoiceProps } from "./ShellVoiceOverlay";
import { useNotificationMute } from "./useNotificationMute";
import { shellPaletteCallbacks, type ShellPaletteProps } from "./shellPaletteCallbacks";
import { roleLabelsByTerminal, shellSurfaceTitle, worktreeBranchesByTerminal } from "./visualShellModel";
import type { Workspace } from "../../domain/workspace.model";

const target: PaneMenuTarget = {
  ptyId: "term-codex",
  command: "codex",
  workspaceId: "ws-api",
  label: "Codex",
  isDetached: false,
  hasWorktree: false,
};

function menuActions(overrides: Partial<PaneMenuActions> = {}): PaneMenuActions {
  return {
    onFocusedAgentAction: vi.fn(),
    onRestart: vi.fn(),
    onReattach: vi.fn(),
    onDetach: vi.fn(),
    onOpenInspector: vi.fn(),
    onOpenReview: vi.fn(),
    onRequestConfirm: vi.fn(),
    ...overrides,
  };
}

function menuItems(menuTarget: PaneMenuTarget, actions: PaneMenuActions) {
  return buildPaneMenu(menuTarget, actions, { translate: translateNow, shortcuts: shellShortcutLabels("mac") }).flat();
}

function menuItem(items: ReturnType<typeof menuItems>, id: string) {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`missing menu item ${id}`);
  return item;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("buildPaneMenu", () => {
  it("Given an attached agent in a workspace, when interrupt is selected, then the focused agent action runs for it", () => {
    const actions = menuActions();
    const items = menuItems(target, actions);

    menuItem(items, "interrupt").onSelect();

    expect(items.map((item) => item.id)).toEqual(["interrupt", "restart", "detach", "inspector", "copy-resume", "clear-history", "kill"]);
    expect(actions.onFocusedAgentAction).toHaveBeenCalledWith("interrupt", { workspaceId: "ws-api", terminalId: "term-codex", command: "codex" });
  });

  it("Given a detached agent with a worktree and a rename handler, when building the menu, then it offers reattach, review and rename", () => {
    const actions = menuActions({ onRenameAgent: vi.fn() });
    const items = menuItems({ ...target, isDetached: true, hasWorktree: true }, actions);

    menuItem(items, "reattach").onSelect();
    menuItem(items, "review").onSelect();
    menuItem(items, "rename").onSelect();

    expect(actions.onReattach).toHaveBeenCalledWith("term-codex");
    expect(actions.onOpenReview).toHaveBeenCalledWith("term-codex");
    expect(actions.onRenameAgent).toHaveBeenCalledWith("term-codex");
  });

  it("Given an agent outside any workspace, when building the menu, then the agent actions are disabled", () => {
    const items = menuItems({ ...target, workspaceId: null }, menuActions());

    expect(menuItem(items, "interrupt").isDisabled).toBe(true);
    expect(menuItem(items, "clear-history").isDisabled).toBe(true);
    expect(menuItem(items, "kill").isDisabled).toBe(true);
  });

  it("Given a pane menu, when kill is selected, then a stop-agent confirmation is requested", () => {
    const actions = menuActions();

    menuItem(menuItems(target, actions), "kill").onSelect();

    expect(actions.onRequestConfirm).toHaveBeenCalledWith(expect.objectContaining({
      kind: "stop-agent",
      commandId: "pane:kill:term-codex",
      resourceLabel: "Codex",
      workspaceId: "ws-api",
      terminalId: "term-codex",
      action: "stop",
    }));
  });
});

function voiceProps(overrides: Partial<ShellVoiceProps> = {}): ShellVoiceProps {
  return { isVoiceEnabled: true, onToggleVoice: vi.fn(), ...overrides };
}

const voiceTargets = {
  projects: [{ id: "ws-api", name: "Terra API", status: "working" as const, isSuspended: false, agents: [{ id: "term-codex", label: "codex", status: "working" as const, detail: "working" }] }],
  labels: {},
};

describe("ShellVoiceOverlay", () => {
  it("Given an idle capsule, when rendering, then nothing is shown", () => {
    const { container } = render(<ShellVoiceOverlay voice={voiceProps()} state="idle" focusedId={null} targets={voiceTargets} shortcut="⌘M" />);

    expect(container).toBeEmptyDOMElement();
  });

  it("Given a listening capsule with feedback and a target handler, when rendering, then the feedback and target picker show", () => {
    render(
      <ShellVoiceOverlay
        voice={voiceProps({ voiceFeedback: "Sent to codex", onVoiceTargetChange: vi.fn() })}
        state="listening"
        focusedId="term-codex"
        targets={voiceTargets}
        shortcut="⌘M"
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Sent to codex");
    expect(document.querySelector(".terra-voice-overlay")?.children).toHaveLength(2);
  });

  it("Given disabled voice without feedback, when rendering, then the footer asks to turn voice on", () => {
    render(<ShellVoiceOverlay voice={voiceProps({ isVoiceEnabled: false })} state="error" focusedId={null} targets={voiceTargets} shortcut="⌘M" />);

    expect(screen.getByText(translateNow("shell.voiceDisabled"))).toBeInTheDocument();
  });
});

describe("useNotificationMute", () => {
  it("Given unmuted notifications, when muting, then they stay muted until the hour passes", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useNotificationMute());

    act(() => result.current.toggleMute());
    expect(result.current.isMuted).toBe(true);

    act(() => vi.advanceTimersByTime(60 * 60 * 1000));
    expect(result.current.isMuted).toBe(false);
  });

  it("Given muted notifications, when toggling, then they unmute", () => {
    const { result } = renderHook(() => useNotificationMute());

    act(() => result.current.toggleMute());
    act(() => result.current.toggleMute());

    expect(result.current.isMuted).toBe(false);
  });
});

function paletteProps(overrides: Partial<ShellPaletteProps> = {}): ShellPaletteProps {
  return {
    groups: [{ id: "group-core", name: "Core", projectIds: ["ws-api"], parentGroupId: null, collapsed: false, suspended: false, layout: { mode: "auto" } }],
    activeId: "ws-api",
    detachedTerminalIds: ["term-detached"],
    onOpenSettings: vi.fn(),
    onCreateProject: vi.fn(),
    onCreateGroup: vi.fn(),
    onNewAgent: vi.fn(),
    onToggleVoice: vi.fn(),
    ...overrides,
  };
}

function paletteNavigation() {
  return { navigate: vi.fn(), focusTerminal: vi.fn(), toggleDock: vi.fn(), reopenLastClosedTab: vi.fn() };
}

describe("shellPaletteCallbacks", () => {
  it("Given the settings route, when navigating, then settings open instead of a surface", () => {
    const props = paletteProps();
    const navigation = paletteNavigation();

    shellPaletteCallbacks(props, navigation).onNavigate?.("settings");
    shellPaletteCallbacks(props, navigation).onNavigate?.("fleet");

    expect(props.onOpenSettings).toHaveBeenCalledTimes(1);
    expect(navigation.navigate).toHaveBeenCalledWith("fleet");
  });

  it("Given a group, when it is opened, then the Workbench shows its first project", () => {
    const navigation = paletteNavigation();

    shellPaletteCallbacks(paletteProps(), navigation).onOpenGroup?.("group-core");
    shellPaletteCallbacks(paletteProps(), navigation).onOpenGroup?.("group-missing");

    expect(navigation.navigate).toHaveBeenNthCalledWith(1, "workbench", "ws-api");
    expect(navigation.navigate).toHaveBeenNthCalledWith(2, "workbench", null);
  });

  it("Given no workspace for a new agent, when creating it, then it goes to the active workspace", () => {
    const props = paletteProps();

    shellPaletteCallbacks(props, paletteNavigation()).onCreateAgent?.(null, "codex");

    expect(props.onNewAgent).toHaveBeenCalledWith("ws-api", null, "codex");
  });

  it("Given a detached terminal and no voice handlers, when reattaching and starting voice, then the terminal focuses and voice toggles", () => {
    const props = paletteProps();
    const navigation = paletteNavigation();
    const callbacks = shellPaletteCallbacks(props, navigation);

    callbacks.onReattachTerminal?.();
    callbacks.onStartVoice?.();
    callbacks.onOpenTerminal?.("ws-api", "term-codex");

    expect(navigation.focusTerminal).toHaveBeenNthCalledWith(1, "term-detached");
    expect(navigation.focusTerminal).toHaveBeenNthCalledWith(2, "term-codex");
    expect(props.onToggleVoice).toHaveBeenCalled();
  });
});

describe("visual shell terminal maps", () => {
  const workspaces: Workspace[] = [{
    id: "ws-api",
    name: "Terra API",
    cwd: "/tmp/terra-api",
    terminals: [
      { id: "term-codex", command: "codex", width: 120, role: "reviewer", worktree: { path: "/tmp/wt", cwd: "/tmp/wt", branch: "terra/codex", base: "main", repo: "/tmp/terra-api" } },
      { id: "term-shell", command: "zsh", width: 120 },
    ],
  }];

  it("Given agents with and without worktrees or roles, when mapping them, then only the isolated or assigned agents appear", () => {
    expect(worktreeBranchesByTerminal(workspaces)).toEqual({ "term-codex": "terra/codex" });
    expect(roleLabelsByTerminal(workspaces, translateNow)).toEqual({ "term-codex": translateNow("roles.reviewer") });
  });

  it("Given each shell surface, when titling the window, then the surface name is used", () => {
    expect(shellSurfaceTitle("fleet", translateNow)).toBe(translateNow("common.fleet"));
    expect(shellSurfaceTitle("board", translateNow)).toBe(translateNow("common.board"));
    expect(shellSurfaceTitle("settings", translateNow)).toBe(translateNow("common.settings"));
    expect(shellSurfaceTitle("workbench", translateNow)).toBe(translateNow("common.appName"));
  });
});

describe("ShellVoiceOverlay interaction", () => {
  it("Given a listening capsule without a stop handler, when stopping, then voice toggles", async () => {
    const user = userEvent.setup();
    const voice = voiceProps();
    render(<ShellVoiceOverlay voice={voice} state="listening" focusedId={null} targets={voiceTargets} shortcut="⌘M" />);

    const buttons = screen.getAllByRole("button");
    await user.click(buttons[0] ?? document.body);

    expect(voice.onToggleVoice).toHaveBeenCalled();
  });
});
