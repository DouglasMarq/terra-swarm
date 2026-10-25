import { describe, expect, it } from "vitest";
import type { Workspace, WorkspaceGroup, WorkspaceSnapshotV2 } from "../../domain/workspace.model";
import { buildNavigatorTree, filterNavigatorTree, flattenNavigatorTree } from "./treeModel";
import { normalizeSearchText } from "../../lib/text/normalizeSearchText";

interface WorkspacePlacement {
  terminalIds?: string[];
  groupId?: string | null;
}

function workspace(id: string, name: string, { terminalIds = [], groupId = null }: WorkspacePlacement = {}): Workspace {
  return {
    id,
    name,
    cwd: `/tmp/${id}`,
    groupId,
    terminals: terminalIds.map((terminalId) => ({ id: terminalId, command: `luna ${terminalId}`, width: 100 })),
  };
}

interface GroupPlacement {
  parentGroupId?: string | null;
  projectIds?: string[];
}

function group(id: string, name: string, { parentGroupId = null, projectIds = [] }: GroupPlacement = {}): WorkspaceGroup {
  return { id, name, isCollapsed: false, projectIds, parentGroupId, layoutMode: "auto", isSuspended: false };
}

describe("navigator tree model", () => {
  const groups = [group("g-core", "Núcleo", { projectIds: ["p-one"] }), group("g-labs", "Labs", { parentGroupId: "g-core", projectIds: ["p-two"] })] satisfies WorkspaceGroup[];
  const workspaces = [workspace("p-one", "Aplicação", { terminalIds: ["a-one"], groupId: "g-core" }), workspace("p-two", "Dados", { terminalIds: ["a-two"], groupId: "g-labs" }), workspace("p-three", "Sem grupo", { terminalIds: ["a-three"] })] satisfies Workspace[];

  it("Given groups, subgroups and ungrouped projects, when building the tree, then the hierarchy is built and ungrouped projects are kept", () => {
    const tree = buildNavigatorTree(workspaces, { groups });
    expect(tree.roots.map((node) => node.id)).toEqual(["g-core", "p-three"]);
    expect(tree.byId["g-core"]?.children.map((node) => node.id)).toEqual(["g-labs", "p-one"]);
    expect(tree.byId["g-labs"]?.children.map((node) => node.id)).toEqual(["p-two"]);
    expect(tree.byId["p-two"]?.children.map((node) => node.id)).toEqual(["a-two"]);
    expect(tree.ungrouped.map((node) => node.id)).toEqual(["p-three"]);
  });

  it("Given a tree, when flattening it, then only expanded branches are kept with accessible depths", () => {
    const tree = buildNavigatorTree(workspaces, { groups });
    const flat = flattenNavigatorTree(tree, new Set(["g-core", "g-labs", "p-two"]));
    expect(flat.map((node) => [node.id, node.depth])).toEqual([
      ["g-core", 0], ["g-labs", 1], ["p-two", 2], ["a-two", 3], ["p-one", 1], ["p-three", 0],
    ]);
  });

  it("Given a filter with accents, when filtering descendants, then accents are normalized and ancestors are kept", () => {
    expect(normalizeSearchText("  NúClÊo  ")).toBe("nucleo");
    const tree = filterNavigatorTree(buildNavigatorTree(workspaces, { groups }), "açãO");
    expect(tree.roots.map((node) => node.id)).toEqual(["g-core"]);
    expect(tree.byId["g-core"]?.children.map((node) => node.id)).toEqual(["p-one"]);
    expect(tree.byId["p-one"]?.children.map((node) => node.id)).toEqual(["a-one"]);
  });

  it("Given exited, notification and context signals, when deriving the status, then the semantic precedence applies", () => {
    const tree = buildNavigatorTree(workspaces, {
      groups,
      exited: { "a-two": 1 },
      notifications: { "a-one": 2 },
      contextUsage: { "a-three": 91 },
    });
    expect(tree.byId["a-one"]?.status).toBe("attention");
    expect(tree.byId["a-two"]?.status).toBe("exited");
    expect(tree.byId["a-three"]?.status).toBe("attention");
  });

  it("Given v2 containers and panes, when building the tree, then they are projected before terminal agents", () => {
    const snapshot: WorkspaceSnapshotV2 = {
      version: 2,
      projects: [{
        id: "p-one",
        name: "Aplicação",
        cwd: "/tmp/p-one",
        groupId: null,
        paneIds: ["pane-one"],
        containerIds: ["container-one"],
        activePaneId: "pane-one",
        activeContainerId: "container-one",
        layout: { mode: "auto", itemIds: ["container-one"] },
        isCollapsed: false,
      }],
      groups: [],
      containers: [{
        id: "container-one",
        projectId: "p-one",
        paneIds: ["pane-one"],
        layout: { mode: "auto", itemIds: ["pane-one"] },
        isVisible: true,
        isCollapsed: false,
        isClosed: false,
        isFullscreen: false,
      }],
      panes: [{
        id: "pane-one",
        projectId: "p-one",
        containerId: "container-one",
        tabIds: ["tab-one"],
        activeTabId: "tab-one",
        layout: { mode: "auto", itemIds: ["tab-one"] },
      }],
      tabs: [{
        id: "tab-one",
        paneId: "pane-one",
        ptyId: "agent-one",
        command: "luna-max",
        cwd: "/tmp/p-one",
        width: 100,
        title: "Luna Max",
        isOrphaned: false,
      }],
      orphanedTabIds: [],
      activeProjectId: "p-one",
      activeGroupId: null,
      activeContainerId: "container-one",
      activePaneId: "pane-one",
      activeTabId: "tab-one",
      layout: { mode: "auto", itemIds: ["container-one"] },
    };
    const tree = buildNavigatorTree(
      [workspace("p-one", "Aplicação", { terminalIds: ["agent-one"] })],
      { snapshot },
    );
    const project = tree.byId["p-one"];
    expect(project?.children.map((node) => node.kind)).toEqual(["container"]);
    expect(project?.children[0]?.children.map((node) => node.kind)).toEqual(["pane"]);
    expect(project?.children[0]?.children[0]?.children.map((node) => node.kind)).toEqual(["agent"]);
    expect(tree.byId["tab-one"]?.kind).toBe("agent");
    expect(tree.byId["agent-one"]?.kind).toBe("agent");
  });
});
