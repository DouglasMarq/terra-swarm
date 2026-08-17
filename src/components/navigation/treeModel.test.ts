import { describe, expect, it } from "vitest";
import type { Workspace, WorkspaceGroup, WorkspaceSnapshotV2 } from "../../types";
import { buildNavigatorTree, filterNavigatorTree, flattenNavigatorTree, normalizeSearchText } from "./treeModel";
import { getDropProjection } from "./dropProjection";

function workspace(id: string, name: string, terminalIds: string[] = [], groupId: string | null = null): Workspace {
  return {
    id,
    name,
    cwd: `/tmp/${id}`,
    groupId,
    terminals: terminalIds.map((terminalId) => ({ id: terminalId, command: `luna ${terminalId}`, width: 100 })),
  };
}

function group(id: string, name: string, parentGroupId: string | null = null, projectIds: string[] = []): WorkspaceGroup {
  return { id, name, collapsed: false, projectIds, parentGroupId, layoutMode: "auto", suspended: false };
}

describe("navigator tree model", () => {
  const groups = [group("g-core", "Núcleo", null, ["p-one"]), group("g-labs", "Labs", "g-core", ["p-two"])] satisfies WorkspaceGroup[];
  const workspaces = [workspace("p-one", "Aplicação", ["a-one"], "g-core"), workspace("p-two", "Dados", ["a-two"], "g-labs"), workspace("p-three", "Sem grupo", ["a-three"])] satisfies Workspace[];

  it("builds group/subgroup/project/agent hierarchy and preserves ungrouped projects", () => {
    const tree = buildNavigatorTree(workspaces, { groups });
    expect(tree.roots.map((node) => node.id)).toEqual(["g-core", "p-three"]);
    expect(tree.byId["g-core"]?.children.map((node) => node.id)).toEqual(["g-labs", "p-one"]);
    expect(tree.byId["g-labs"]?.children.map((node) => node.id)).toEqual(["p-two"]);
    expect(tree.byId["p-two"]?.children.map((node) => node.id)).toEqual(["a-two"]);
    expect(tree.ungrouped.map((node) => node.id)).toEqual(["p-three"]);
  });

  it("flattens only expanded branches while retaining accessible depths", () => {
    const tree = buildNavigatorTree(workspaces, { groups });
    const flat = flattenNavigatorTree(tree, new Set(["g-core", "g-labs", "p-two"]));
    expect(flat.map((node) => [node.id, node.depth])).toEqual([
      ["g-core", 0], ["g-labs", 1], ["p-two", 2], ["a-two", 3], ["p-one", 1], ["p-three", 0],
    ]);
  });

  it("normalizes accents and keeps ancestors when filtering descendants", () => {
    expect(normalizeSearchText("  NúClÊo  ")).toBe("nucleo");
    const tree = filterNavigatorTree(buildNavigatorTree(workspaces, { groups }), "açãO");
    expect(tree.roots.map((node) => node.id)).toEqual(["g-core"]);
    expect(tree.byId["g-core"]?.children.map((node) => node.id)).toEqual(["p-one"]);
    expect(tree.byId["p-one"]?.children.map((node) => node.id)).toEqual(["a-one"]);
  });

  it("derives semantic status precedence from exited, notifications and context", () => {
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

  it("projects v2 containers and panes before terminal agents", () => {
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
        collapsed: false,
      }],
      groups: [],
      containers: [{
        id: "container-one",
        projectId: "p-one",
        paneIds: ["pane-one"],
        layout: { mode: "auto", itemIds: ["pane-one"] },
        visible: true,
        collapsed: false,
        closed: false,
        fullscreen: false,
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
        orphaned: false,
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
      [workspace("p-one", "Aplicação", ["agent-one"])],
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

describe("navigator drop projection", () => {
  const tree = buildNavigatorTree([workspace("p-one", "Aplicação", ["a-one", "a-two"]), workspace("p-two", "Dados", ["a-three"])]);
  const rect = { top: 100, bottom: 140, height: 40, left: 0 };

  it("projects before and after among siblings", () => {
    const before = getDropProjection({ activeId: "p-two", overId: "p-one", overRect: rect, pointerY: 105, nodes: tree });
    const after = getDropProjection({ activeId: "p-one", overId: "p-two", overRect: rect, pointerY: 135, nodes: tree });
    expect(before && { parentId: before.parentId, index: before.index, intent: before.intent }).toEqual({ parentId: null, index: 0, intent: "before" });
    expect(after && { parentId: after.parentId, index: after.index, intent: after.intent }).toEqual({ parentId: null, index: 1, intent: "after" });
  });

  it("projects inside only when the target accepts the dragged kind", () => {
    const insideProject = getDropProjection({ activeId: "a-three", overId: "p-one", overRect: rect, pointerY: 120, nodes: tree });
    const insideAgent = getDropProjection({ activeId: "a-one", overId: "a-three", overRect: rect, pointerY: 120, nodes: tree });
    expect(insideProject && { parentId: insideProject.parentId, intent: insideProject.intent }).toEqual({ parentId: "p-one", intent: "inside" });
    expect(insideAgent?.intent).toBe("after");
  });

  it("rejects dropping a node into its own descendant", () => {
    expect(getDropProjection({ activeId: "p-one", overId: "a-one", overRect: rect, pointerY: 120, nodes: tree })).toBeNull();
  });
});
