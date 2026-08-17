// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Group, Workspace } from "../../types";
import { useShellStore, SHELL_STORAGE_KEY } from "../../stores/shellStore";
import { useOrchestrationStore } from "../../stores/orchestrationStore";
import { ptyApi } from "../../lib/tauri/pty";
import {
  shouldOpenCommandPaletteShortcut,
  VisualShellSurface,
  type VisualShellSurfaceProps,
} from "./VisualShellSurface";

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
    voiceEnabled: false,
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
    onAssignGroup: vi.fn(),
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
  it("walks Home → Workbench → Fleet → Settings and forwards fleet focus", async () => {
    const user = userEvent.setup();
    const props = shellProps({ contextUsage: { "term-codex": 72 } });
    render(<VisualShellSurface {...props} />);

    expect(screen.getByRole("heading", { name: "Bom dia" })).toBeInTheDocument();
    expect(screen.getByText("v2.0.0")).toHaveAttribute("title", "Versão do aplicativo");
    const telemetry = document.querySelector<HTMLElement>(".terra-shell-telemetry");
    expect(document.querySelectorAll(".terra-shell-telemetry")).toHaveLength(1);
    expect(Array.from(telemetry?.children ?? [], (item) => item.textContent?.trim())).toEqual([
      "v2.0.0",
      "contexto 72%",
      "sincronizando",
    ]);

    await user.click(screen.getByRole("button", { name: "Workbench" }));
    expect(document.querySelector('[data-shell-surface="workbench"]')).toBeInTheDocument();
    expect(await screen.findByText("Nenhum workspace carregado")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Frota" }));
    expect(await screen.findByRole("heading", { name: "Fleet command center" })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Focus Codex in Terra API" }));
    expect(props.onFocus).toHaveBeenCalledWith("term-codex");

    await user.click(screen.getByRole("button", { name: "Configurações" }));
    expect(screen.getByRole("heading", { name: "Configurações" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Abrir configurações" }));
    expect(props.onOpenSettings).toHaveBeenCalled();
  });

  it("shows synced telemetry after the orchestration store hydrates", () => {
    useOrchestrationStore.getState().sync([workspace]);
    render(<VisualShellSurface {...shellProps({ contextUsage: { "term-codex": 72 } })} />);

    const telemetry = document.querySelector<HTMLElement>(".terra-shell-telemetry");
    expect(document.querySelectorAll(".terra-shell-telemetry")).toHaveLength(1);
    expect(Array.from(telemetry?.children ?? [], (item) => item.textContent?.trim())).toEqual([
      "v2.0.0",
      "contexto 72%",
      "sincronizado",
    ]);
  });

  it("restores the persisted route/focus shell under reduced motion", async () => {
    const user = userEvent.setup();
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

    await user.click(screen.getByRole("button", { name: "Início" }));
    expect(screen.getByRole("heading", { name: "Bom dia" })).toBeInTheDocument();
  });

  it("keeps a workspace closed after the topbar close action", async () => {
    const user = userEvent.setup();
    const onHideWorkspace = vi.fn();
    render(<VisualShellSurface {...shellProps({ onHideWorkspace })} />);

    const closeButton = await screen.findByRole("button", {
      name: "Fechar workspace Terra API",
    });
    await user.click(closeButton);

    expect(onHideWorkspace).toHaveBeenCalledWith(workspace.id);
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Fechar workspace Terra API" }),
      ).not.toBeInTheDocument();
    });
    expect(useShellStore.getState().workspaceTabs).toEqual([]);
    expect(useShellStore.getState().recentlyClosedTabs[0]?.workspaceId).toBe(workspace.id);
  });

  it("stops compact Inspector runtime polling when its drawer closes", async () => {
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
    const dockButton = screen.getByRole("button", { name: "Inspetor" });

    fireEvent.click(dockButton);
    await vi.advanceTimersByTimeAsync(0);
    expect(runtimeInfo).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Inspetor" })).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(dockButton);
    expect(screen.queryByRole("complementary", { name: "Painel contextual" })).not.toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(1500);
    expect(runtimeInfo).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Inspetor" })).toHaveAttribute("aria-expanded", "false");
  });

  it("does not let Ctrl+K escape a focused dialog into the global palette", () => {
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

  it("disables launching an agent when Home has no workspace target", () => {
    const props = shellProps({ workspaces: [], activeId: null, focusedId: null });
    render(<VisualShellSurface {...props} />);

    expect(screen.getByRole("button", { name: /Lançar agente/ })).toBeDisabled();
    expect(props.onNewAgent).not.toHaveBeenCalled();
  });
});
