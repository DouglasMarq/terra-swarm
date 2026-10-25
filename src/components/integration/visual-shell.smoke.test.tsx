// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Group, Workspace } from "../../domain/workspace.model";
import { useShellStore, SHELL_STORAGE_KEY } from "../../stores/shellStore";
import { useOrchestrationStore } from "../../stores/orchestrationStore";
import { ptyApi } from "../../lib/tauri/pty";
import { useLocaleStore } from "../../i18n";
import { shellShortcutLabels, shouldOpenCommandPaletteShortcut } from "./shellShortcuts";
import { VisualShellSurface, type VisualShellSurfaceProps } from "./VisualShellSurface";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
}));

const workspace: Workspace = {
  id: "ws-api",
  name: "Terra API",
  cwd: "/tmp/terra-api",
  terminals: [{ id: "term-codex", command: "codex", width: 120 }],
};

const group: Group = {
  id: "group-core",
  name: "Core",
  projectIds: [workspace.id],
  parentGroupId: null,
  collapsed: false,
  suspended: false,
  layout: { mode: "auto", itemIds: [workspace.id] },
};

function shellProps(overrides: Partial<VisualShellSurfaceProps> = {}): VisualShellSurfaceProps {
  return {
    workspaces: [workspace],
    groups: [group],
    agents: [{ id: "codex", label: "Codex", available: true }],
    snapshot: null,
    activeId: workspace.id,
    focusedId: "term-codex",
    expandedId: null,
    exited: {},
    notifications: {},
    contextUsage: {},
    titles: {},
    branches: {},
    notificationItems: [],
    detachedTerminalIds: [],
    appVersion: "2.0.0",
    fontSize: 13,
    isVoiceEnabled: false,
    voiceStatus: "idle",
    onFocus: vi.fn(),
    onSelectWorkspace: vi.fn(),
    onNewWorkspace: vi.fn(),
    onNewAgent: vi.fn(),
    onClearNotifications: vi.fn(),
    onMarkAllRead: vi.fn(),
    onClearAll: vi.fn(),
    onJumpToNotification: vi.fn(),
    onRestart: vi.fn(),
    onKill: vi.fn(),
    onDetach: vi.fn(),
    onReattach: vi.fn(),
    onToggleExpand: vi.fn(),
    onHideWorkspace: vi.fn(),
    onCreateGroup: vi.fn(),
    onCreateProject: vi.fn(),
    onRenameNode: vi.fn(),
    onSuspendGroup: vi.fn(),
    onResumeGroup: vi.fn(),
    onBatchStop: vi.fn(),
    onBatchResume: vi.fn(),
    onOpenSettings: vi.fn(),
    onToggleVoice: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.removeItem(SHELL_STORAGE_KEY);
  useShellStore.getState().reset();
  useOrchestrationStore.getState().reset();
});

afterEach(() => {
  localStorage.removeItem(SHELL_STORAGE_KEY);
  useShellStore.getState().reset();
  useOrchestrationStore.getState().reset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("VisualShellSurface smoke flow", () => {
  it("Given the shell, when it opens, then it shows the Workbench, switches to the Fleet and forwards fleet focus", async () => {
    const user = userEvent.setup();
    const props = shellProps({ contextUsage: { "term-codex": 72 } });
    render(<VisualShellSurface {...props} />);

    expect(document.querySelector('[data-shell-surface="workbench"]')).toBeInTheDocument();
    expect(await screen.findByText("Nenhum workspace carregado")).toBeInTheDocument();
    expect(screen.getByText(/1 agente ativo · v2\.0\.0/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Bom dia" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Frota" }));
    expect(await screen.findByRole("heading", { name: "Frota" })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Abrir codex em Terra API" }));
    expect(props.onFocus).toHaveBeenCalledWith("term-codex");

    await user.click(screen.getByRole("button", { name: "Configurações" }));
    expect(props.onOpenSettings).toHaveBeenCalled();
  });

  it("Given agents that need the user, when the shell renders, then it counts them and lists them in the notification center", async () => {
    const user = userEvent.setup();
    const props = shellProps({
      notifications: { "term-codex": 1 },
      notificationItems: [{ key: 1, terminalId: "term-codex", workspaceId: workspace.id, message: "Posso rodar npm test?", ts: Date.now(), isRead: false }],
    });
    render(<VisualShellSurface {...props} />);

    await user.click(screen.getByRole("button", { name: "1 precisa de você" }));
    const center = screen.getByRole("dialog", { name: "Notificações" });
    expect(center).toHaveTextContent("Posso rodar npm test?");
    await user.click(screen.getByRole("button", { name: "Ir para o painel" }));
    expect(props.onJumpToNotification).toHaveBeenCalled();
  });

  it("Given a persisted route and focus, when the shell mounts under reduced motion, then they are restored", async () => {
    const media = vi.fn((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    }));
    vi.stubGlobal("matchMedia", media);
    window.matchMedia = media as typeof window.matchMedia;
    useShellStore.getState().navigate("workbench", workspace.id);
    useShellStore.getState().setPanelLayout({ navigator: 28, content: 72 });

    const props = shellProps();
    render(<VisualShellSurface {...props} />);

    await waitFor(() => {
      expect(document.querySelector('[data-shell-surface="workbench"]')).toBeInTheDocument();
    });
    expect(useShellStore.getState().activeWorkspaceId).toBe(workspace.id);
    expect(useShellStore.getState().panelLayout).toEqual({ navigator: 28, content: 72 });
    expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);

  });

  it("Given the sidebar, when pressing ⌘B, then it collapses into a rail", async () => {
    render(<VisualShellSurface {...shellProps()} />);
    fireEvent.keyDown(window, { key: "b", metaKey: true });
    await waitFor(() => expect(useShellStore.getState().sidebarCollapsed).toBe(true));
    expect(screen.getByRole("navigation", { name: "Barra lateral recolhida" })).toBeInTheDocument();
  });

  it("Given the collapsed rail, when the language changes, then the agent status follows it", async () => {
    render(<VisualShellSurface {...shellProps()} />);
    fireEvent.keyDown(window, { key: "b", metaKey: true });
    const portuguese = (await screen.findByRole("button", { name: /^codex, /i })).getAttribute("aria-label");

    try {
      act(() => useLocaleStore.getState().setLocale("en"));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /^codex, /i }).getAttribute("aria-label")).not.toBe(portuguese);
      });
    } finally {
      act(() => useLocaleStore.getState().setLocale("pt-BR"));
    }
  });

  it("Given a compact Inspector drawer, when it closes, then runtime polling stops", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }));
    const runtimeInfo = vi.spyOn(ptyApi, "terminalRuntimeInfo").mockResolvedValue({
      id: "term-codex",
      pid: 42,
      cols: 120,
      rows: 40,
      running: true,
      reaped: false,
      generation: 1,
    });

    render(<VisualShellSurface {...shellProps()} />);

    fireEvent.click(screen.getByRole("button", { name: "Mostrar inspetor (Ctrl+I)" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(runtimeInfo).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("complementary", { name: "Inspetor do agente" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Fechar inspetor (Ctrl+I)" }));
    expect(screen.queryByRole("complementary", { name: "Inspetor do agente" })).not.toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(1500);
    expect(runtimeInfo).toHaveBeenCalledTimes(1);
  });

  it("Given a focused dialog, when pressing Ctrl+K, then it does not escape into the global palette", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const input = document.createElement("input");
    dialog.appendChild(input);
    document.body.appendChild(dialog);
    input.focus();

    const event = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true });
    Object.defineProperty(event, "target", { configurable: true, value: input });
    expect(shouldOpenCommandPaletteShortcut(event)).toBe(false);
    expect(shouldOpenCommandPaletteShortcut(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }))).toBe(true);
  });

});

describe("shellShortcutLabels", () => {
  it("Given macOS, when writing the shell shortcuts, then they use the Mac glyphs", () => {
    expect(shellShortcutLabels("mac")).toEqual({ interrupt: "⌃C", inspector: "⌘I", sidebar: "⌘B" });
  });

  it("Given Windows or Linux, when writing the shell shortcuts, then they use Ctrl", () => {
    expect(shellShortcutLabels("other")).toEqual({ interrupt: "Ctrl+C", inspector: "Ctrl+I", sidebar: "Ctrl+B" });
  });
});
