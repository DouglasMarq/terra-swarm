// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceWorkbench } from "./WorkspaceWorkbench";
import type { WorkspaceSnapshotV2 } from "../../types";
import workbenchStyles from "./workbench.css?raw";

const snapshot: WorkspaceSnapshotV2 = {
  version: 2,
  projects: [{
    id: "project-1",
    name: "Terra API",
    cwd: "/tmp/terra-api",
    groupId: null,
    paneIds: ["pane-1"],
    containerIds: ["container-1"],
    activePaneId: "pane-1",
    activeContainerId: "container-1",
    layout: { mode: "auto", itemIds: ["container-1"] },
    collapsed: false,
  }],
  groups: [],
  containers: [{
    id: "container-1",
    projectId: "project-1",
    paneIds: ["pane-1"],
    layout: { mode: "auto", itemIds: ["pane-1"] },
    visible: true,
    collapsed: false,
    closed: false,
    fullscreen: false,
  }],
  panes: [{
    id: "pane-1",
    projectId: "project-1",
    containerId: "container-1",
    tabIds: ["tab-1"],
    activeTabId: "tab-1",
    layout: { mode: "auto", itemIds: ["tab-1"] },
  }],
  tabs: [{
    id: "tab-1",
    paneId: "pane-1",
    ptyId: "pty-1",
    command: "luna-max",
    cwd: "/tmp/terra-api",
    width: 100,
    title: "Luna Max",
    orphaned: false,
  }],
  orphanedTabIds: [],
  activeProjectId: "project-1",
  activeGroupId: null,
  activeContainerId: "container-1",
  activePaneId: "pane-1",
  activeTabId: "tab-1",
  layout: { mode: "auto", itemIds: ["container-1"] },
};

describe("WorkspaceWorkbench", () => {
  it("keeps the height contract across the workbench and pane boundaries", () => {
    render(
      <WorkspaceWorkbench
        renderTab={({ tab }) => <div>Terminal {tab.title}</div>}
        source={snapshot}
      />,
    );

    const workbench = document.querySelector(".terra-workbench");
    const list = document.querySelector(".terra-workbench__list");
    const container = document.querySelector(".terra-workbench__container");
    expect(workbench).toBeInTheDocument();
    expect(list).toHaveAttribute("data-container-count", "1");
    expect(container).toHaveAttribute("data-visible", "true");
    expect(container).toHaveAttribute("data-collapsed", "false");
    expect(container).toHaveAttribute("data-fullscreen", "false");
    expect(container?.querySelector(".terra-project-container__surface")).toBeInTheDocument();
    expect(container?.querySelector(".terra-pane-grid")).toBeInTheDocument();
    expect(container?.querySelector(".terra-pane-frame")).toBeInTheDocument();
    expect(container?.querySelector(".terra-pane-frame__surface")).toBeInTheDocument();
    expect(container?.querySelector(".terra-pane-tab-surfaces")).toBeInTheDocument();
    expect(document.querySelector(".terra-project-container__meta")).not.toBeInTheDocument();
  });

  it("offers direct agent creation in an empty pane with its exact location", async () => {
    const user = userEvent.setup();
    const onNewTab = vi.fn();
    const emptyPaneSource: WorkspaceSnapshotV2 = {
      ...snapshot,
      projects: [{
        ...snapshot.projects[0],
        paneIds: ["pane-1"],
        activePaneId: "pane-1",
      }],
      panes: [{
        ...snapshot.panes[0],
        tabIds: [],
        activeTabId: null,
        layout: { mode: "auto", itemIds: [] },
      }],
      tabs: [],
      activeTabId: null,
    };

    render(
      <WorkspaceWorkbench
        onNewTab={onNewTab}
        renderTab={({ tab }) => <div>Terminal {tab.title}</div>}
        source={emptyPaneSource}
      />,
    );

    expect(screen.getByRole("heading", { name: "Nenhum agente neste painel" })).toBeInTheDocument();
    expect(screen.getByText("Projeto: Terra API")).toBeInTheDocument();
    expect(screen.queryByText(/container-1|pane-1/)).not.toBeInTheDocument();
    expect(document.querySelector(".terra-subtab-lane")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Criar nova aba" })).not.toBeInTheDocument();
    expect(document.querySelector(".terra-pane-frame__toolbar")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Criar agente neste painel" }));
    expect(onNewTab).toHaveBeenCalledWith({
      projectId: "project-1",
      containerId: "container-1",
      paneId: "pane-1",
    });
  });

  it("offers first-agent creation when a container has no panes", async () => {
    const user = userEvent.setup();
    const onNewTab = vi.fn();
    const emptyContainerSource: WorkspaceSnapshotV2 = {
      ...snapshot,
      projects: [{
        ...snapshot.projects[0],
        paneIds: [],
        activePaneId: null,
      }],
      containers: [{
        ...snapshot.containers[0],
        paneIds: [],
        activePaneId: null,
        layout: { mode: "auto", itemIds: [] },
      }],
      panes: [],
      tabs: [],
      activePaneId: null,
      activeTabId: null,
    };

    render(
      <WorkspaceWorkbench
        onNewTab={onNewTab}
        renderTab={({ tab }) => <div>Terminal {tab.title}</div>}
        source={emptyContainerSource}
      />,
    );

    expect(screen.getByRole("heading", { name: "Nenhum agente neste painel" })).toBeInTheDocument();
    expect(screen.getByText("Projeto: Terra API")).toBeInTheDocument();
    expect(document.querySelector(".terra-pane-grid")).not.toBeInTheDocument();
    expect(document.querySelector(".terra-pane-frame")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Criar agente neste painel" }));
    expect(onNewTab).toHaveBeenCalledWith({
      projectId: "project-1",
      containerId: "container-1",
      paneId: null,
    });
  });

  it("keeps every workbench boundary flexing to the available height", () => {
    render(
      <WorkspaceWorkbench
        renderTab={({ tab }) => <div className="pane">Terminal {tab.title}</div>}
        source={snapshot}
      />,
    );

    const selectors = [
      ".terra-workbench",
      ".terra-workbench__list",
      ".terra-workbench__container",
      ".terra-project-container",
      ".terra-project-container__surface",
      ".terra-pane-grid",
      ".terra-pane-frame",
      ".terra-pane-frame__surface",
      ".terra-pane-tab-surfaces",
      ".terra-pane-tab-surface",
      ".terra-pane-tab-surface > .pane",
    ];
    const elements = selectors.map((selector) => document.querySelector(selector));
    expect(elements.every((element) => element)).toBe(true);
    expect(workbenchStyles).toMatch(
      /\.terra-workbench \.terra-workbench__list > \.terra-workbench__container\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?flex:\s*1 1 0;/,
    );
    expect(workbenchStyles).toMatch(
      /\.terra-workbench \.terra-workbench__container > \.terra-project-container\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?flex:\s*1 1 auto;/,
    );
    expect(workbenchStyles).toMatch(
      /\.terra-pane-tab-surface > \.pane\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?width:\s*100%;[\s\S]*?height:\s*100%;/,
    );
  });

  it("keeps collapsed and hidden containers out of the active height split", () => {
    const secondProject = {
      ...snapshot.projects[0],
      id: "project-2",
      name: "Terra UI",
      paneIds: ["pane-2"],
      containerIds: ["container-2"],
      activePaneId: "pane-2",
      activeContainerId: "container-2",
    };
    const secondContainer = {
      ...snapshot.containers[0],
      id: "container-2",
      projectId: "project-2",
      paneIds: ["pane-2"],
      collapsed: true,
    };
    const secondPane = {
      ...snapshot.panes[0],
      id: "pane-2",
      projectId: "project-2",
      containerId: "container-2",
      tabIds: ["tab-2"],
      activeTabId: "tab-2",
    };
    const secondTab = {
      ...snapshot.tabs[0],
      id: "tab-2",
      paneId: "pane-2",
      ptyId: "pty-2",
      title: "Luna Max 2",
    };
    const multiContainerSource: WorkspaceSnapshotV2 = {
      ...snapshot,
      projects: [snapshot.projects[0], secondProject],
      containers: [snapshot.containers[0], secondContainer],
      panes: [snapshot.panes[0], secondPane],
      tabs: [snapshot.tabs[0], secondTab],
    };

    render(
      <WorkspaceWorkbench
        renderTab={({ tab }) => <div>Terminal {tab.title}</div>}
        source={multiContainerSource}
      />,
    );

    const wrappers = [...document.querySelectorAll(".terra-workbench__container")];
    expect(wrappers).toHaveLength(2);
    expect(wrappers[0]).toHaveAttribute("data-collapsed", "false");
    expect(wrappers[1]).toHaveAttribute("data-collapsed", "true");
    expect(wrappers[1]).toContainElement(screen.getByText("Terminal Luna Max 2"));
  });

  it("hides a visual container without dispatching a kill action", async () => {
    const user = userEvent.setup();
    const onHideContainer = vi.fn();
    const onKillTab = vi.fn();
    render(
      <WorkspaceWorkbench
        onHideContainer={onHideContainer}
        onKillTab={onKillTab}
        renderTab={({ tab }) => <div>Terminal {tab.title}</div>}
        source={snapshot}
      />,
    );

    expect(screen.getByText("Terminal Luna Max")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ocultar Terra API" }));
    expect(onHideContainer).toHaveBeenCalledWith("container-1");
    expect(onKillTab).not.toHaveBeenCalled();
  });

  it("hides the tab lane for a single-agent pane", () => {
    render(<WorkspaceWorkbench renderTab={({ tab }) => <div>Terminal {tab.title}</div>} source={snapshot} />);
    expect(document.querySelector('button[aria-label="Encerrar Luna Max"]')).toBeNull();
  });

  it("keeps tab termination owned by the lane without a duplicate toolbar action", async () => {
    const user = userEvent.setup();
    const onKillTab = vi.fn();
    const twoTabs: WorkspaceSnapshotV2 = {
      ...snapshot,
      panes: [{ ...snapshot.panes[0], tabIds: ["tab-1", "tab-2"], activeTabId: "tab-1" }],
      tabs: [snapshot.tabs[0], { ...snapshot.tabs[0], id: "tab-2", ptyId: "pty-2", title: "Second" }],
    };
    render(
      <WorkspaceWorkbench
        onKillTab={onKillTab}
        renderTab={({ tab }) => <div>Terminal {tab.title}</div>}
        source={twoTabs}
      />,
    );

    const killButtons = document.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Encerrar Luna Max"]',
    );
    expect(killButtons).toHaveLength(1);
    expect(document.querySelector(".terra-pane-frame__toolbar")).not.toBeInTheDocument();

    fireEvent.click(killButtons[0]);
    await user.click(screen.getByRole("button", { name: "Encerrar terminal" }));
    expect(onKillTab).toHaveBeenCalledTimes(1);
    expect(onKillTab).toHaveBeenCalledWith("tab-1", {
      projectId: "project-1",
      containerId: "container-1",
      paneId: "pane-1",
    });
  });

  it("switches between Grade and Foco from the container header", async () => {
    const user = userEvent.setup();
    const onWorkspaceLayoutChange = vi.fn();
    render(
      <WorkspaceWorkbench
        onWorkspaceLayoutChange={onWorkspaceLayoutChange}
        renderTab={({ tab }) => <div>Terminal {tab.title}</div>}
        source={snapshot}
      />,
    );

    const modes = screen.getByRole("group", { name: "Layout de Terra API" });
    expect(within(modes).getByRole("button", { name: "Grade" })).toHaveAttribute("aria-pressed", "true");
    await user.click(within(modes).getByRole("button", { name: "Foco" }));
    expect(onWorkspaceLayoutChange).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({
        mode: "spotlight",
        metadata: expect.objectContaining({ workbenchMode: "spotlight" }),
      }),
    );
  });

  it("keeps collapse and fullscreen as visual callbacks", async () => {
    const user = userEvent.setup();
    const onCollapseContainer = vi.fn();
    const onFullscreenContainer = vi.fn();
    render(
      <WorkspaceWorkbench
        onCollapseContainer={onCollapseContainer}
        onFullscreenContainer={onFullscreenContainer}
        renderTab={({ tab }) => <div>Terminal {tab.title}</div>}
        source={snapshot}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Recolher Terra API" }));
    await user.click(screen.getByRole("button", { name: "Tela cheia de Terra API" }));
    expect(onCollapseContainer).toHaveBeenCalledWith("container-1", true);
    expect(onFullscreenContainer).toHaveBeenCalledWith("container-1", true);
  });

  it("renders Grid as a real mounted CSS layout instead of a placeholder", () => {
    const gridSource: WorkspaceSnapshotV2 = {
      ...snapshot,
      projects: [{
        ...snapshot.projects[0],
        layout: { mode: "grid", itemIds: ["container-1"] },
        paneIds: ["pane-1", "pane-2"],
      }],
      containers: [{
        ...snapshot.containers[0],
        paneIds: ["pane-1", "pane-2"],
        layout: {
          mode: "grid",
          columns: 2,
          rows: 1,
          itemIds: ["pane-1", "pane-2"],
          sizes: { "pane-1": 40, "pane-2": 60 },
          metadata: { source: "test" },
        },
      }],
      panes: [
        snapshot.panes[0],
        { ...snapshot.panes[0], id: "pane-2", tabIds: ["tab-2"], activeTabId: "tab-2" },
      ],
      tabs: [
        snapshot.tabs[0],
        { ...snapshot.tabs[0], id: "tab-2", paneId: "pane-2", title: "Second" },
      ],
    };
    render(
      <WorkspaceWorkbench
        renderTab={({ tab }) => <div>Terminal {tab.title}</div>}
        source={gridSource}
      />,
    );

    const grid = document.querySelector('[data-layout-mode="grid"]');
    expect(grid).toHaveClass("terra-pane-grid--grid");
    expect(grid).toHaveAttribute("data-grid-columns", "2");
    expect(grid).toHaveAttribute("data-grid-rows", "1");
    expect(screen.getByText("Terminal Luna Max")).toBeInTheDocument();
    expect(screen.getByText("Terminal Second")).toBeInTheDocument();
    expect(screen.queryByText(/Custom grid/)).not.toBeInTheDocument();
  });

  it("fixes the grid size from the 8×8 picker through the existing layout callback", async () => {
    const user = userEvent.setup();
    const onLayoutChange = vi.fn();
    const gridSource: WorkspaceSnapshotV2 = {
      ...snapshot,
      projects: [{
        ...snapshot.projects[0],
        layout: { mode: "grid", itemIds: ["container-1"] },
        paneIds: ["pane-1", "pane-2"],
      }],
      containers: [{
        ...snapshot.containers[0],
        paneIds: ["pane-1", "pane-2"],
        layout: {
          mode: "grid",
          columns: 2,
          rows: 1,
          itemIds: ["pane-1", "pane-2"],
          sizes: { "pane-1": 35, "pane-2": 65 },
          metadata: { source: "editor" },
        },
      }],
      panes: [
        snapshot.panes[0],
        { ...snapshot.panes[0], id: "pane-2", tabIds: ["tab-2"], activeTabId: "tab-2" },
      ],
      tabs: [
        snapshot.tabs[0],
        { ...snapshot.tabs[0], id: "tab-2", paneId: "pane-2", title: "Second" },
      ],
    };
    render(
      <WorkspaceWorkbench
        onLayoutChange={onLayoutChange}
        renderTab={({ tab }) => <div>Terminal {tab.title}</div>}
        source={gridSource}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Tamanho da grade" }));
    expect(screen.getAllByRole("button", { name: /^\d × \d$/ })).toHaveLength(64);
    await user.click(screen.getByRole("button", { name: "8 × 8" }));
    expect(onLayoutChange).toHaveBeenCalledWith({
      containerId: "container-1",
      layout: expect.objectContaining({
        mode: "grid",
        columns: 8,
        rows: 8,
        itemIds: ["pane-1", "pane-2"],
        sizes: { "pane-1": 35, "pane-2": 65 },
        metadata: { source: "editor" },
      }),
    });
  });

  it("keeps agent tabs focusable without any reorder affordance", async () => {
    const source: WorkspaceSnapshotV2 = {
      ...snapshot,
      panes: [{
        ...snapshot.panes[0],
        tabIds: ["tab-1", "tab-2"],
        activeTabId: "tab-1",
      }],
      tabs: [
        snapshot.tabs[0],
        {
          ...snapshot.tabs[0],
          id: "tab-2",
          ptyId: "pty-2",
          title: "Second agent",
          paneId: "pane-1",
        },
      ],
    };
    render(
      <WorkspaceWorkbench
        renderTab={({ tab }) => <div>Terminal {tab.title}</div>}
        source={source}
      />,
    );

    const first = screen.getByRole("button", { name: "Focar Luna Max" });
    expect(first).not.toHaveAttribute("aria-roledescription");
    expect(first.closest("[data-tab-dnd-id]")).toBeNull();
    expect(screen.queryByRole("button", { name: /Reordenar/ })).not.toBeInTheDocument();
  });

  it("does not expose pane drag handles or cross-project drop state", () => {
    const secondProject = {
      ...snapshot.projects[0],
      id: "project-2",
      name: "Terra UI",
      paneIds: ["pane-2"],
      containerIds: ["container-2"],
      activePaneId: "pane-2",
      activeContainerId: "container-2",
    };
    const secondContainer = {
      ...snapshot.containers[0],
      id: "container-2",
      projectId: "project-2",
      paneIds: ["pane-2"],
      layout: { mode: "auto" as const, itemIds: ["pane-2"] },
    };
    const secondPane = {
      ...snapshot.panes[0],
      id: "pane-2",
      projectId: "project-2",
      containerId: "container-2",
      tabIds: ["tab-2"],
      activeTabId: "tab-2",
    };
    const secondTab = {
      ...snapshot.tabs[0],
      id: "tab-2",
      paneId: "pane-2",
      ptyId: "pty-2",
      title: "Second agent",
    };
    const source: WorkspaceSnapshotV2 = {
      ...snapshot,
      projects: [snapshot.projects[0], secondProject],
      containers: [snapshot.containers[0], secondContainer],
      panes: [snapshot.panes[0], secondPane],
      tabs: [snapshot.tabs[0], secondTab],
    };

    render(
      <WorkspaceWorkbench
        renderTab={({ tab }) => <div>Terminal {tab.title}</div>}
        source={source}
      />,
    );

    expect(screen.queryByRole("button", { name: /Reordenar/ })).not.toBeInTheDocument();
    expect(document.querySelector("[data-drop-invalid]")).toBeNull();
    expect(workbenchStyles).not.toMatch(/dnd|drag|drop-invalid|sortable/i);
  });


  it("returns a fixed grid to automatic sizing", async () => {
    const user = userEvent.setup();
    const onLayoutChange = vi.fn();
    const source: WorkspaceSnapshotV2 = {
      ...snapshot,
      projects: [{ ...snapshot.projects[0], layout: { mode: "grid", itemIds: ["container-1"] } }],
      containers: [{ ...snapshot.containers[0], layout: { mode: "grid", columns: 3, rows: 2, itemIds: ["pane-1"] } }],
    };
    render(
      <WorkspaceWorkbench
        onLayoutChange={onLayoutChange}
        onNewTab={vi.fn()}
        renderTab={({ tab }) => <div>Terminal {tab.title}</div>}
        source={source}
      />,
    );
    // No empty "+ New agent" slots: the lone pane fills the free width.
    expect(screen.queryByRole("button", { name: "Novo agente" })).not.toBeInTheDocument();
    expect((document.querySelector(".terra-pane-grid__cell") as HTMLElement).style.gridColumn).toBe("span 3");
    await user.click(screen.getByRole("button", { name: "Tamanho da grade" }));
    await user.click(screen.getByRole("button", { name: "Automática" }));
    const layout = onLayoutChange.mock.calls[0][0].layout;
    expect(layout.mode).toBe("grid");
    expect(layout.columns).toBeUndefined();
    expect(layout.rows).toBeUndefined();
  });
});
