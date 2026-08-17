// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { TerminalTab } from "../../types";
import { ApplicationShell } from "./ApplicationShell";
import { WindowChrome } from "./WindowChrome";
import shellStyles from "./shell.css?raw";
import { SubTabLane } from "../workbench/SubTabLane";

describe("ApplicationShell", () => {
  it("keeps the dock header minimal and uses tabs as the only panel labels", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onTabChange = vi.fn();
    render(
      <ApplicationShell
        navigator={<div>Navigator</div>}
        rightDock={{
          activeTab: "inspector",
          onClose,
          onTabChange,
          open: true,
          panels: [
            { id: "inspector", label: "Inspector", content: <p>Inspector content</p> },
            { id: "events", label: "Eventos", count: 2, content: <p>Events content</p> },
          ],
          selectedLabel: "Luna Max",
        }}
      >
        <div>Content</div>
      </ApplicationShell>,
    );

    const dock = screen.getByRole("complementary", { name: "Painel contextual" });
    expect(dock.querySelector(".terra-right-dock-title")).toBeNull();
    expect(screen.queryByText("Em foco")).not.toBeInTheDocument();
    expect(screen.queryByText("Luna Max")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Inspector" })).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /^Eventos/ }));
    expect(onTabChange).toHaveBeenCalledWith("events");
    await user.click(screen.getByRole("button", { name: "Fechar painel contextual" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps actionable chrome while omitting dead controls and zero telemetry", () => {
    render(
      <WindowChrome
        activeSurface="workbench"
        canGoBack
        canGoForward
        onBack={vi.fn()}
        onForward={vi.fn()}
        onNewWorkspace={vi.fn()}
        onOpenLauncher={vi.fn()}
        onToggleVoice={vi.fn()}
        resources={{ active: 0, queued: 0 }}
        workspaceTabs={[{ id: "workspace-a", label: "Alpha" }]}
      />,
    );

    expect(screen.getByRole("button", { name: "Voltar" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Avançar" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Abrir workspace" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Abrir ações rápidas" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Voz" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Abrir workspace Alpha" })).toBeInTheDocument();

    expect(screen.queryByText("0 ativas")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Recursos de execução")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Estado do shell")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Atalho de teclado")).not.toBeInTheDocument();
  });

  it("keeps every non-interactive chrome segment draggable on Tauri", () => {
    render(
      <WindowChrome
        workspaceTabs={[{ id: "workspace-a", label: "Alpha" }]}
        activeWorkspaceId="workspace-a"
        resources={{ active: 1 }}
      />,
    );

    const chrome = screen.getByRole("banner");
    expect(chrome.querySelector(".terra-window-brand")).toHaveAttribute(
      "data-tauri-drag-region",
      "true",
    );
    expect(chrome.querySelector(".terra-window-history")).toHaveAttribute(
      "data-tauri-drag-region",
      "true",
    );
    expect(chrome.querySelector(".terra-window-tab-strip")).toHaveAttribute(
      "data-tauri-drag-region",
      "true",
    );
    expect(chrome.querySelector("[data-workspace-tab-id='workspace-a']")).toHaveAttribute(
      "data-tauri-drag-region",
      "true",
    );
    expect(chrome.querySelector(".terra-window-meta")).toHaveAttribute(
      "data-tauri-drag-region",
      "true",
    );

    // Controls must remain native targets so tab selection/close and toolbar
    // actions do not start moving the native window.
    expect(screen.getByRole("button", { name: "Abrir workspace Alpha" })).not.toHaveAttribute(
      "data-tauri-drag-region",
    );
    expect(screen.getByRole("button", { name: "Fechar workspace Alpha" })).not.toHaveAttribute(
      "data-tauri-drag-region",
    );
    expect(shellStyles).toMatch(/\.terra-window-brand\s*>\s*\*,[\s\S]*pointer-events:\s*none/);
  });

  it("renders the navigator, content, dock and telemetry slots", () => {
    render(
      <ApplicationShell
        chrome={{ title: "Terra test" }}
        navigator={<div>Navigator slot</div>}
        rightDock={{
          open: true,
          panels: [{ id: "inspector", label: "Inspector", content: <p>Dock slot</p> }],
        }}
        telemetry={<span>Telemetry slot</span>}
      >
        <div>Content slot</div>
      </ApplicationShell>,
    );

    expect(screen.getByText("Navigator slot")).toBeInTheDocument();
    expect(screen.getByText("Content slot")).toBeInTheDocument();
    expect(screen.getByText("Dock slot")).toBeInTheDocument();
    expect(screen.getByText("Telemetry slot")).toBeInTheDocument();
    expect(screen.getByRole("banner")).toHaveAttribute("data-tauri-drag-region", "true");
  });

  it("forwards activity navigation without owning routing", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<ApplicationShell activity={{ onNavigate }} navigator={<div>Navigator</div>}><div>Content</div></ApplicationShell>);

    await user.click(screen.getByRole("button", { name: "Frota" }));
    expect(onNavigate).toHaveBeenCalledWith("fleet");
  });

  it("removes resizable panels in compact mode and exposes drawer controls", async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    });

    try {
      const user = userEvent.setup();
      const onOpen = vi.fn();
      const onClose = vi.fn();
      render(
        <ApplicationShell
          navigator={<div>Navigator slot</div>}
          rightDock={{ open: true, onOpen, onClose, panels: [{ id: "inspector", label: "Inspector", content: <p>Dock slot</p> }] }}
        >
          <div>Content slot</div>
        </ApplicationShell>,
      );

      await waitFor(() => expect(screen.getByRole("button", { name: "Navegador" })).toBeInTheDocument());
      expect(screen.queryByRole("separator", { name: "Redimensionar navegador" })).not.toBeInTheDocument();
      expect(screen.queryByText("Navigator slot")).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Navegador" }));
      expect(screen.getByText("Navigator slot")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Fechar navegador" }));
      expect(screen.queryByText("Navigator slot")).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Inspetor" }));
      expect(screen.getByText("Dock slot")).toBeInTheDocument();
      expect(onOpen).toHaveBeenCalledOnce();
      expect(screen.getByRole("button", { name: "Inspetor" })).toHaveAttribute("aria-expanded", "true");

      await user.click(screen.getByRole("button", { name: "Inspetor" }));
      expect(screen.queryByText("Dock slot")).not.toBeInTheDocument();
      expect(onClose).toHaveBeenCalledOnce();
      expect(screen.getByRole("button", { name: "Inspetor" })).toHaveAttribute("aria-expanded", "false");
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it("closes the compact navigator through its backdrop and keeps the drawer keyboard reachable", async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    });

    try {
      const user = userEvent.setup();
      render(
        <ApplicationShell
          navigator={<div>Navigator slot</div>}
          rightDock={{ open: true, panels: [{ id: "inspector", label: "Inspector", content: <p>Dock slot</p> }] }}
        >
          <div>Content slot</div>
        </ApplicationShell>,
      );

      await user.click(screen.getByRole("button", { name: "Navegador" }));
      const closeButton = screen.getByRole("button", { name: "Fechar navegador" });
      // The compact drawer is in the tab order after the toolbar and backdrop.
      await user.tab();
      await user.tab();
      await user.tab();
      expect(closeButton).toHaveFocus();

      await user.click(screen.getByRole("button", { name: "Fechar gaveta do navegador" }));
      expect(screen.queryByText("Navigator slot")).not.toBeInTheDocument();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it("keeps a visible affordance to reopen a closed desktop dock", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(
      <ApplicationShell
        navigator={<div>Navigator</div>}
        rightDock={{ open: false, onOpen, panels: [{ id: "inspector", label: "Inspector", content: <p>Dock</p> }] }}
      >
        <div>Content</div>
      </ApplicationShell>,
    );

    const button = screen.getByRole("button", { name: "Abrir painel contextual" });
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute("data-shell-slot", "dock-reopen");
    expect(button).toHaveAttribute("title", "Abrir painel contextual");
    expect(button.parentElement).toHaveClass("terra-shell-body");
    expect(button.previousElementSibling).toHaveClass("terra-shell-panel-group");
    await user.click(button);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("keeps the desktop dock reopen control in a reserved shell rail", () => {
    const rule = shellStyles.match(/\.terra-shell-dock-reopen\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";

    expect(rule).toMatch(/position:\s*relative;/);
    expect(rule).toMatch(/flex:\s*0 0 34px;/);
    expect(rule).toMatch(/width:\s*34px;/);
    expect(rule).not.toMatch(/position:\s*absolute;/);
    expect(shellStyles).not.toMatch(/\.terra-shell-dock-reopen\s*\{[\s\S]*?top:\s*\d+px;[\s\S]*?right:\s*\d+px;/);
  });

  it("keeps terminal tab controls separate from the desktop dock reopen rail", async () => {
    const user = userEvent.setup();
    const onSelectWorkspace = vi.fn();
    const onCloseWorkspace = vi.fn();
    const onOpen = vi.fn();
    const onDetachTab = vi.fn();
    const onKillTab = vi.fn();
    const terminalTab: TerminalTab = {
      id: "terminal-tab",
      paneId: "terminal-pane",
      ptyId: "pty-terminal",
      command: "luna-max",
      cwd: "/tmp/terra",
      width: 100,
      title: "Luna Max",
      orphaned: false,
    };

    render(
      <ApplicationShell
        chrome={{
          workspaceTabs: [{ id: "terminal-workspace", label: "Terminal", closable: true }],
          activeWorkspaceId: "terminal-workspace",
          onSelectWorkspace,
          onCloseWorkspace,
        }}
        navigator={<div>Navigator</div>}
        rightDock={{
          open: false,
          onOpen,
          panels: [{ id: "inspector", label: "Inspector", content: <p>Dock</p> }],
        }}
      >
        <SubTabLane
          tabs={[{ tab: terminalTab, active: true }]}
          onDetachTab={onDetachTab}
          onKillTab={onKillTab}
        />
      </ApplicationShell>,
    );

    const reopen = screen.getByRole("button", { name: "Abrir painel contextual" });
    const chrome = screen.getByRole("banner");
    const tablist = screen.getByRole("tablist", { name: "Workspaces abertos" });
    const terminalControl = screen.getByRole("button", { name: "Focar Luna Max" });

    expect(reopen.closest(".terra-window-chrome")).toBeNull();
    expect(reopen.parentElement).toHaveClass("terra-shell-body");
    expect(reopen.previousElementSibling).toHaveClass("terra-shell-panel-group");
    expect(chrome.nextElementSibling).toHaveClass("terra-shell-body");
    expect(tablist).toContainElement(screen.getByRole("button", { name: "Abrir workspace Terminal" }));
    expect(tablist).toContainElement(screen.getByRole("button", { name: "Fechar workspace Terminal" }));
    expect(terminalControl.closest(".terra-shell-panel-group")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Desanexar Luna Max" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Encerrar Luna Max" })).toBeInTheDocument();
    expect(reopen).not.toContainElement(terminalControl);

    await user.click(screen.getByRole("button", { name: "Abrir workspace Terminal" }));
    await user.click(screen.getByRole("button", { name: "Fechar workspace Terminal" }));
    expect(onSelectWorkspace).toHaveBeenCalledWith("terminal-workspace");
    expect(onCloseWorkspace).toHaveBeenCalledWith("terminal-workspace");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("exposes keyboard-sortable workspace tabs", async () => {
    const user = userEvent.setup();
    render(
      <ApplicationShell
        chrome={{
          workspaceTabs: [
            { id: "workspace-a", label: "Alpha" },
            { id: "workspace-b", label: "Beta" },
          ],
        }}
        navigator={<div>Navigator</div>}
      >
        <div>Content</div>
      </ApplicationShell>,
    );

    const alpha = screen.getByRole("button", { name: "Abrir workspace Alpha" });
    expect(alpha).toHaveAttribute("aria-roledescription", "sortable");
    const alphaTab = alpha.closest("[data-workspace-tab-id]");
    expect(alphaTab).toBeInTheDocument();
    alpha.focus();
    await user.keyboard("{Enter}");
    expect(alphaTab).toHaveAttribute("data-dragging", "true");
    await user.keyboard("{Escape}");
    expect(alphaTab).toHaveAttribute("data-dragging", "false");
  });
});
