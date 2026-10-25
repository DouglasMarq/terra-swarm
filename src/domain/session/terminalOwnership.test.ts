import { describe, expect, it } from "vitest";
import type { Workspace, WorkspaceSnapshotV2 } from "../workspace.model";
import { containerFixture, paneFixture, projectFixture, snapshotFixture, tabFixture } from "../../test/snapshotFixtures";
import { neighborTerminalId, workspaceIdForTerminal } from "./terminalOwnership";

const workspace = (id: string, terminalId: string): Workspace => ({
  id,
  name: id,
  cwd: `/tmp/${id}`,
  terminals: [{ id: terminalId, command: "luna-max", width: 120 }],
});

describe("workspaceIdForTerminal", () => {
  it("Given a terminal outside the active workspace, when resolving its owner, then current workspace state is used", () => {
    const owner = workspaceIdForTerminal(
      [workspace("project-a", "terminal-a"), workspace("project-b", "terminal-b")],
      null,
      "terminal-b",
    );

    expect(owner).toBe("project-b");
  });

  it("Given missing legacy metadata, when resolving the owner, then it falls back to the current orchestration snapshot", () => {
    const snapshot: WorkspaceSnapshotV2 = {
      version: 2,
      projects: [{
        id: "project-b",
        name: "Project B",
        cwd: "/tmp/project-b",
        groupId: null,
        paneIds: ["pane-b"],
        containerIds: ["container-b"],
        activePaneId: "pane-b",
        activeContainerId: "container-b",
        layout: { mode: "auto", itemIds: ["container-b"] },
        isCollapsed: false,
      }],
      groups: [],
      containers: [{
        id: "container-b",
        projectId: "project-b",
        paneIds: ["pane-b"],
        layout: { mode: "auto", itemIds: ["pane-b"] },
        isVisible: true,
        isCollapsed: false,
        isClosed: false,
        isFullscreen: false,
      }],
      panes: [{
        id: "pane-b",
        projectId: "project-b",
        containerId: "container-b",
        tabIds: ["tab-b"],
        activeTabId: "tab-b",
        layout: { mode: "auto", itemIds: ["tab-b"] },
      }],
      tabs: [{
        id: "tab-b",
        paneId: "pane-b",
        ptyId: "terminal-b",
        command: "luna-max",
        cwd: "/tmp/project-b",
        width: 120,
        title: "Luna Max",
        isOrphaned: false,
      }],
      orphanedTabIds: [],
      activeProjectId: "project-b",
      activeGroupId: null,
      activeContainerId: "container-b",
      activePaneId: "pane-b",
      activeTabId: "tab-b",
      layout: { mode: "auto", itemIds: ["container-b"] },
    };

    expect(workspaceIdForTerminal([], snapshot, "terminal-b")).toBe("project-b");
  });

  it("Given no snapshot entry for the terminal, when resolving its owner, then there is none", () => {
    expect(workspaceIdForTerminal([], null, "ghost")).toBeNull();
    expect(workspaceIdForTerminal([], snapshotFixture({ tabs: [tabFixture("tab-1", "pty-1")] }), "ghost")).toBeNull();
  });

  it("Given a tab with its legacy workspace, when resolving by tab or legacy id, then the legacy workspace is used", () => {
    const snapshot = snapshotFixture({ tabs: [tabFixture("tab-1", null, { legacyTerminalId: "old-1", legacyWorkspaceId: "ws-old" })] });

    expect(workspaceIdForTerminal([], snapshot, "old-1")).toBe("ws-old");
    expect(workspaceIdForTerminal([], snapshot, "tab-1")).toBe("ws-old");
  });

  it("Given a pane without a project, when resolving its tab, then the owning container's project is used", () => {
    const snapshot = snapshotFixture({
      tabs: [tabFixture("tab-1", "pty-1")],
      panes: [paneFixture("pane-1", [], { projectId: null, containerId: null, activeTabId: "tab-1" })],
      containers: [containerFixture("c1", ["pane-1"], { projectId: "p-container" })],
    });

    expect(workspaceIdForTerminal([], snapshot, "pty-1")).toBe("p-container");
  });

  it("Given neither pane nor container know the project, when resolving, then the project listing them is used", () => {
    const tabs = [tabFixture("tab-1", "pty-1", { paneId: "pane-1" })];
    const panes = [paneFixture("pane-1", [], { projectId: null, containerId: "c1" })];
    const containers = [containerFixture("c1", [], { projectId: null })];

    expect(workspaceIdForTerminal([], snapshotFixture({ tabs, panes, containers, projects: [projectFixture("by-container", { containerIds: ["c1"] })] }), "pty-1")).toBe("by-container");
    expect(workspaceIdForTerminal([], snapshotFixture({ tabs, panes, containers: [], projects: [projectFixture("by-pane", { paneIds: ["pane-1"] })] }), "pty-1")).toBe("by-pane");
    expect(workspaceIdForTerminal([], snapshotFixture({ tabs, projects: [projectFixture("unrelated")] }), "pty-1")).toBeNull();
  });
});

describe("neighborTerminalId", () => {
  const project: Workspace = {
    id: "ws-n",
    name: "ws-n",
    cwd: "/tmp/ws-n",
    terminals: [
      { id: "first", command: "claude", width: null },
      { id: "second", command: "codex", width: null },
    ],
  };

  it("Given a terminal with a previous sibling, when finding its neighbor, then the previous one is chosen", () => {
    expect(neighborTerminalId([project], "second")).toBe("first");
  });

  it("Given the first terminal, when finding its neighbor, then the next one is chosen", () => {
    expect(neighborTerminalId([project], "first")).toBe("second");
  });

  it("Given a terminal that no project owns, when finding its neighbor, then there is none", () => {
    expect(neighborTerminalId([project], "unknown")).toBeNull();
  });

  it("Given the only terminal, when finding its neighbor, then there is none", () => {
    expect(neighborTerminalId([workspace("solo", "alone")], "alone")).toBeNull();
  });
});
