// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { detectShortcutPlatform } from "../../lib/platform/shortcuts";
import { ApplicationShell } from "./ApplicationShell";
import { CollapsedSidebar, Sidebar, SurfaceSwitch } from "./Sidebar";
import { WindowChrome } from "./WindowChrome";
import shellStyles from "./shell.css?raw";

describe("ApplicationShell", () => {
  it("reserves the native traffic-light area on macOS", () => {
    render(
      <ApplicationShell sidebar={<div>Sidebar</div>}>
        <div>Content</div>
      </ApplicationShell>,
    );

    expect(document.querySelector(".terra-shell")).toHaveAttribute("data-platform", detectShortcutPlatform());
    expect(shellStyles).toMatch(
      /\.terra-shell\[data-platform="mac"\]\s+\.terra-window-chrome\s*\{[^}]*padding-left:\s*80px/,
    );
  });

  it("renders the sidebar, content and the inspector when it is open", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <ApplicationShell
        sidebar={<div>Sidebar slot</div>}
        rightDock={{ open: true, onClose, content: <p>Inspector content</p> }}
      >
        <div>Content slot</div>
      </ApplicationShell>,
    );

    expect(screen.getByText("Sidebar slot")).toBeInTheDocument();
    expect(screen.getByText("Content slot")).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Inspetor do agente" })).toHaveTextContent("Inspector content");
    expect(screen.queryByRole("tablist")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Fechar inspetor" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("swaps the sidebar for the rail when collapsed", () => {
    render(
      <ApplicationShell sidebar={<div>Full sidebar</div>} collapsedSidebar={<div>Rail</div>} sidebarCollapsed>
        <div>Content</div>
      </ApplicationShell>,
    );
    expect(screen.queryByText("Full sidebar")).toBeNull();
    expect(screen.getByText("Rail")).toBeInTheDocument();
    expect(document.querySelector(".terra-shell")).toHaveAttribute("data-sidebar", "collapsed");
  });

  it("renders floating overlays inside the body", () => {
    render(
      <ApplicationShell sidebar={<div />} overlay={<div>Voice capsule</div>}>
        <div>Content</div>
      </ApplicationShell>,
    );
    expect(screen.getByText("Voice capsule").closest(".terra-shell-body")).toBeInTheDocument();
  });
});

describe("WindowChrome", () => {
  it("shows where you are, search, attention, voice and inspector", async () => {
    const user = userEvent.setup();
    const onOpenLauncher = vi.fn();
    const onToggleVoice = vi.fn();
    const onToggleInspector = vi.fn();
    const onToggleSidebar = vi.fn();
    const onNotificationsOpenChange = vi.fn();
    render(
      <WindowChrome
        breadcrumb={{ project: "terra-swarm", agent: "Refatorar planejador", branch: "main" }}
        attentionCount={2}
        onOpenLauncher={onOpenLauncher}
        onToggleVoice={onToggleVoice}
        onToggleInspector={onToggleInspector}
        onToggleSidebar={onToggleSidebar}
        sidebarShortcut="⌘B"
        onNotificationsOpenChange={onNotificationsOpenChange}
      />,
    );

    const location = screen.getByRole("navigation", { name: "Local atual" });
    expect(location).toHaveTextContent("terra-swarm");
    expect(location).toHaveTextContent("Refatorar planejador");
    expect(location).toHaveTextContent("main");
    expect(screen.queryByRole("button", { name: "Voltar" })).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Abrir ações rápidas" }));
    await user.click(screen.getByRole("button", { name: "2 precisam de você" }));
    await user.click(screen.getByRole("button", { name: "Voz" }));
    await user.click(screen.getByRole("button", { name: "Mostrar inspetor" }));
    await user.click(screen.getByRole("button", { name: "Recolher barra lateral (⌘B)" }));
    expect(onOpenLauncher).toHaveBeenCalledOnce();
    expect(onNotificationsOpenChange).toHaveBeenCalledWith(true);
    expect(onToggleVoice).toHaveBeenCalledOnce();
    expect(onToggleInspector).toHaveBeenCalledOnce();
    expect(onToggleSidebar).toHaveBeenCalledOnce();
  });

  it("uses a plain bell when nothing needs the user", () => {
    render(<WindowChrome attentionCount={0} />);
    expect(screen.getByRole("button", { name: "Notificações" })).toHaveAttribute("data-attention", "false");
  });

  it("keeps the chrome itself draggable on Tauri and text pass-through", () => {
    render(<WindowChrome breadcrumb={{ project: "terra-swarm" }} />);
    expect(screen.getByRole("banner")).toHaveAttribute("data-tauri-drag-region", "true");
    expect(shellStyles).toMatch(/\.terra-window-breadcrumb\s*>\s*\*,[\s\S]*?pointer-events:\s*none/);
  });

  it("closes the notification popover on Escape", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<WindowChrome notificationsOpen onNotificationsOpenChange={onChange} notificationsPanel={<div>Panel</div>} />);
    expect(screen.getByText("Panel")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(onChange).toHaveBeenCalledWith(false);
  });
});

describe("Sidebar", () => {
  it("switches between Workbench and Frota and shows the attention count", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<SurfaceSwitch surface="workbench" attentionCount={3} onNavigate={onNavigate} />);
    expect(screen.getByRole("button", { name: "Workbench" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: /Frota/ }));
    expect(onNavigate).toHaveBeenCalledWith("fleet");
    expect(screen.getByLabelText("3 precisam de você")).toBeInTheDocument();
  });

  it("puts settings and the active agent count in the footer", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    render(
      <Sidebar surface="workbench" attentionCount={0} onNavigate={vi.fn()} activeAgents={3} version="2.0.3" onOpenSettings={onOpenSettings}>
        <div>Tree</div>
      </Sidebar>,
    );
    expect(screen.getByText("3 agentes ativos · v2.0.3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Configurações" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("collapses to project initials and one dot per agent of the active project", async () => {
    const user = userEvent.setup();
    const onFocusAgent = vi.fn();
    const onExpand = vi.fn();
    render(
      <CollapsedSidebar
        surface="workbench"
        attentionCount={1}
        projects={[
          { id: "ws-1", name: "terra-swarm", status: "attention", suspended: false, agents: [
            { id: "pty-1", label: "Planejador", status: "attention", detail: "precisa de você" },
            { id: "pty-2", label: "codex", status: "working", detail: "trabalhando" },
          ] },
          { id: "ws-2", name: "site-docs", status: "idle", suspended: false, agents: [] },
        ]}
        activeWorkspaceId="ws-1"
        focusedAgentId="pty-1"
        onNavigate={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onFocusAgent={onFocusAgent}
        onOpenSettings={vi.fn()}
        onExpand={onExpand}
        expandShortcut="⌘B"
      />,
    );
    expect(screen.getByRole("button", { name: "terra-swarm, 2 agentes" })).toHaveTextContent("ts");
    expect(screen.getByRole("button", { name: "site-docs, 0 agentes" })).toHaveTextContent("sd");
    await user.click(screen.getByRole("button", { name: "codex, trabalhando" }));
    expect(onFocusAgent).toHaveBeenCalledWith("ws-1", "pty-2");
    await user.click(screen.getByRole("button", { name: "Expandir barra lateral (⌘B)" }));
    expect(onExpand).toHaveBeenCalledOnce();
  });
});
