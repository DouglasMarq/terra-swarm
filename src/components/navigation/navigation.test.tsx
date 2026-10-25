// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavigatorPanel } from "./NavigatorPanel";
import type { Workspace, WorkspaceGroup, WorkspaceSnapshotV2 } from "../../domain/workspace.model";
import { useEditorStore } from "../../stores/editorStore";
import { defined } from "../../test/defined";

const groups: WorkspaceGroup[] = [{
  id: "group-core",
  name: "Core",
  collapsed: false,
  projectIds: ["ws-api"],
  parentGroupId: null,
  suspended: false,
}];

const workspaces: Workspace[] = [{
  id: "ws-api",
  name: "Terra API",
  cwd: "/tmp/terra-api",
  groupId: "group-core",
  terminals: [{ id: "term-luna", command: "luna-max", width: 100 }],
}];

describe("NavigatorPanel", () => {
  beforeEach(() => useEditorStore.setState({ target: null }));
  afterEach(() => useEditorStore.setState({ target: null }));

  it("filters projects and agents by text and keeps keyboard activation available", async () => {
    const user = userEvent.setup();
    const onOpenTerminal = vi.fn();
    render(<NavigatorPanel onOpenTerminal={onOpenTerminal} workspaces={workspaces} groups={groups} />);

    const search = screen.getByRole("searchbox", { name: "Buscar projetos e agentes" });
    await user.type(search, "luna");
    expect(screen.getByRole("treeitem", { name: "Agente luna-max" })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "Projeto Terra API" })).toBeInTheDocument();

    const agent = screen.getByRole("treeitem", { name: "Agente luna-max" });
    agent.focus();
    await user.keyboard("{Enter}");
    expect(onOpenTerminal).toHaveBeenCalledWith("ws-api", "term-luna");
  });

  it("Given nested tree rows, when rendering the navigator, then each level indents 16px like the files view", () => {
    render(<NavigatorPanel workspaces={workspaces} groups={groups} />);

    for (const row of screen.getAllByRole("treeitem")) {
      const depth = Number(row.getAttribute("data-depth"));
      expect(row.style.paddingInlineStart).toBe(`${8 + depth * 16}px`);
    }
    expect(screen.getByRole("treeitem", { name: "Projeto Terra API" }).style.paddingInlineStart).toBe("24px");
  });

  it("exposes activity tabs and forwards the selected surface", async () => {
    const onActivityChange = vi.fn();
    render(<NavigatorPanel onActivityChange={onActivityChange} workspaces={[]} />);

    expect(screen.getByRole("tab", { name: "Projetos" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Git" })).not.toBeInTheDocument();
    expect(onActivityChange).not.toHaveBeenCalled();
  });

  it("keeps the three activity tabs aligned and keyboard focusable", () => {
    const loadFiles = vi.fn(async () => ({ path: "", entries: [], truncated: false, limit: 200 }));
    const loadGitStatus = vi.fn(async () => ({
      branch: "main",
      ahead: 0,
      behind: 0,
      staged: [],
      modified: [],
      untracked: [],
      conflicted: [],
    }));
    render(<NavigatorPanel availableActivities={["projects", "files", "git"]} loadFiles={loadFiles} loadGitStatus={loadGitStatus} workspaces={workspaces} />);

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    for (const tab of tabs) {
      expect(tab.querySelector("span")).toBeInTheDocument();
    }
    const gitTab = screen.getByRole("tab", { name: "Git" });
    expect(gitTab.querySelector("svg")).toBeInTheDocument();
    expect(gitTab.querySelector("span")).toHaveTextContent("Git");
    expect(screen.queryByText(/quiet console/)).not.toBeInTheDocument();

    tabs[1]?.focus();
    expect(document.activeElement).toBe(tabs[1]);
  });

  it("opens a project on row click and keeps group expansion explicit", async () => {
    const user = userEvent.setup();
    const onOpenWorkspace = vi.fn();
    render(<NavigatorPanel onOpenWorkspace={onOpenWorkspace} workspaces={workspaces} groups={groups} />);

    await user.click(screen.getByRole("treeitem", { name: "Projeto Terra API" }));
    expect(onOpenWorkspace).toHaveBeenCalledWith("ws-api");
    expect(screen.getByRole("treeitem", { name: "Grupo Core" })).not.toHaveAttribute("aria-roledescription", "sortable");
    expect(screen.getByRole("treeitem", { name: "Agente luna-max" })).not.toHaveAttribute("aria-roledescription", "sortable");

    await user.click(screen.getByRole("treeitem", { name: "Grupo Core" }));
    expect(screen.queryByRole("treeitem", { name: "Projeto Terra API" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("treeitem", { name: "Grupo Core" }));
    expect(screen.getByRole("treeitem", { name: "Projeto Terra API" })).toBeInTheDocument();
  });

  it("does not expose drag affordances and supports project deletion on hover", async () => {
    const user = userEvent.setup();
    const onDeleteWorkspace = vi.fn();
    render(
      <NavigatorPanel
        onDeleteWorkspace={onDeleteWorkspace}
        workspaces={workspaces}
        groups={groups}
      />,
    );

    const project = screen.getByRole("treeitem", { name: "Projeto Terra API" });
    expect(project).not.toHaveAttribute("aria-roledescription", "sortable");
    await user.click(within(project).getByRole("button", { name: "Excluir projeto" }));
    expect(onDeleteWorkspace).toHaveBeenCalledWith("ws-api");
  });

  it("opens a delete action from the project context menu", async () => {
    const user = userEvent.setup();
    const onDeleteWorkspace = vi.fn();
    render(
      <NavigatorPanel
        onDeleteWorkspace={onDeleteWorkspace}
        workspaces={workspaces}
        groups={groups}
      />,
    );

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "Projeto Terra API" }), {
      clientX: 32,
      clientY: 42,
    });
    const menu = screen.getByRole("menu", { name: "Menu de contexto do projeto" });
    expect(menu).toBeInTheDocument();
    await user.click(within(menu).getByRole("menuitem", { name: "Excluir projeto" }));
    expect(onDeleteWorkspace).toHaveBeenCalledWith("ws-api");
  });

  it("opens the agent actions from the agent row's … button", async () => {
    const user = userEvent.setup();
    const restart = vi.fn();
    const agentMenu = vi.fn(() => [[{ id: "restart", label: "Reiniciar", onSelect: restart }]]);
    render(<NavigatorPanel agentMenu={agentMenu} shouldFlatten workspaces={workspaces} groups={groups} />);

    const row = screen.getByRole("treeitem", { name: "Agente luna-max" });
    await user.click(within(row).getByRole("button", { name: "Abrir menu de contexto" }));
    expect(agentMenu).toHaveBeenCalledWith("term-luna", "luna-max");
    const menu = screen.getByRole("menu", { name: "Ações de luna-max" });
    await user.click(within(menu).getByRole("menuitem", { name: "Reiniciar" }));
    expect(restart).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps group creation contextual to the groups section", async () => {
    const onCreateGroup = vi.fn();
    render(<NavigatorPanel onCreateGroup={onCreateGroup} workspaces={workspaces} groups={groups} />);

    const createGroupButtons = screen.getAllByRole("button", { name: "Criar grupo" });
    expect(createGroupButtons).toHaveLength(1);
    await userEvent.setup().click(defined(createGroupButtons[0]));
    expect(onCreateGroup).toHaveBeenCalledTimes(1);
  });

  it("emits durable collapsed ids when a branch is toggled", async () => {
    const user = userEvent.setup();
    const onCollapsedChange = vi.fn();
    render(<NavigatorPanel onCollapsedChange={onCollapsedChange} workspaces={workspaces} groups={groups} />);

    await user.click(screen.getByRole("treeitem", { name: "Grupo Core" }));
    expect(onCollapsedChange).toHaveBeenLastCalledWith(["group-core"]);
    await user.click(screen.getByRole("treeitem", { name: "Grupo Core" }));
    expect(onCollapsedChange).toHaveBeenLastCalledWith([]);
  });

  it("only exposes rename for host-supported group and project nodes", () => {
    const snapshot: WorkspaceSnapshotV2 = {
      version: 2,
      projects: [{
        id: "ws-api",
        name: "Terra API",
        cwd: "/tmp/terra-api",
        groupId: "group-core",
        paneIds: ["pane-api"],
        containerIds: ["container-api"],
        activePaneId: "pane-api",
        activeContainerId: "container-api",
        layout: { mode: "auto", itemIds: ["container-api"] },
        collapsed: false,
      }],
      groups: [],
      containers: [{
        id: "container-api",
        projectId: "ws-api",
        paneIds: ["pane-api"],
        layout: { mode: "auto", itemIds: ["pane-api"] },
        visible: true,
        collapsed: false,
        closed: false,
        fullscreen: false,
      }],
      panes: [{
        id: "pane-api",
        projectId: "ws-api",
        containerId: "container-api",
        tabIds: ["tab-luna"],
        activeTabId: "tab-luna",
        layout: { mode: "auto", itemIds: ["tab-luna"] },
      }],
      tabs: [{
        id: "tab-luna",
        paneId: "pane-api",
        ptyId: "term-luna",
        command: "luna-max",
        cwd: "/tmp/terra-api",
        width: 100,
        title: "Luna Max",
        orphaned: false,
      }],
      orphanedTabIds: [],
      activeProjectId: "ws-api",
      activeGroupId: "group-core",
      activeContainerId: "container-api",
      activePaneId: "pane-api",
      activeTabId: "tab-luna",
      layout: { mode: "auto", itemIds: ["container-api"] },
    };
    render(<NavigatorPanel onRenameNode={vi.fn()} snapshot={snapshot} workspaces={workspaces} groups={groups} />);

    expect(within(screen.getByRole("treeitem", { name: "Grupo Core" })).getByRole("button", { name: "Renomear" })).toBeInTheDocument();
    expect(within(screen.getByRole("treeitem", { name: "Projeto Terra API" })).getByRole("button", { name: "Renomear" })).toBeInTheDocument();
    expect(within(screen.getByRole("treeitem", { name: "Contêiner container-api" })).queryByRole("button", { name: "Renomear" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("treeitem", { name: "Painel pane-api" })).queryByRole("button", { name: "Renomear" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("treeitem", { name: "Agente luna-max" })).queryByRole("button", { name: "Renomear" })).not.toBeInTheDocument();
  });

  it("renders provider activities only when the host advertises them", async () => {
    const user = userEvent.setup();
    const onActivityChange = vi.fn();
    const loadGitStatus = vi.fn(async () => ({
      branch: "main",
      ahead: 0,
      behind: 0,
      staged: [],
      modified: [],
      untracked: [],
      conflicted: [],
    }));
    render(<NavigatorPanel availableActivities={["projects", "git"]} loadGitStatus={loadGitStatus} onActivityChange={onActivityChange} workspaces={workspaces} />);

    expect(screen.queryByRole("tab", { name: "Arquivos" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Git" }));
    expect(onActivityChange).toHaveBeenCalledWith("git");
  });

  it("loads and expands metadata-only files lazily for the selected project", async () => {
    const user = userEvent.setup();
    const onSelectWorkspace = vi.fn();
    const loadFiles = vi.fn(async (_workspaceId: string, relativePath: string) => relativePath === ""
      ? {
          path: "",
          entries: [{ name: "src", path: "src", kind: "directory" as const, size: null }],
          truncated: false,
          limit: 200,
        }
      : {
          path: "src",
          entries: [{ name: "main.ts", path: "src/main.ts", kind: "file" as const, size: 42 }],
          truncated: false,
          limit: 200,
        });
    render(<NavigatorPanel activeActivity="files" activeWorkspaceId="ws-api" availableActivities={["projects", "files"]} loadFiles={loadFiles} onOpenWorkspace={onSelectWorkspace} workspaces={workspaces} />);

    await waitFor(() => expect(screen.getByRole("button", { name: /src/ })).toBeInTheDocument());
    expect(loadFiles).toHaveBeenCalledWith("ws-api", "", 200);
    await user.click(screen.getByRole("button", { name: /src/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Abrir main\.ts/ })).toBeInTheDocument());
    expect(loadFiles).toHaveBeenLastCalledWith("ws-api", "src", 200);
    expect(screen.queryByText("fn main")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Abrir main\.ts/ }));
    expect(useEditorStore.getState().target).toEqual({ workspaceId: "ws-api", path: "src/main.ts" });
  });

  it("renders structured Git status and exposes refresh/project selection", async () => {
    const user = userEvent.setup();
    const onSelectWorkspace = vi.fn();
    const loadGitStatus = vi.fn(async () => ({
      branch: "feature/files",
      ahead: 1,
      behind: 2,
      staged: ["src/index.ts"],
      modified: ["README.md"],
      untracked: ["notes.txt"],
      conflicted: [],
    }));
    render(<NavigatorPanel activeActivity="git" activeWorkspaceId="ws-api" availableActivities={["projects", "git"]} loadGitStatus={loadGitStatus} onOpenWorkspace={onSelectWorkspace} workspaces={workspaces} />);

    await waitFor(() => expect(screen.getByText("feature/files")).toBeInTheDocument());
    expect(screen.getByText("src/index.ts")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Atualizar Git" }));
    expect(loadGitStatus).toHaveBeenCalledTimes(2);
  });

  it("keeps a clean Git status compact without repeated empty sections", async () => {
    const loadGitStatus = vi.fn(async () => ({
      branch: "main",
      ahead: 0,
      behind: 0,
      staged: [],
      modified: [],
      untracked: [],
      conflicted: [],
    }));
    render(<NavigatorPanel activeActivity="git" activeWorkspaceId="ws-api" availableActivities={["projects", "git"]} loadGitStatus={loadGitStatus} workspaces={workspaces} />);

    await waitFor(() => expect(screen.getByText("Árvore de trabalho limpa.")).toBeInTheDocument());
    expect(screen.queryByText("Nenhum arquivo")).not.toBeInTheDocument();
    expect(screen.queryByText("Conflitos")).not.toBeInTheDocument();
  });
});
