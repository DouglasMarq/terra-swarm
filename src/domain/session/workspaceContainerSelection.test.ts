import { describe, expect, it } from "vitest";
import type { Workspace, WorkspaceSnapshotV2 } from "../workspace.model";
import { selectWorkspaceContainerId } from "./workspaceContainerSelection";
import { defined } from "../../test/defined";

const workspace: Workspace = {
  id: "workspace-a",
  name: "A",
  cwd: "/a",
  activeContainerId: "container-b",
  terminals: [{ id: "pty-b", command: "luna", width: 80, paneId: "pane-b" }],
};

const snapshot: WorkspaceSnapshotV2 = {
  version: 2,
  projects: [
    {
      id: "workspace-a",
      name: "A",
      cwd: "/a",
      groupId: null,
      paneIds: ["pane-a", "pane-b"],
      containerIds: ["container-a", "container-b"],
      activePaneId: "pane-b",
      activeContainerId: "container-b",
      layout: { mode: "grid", itemIds: ["container-a", "container-b"] },
      collapsed: false,
    },
  ],
  groups: [],
  containers: [
    {
      id: "container-a",
      projectId: "workspace-a",
      paneIds: ["pane-a"],
      layout: { mode: "grid", itemIds: ["pane-a"] },
      visible: true,
      collapsed: false,
      closed: false,
      fullscreen: false,
    },
    {
      id: "container-b",
      projectId: "workspace-a",
      paneIds: ["pane-b"],
      activePaneId: "pane-b",
      layout: { mode: "grid", itemIds: ["pane-b"] },
      visible: true,
      collapsed: false,
      closed: false,
      fullscreen: false,
    },
  ],
  panes: [
    {
      id: "pane-a",
      projectId: "workspace-a",
      containerId: "container-a",
      tabIds: [],
      activeTabId: null,
      layout: { mode: "grid", itemIds: [] },
    },
    {
      id: "pane-b",
      projectId: "workspace-a",
      containerId: "container-b",
      tabIds: ["tab-b"],
      activeTabId: "tab-b",
      layout: { mode: "grid", itemIds: ["tab-b"] },
    },
  ],
  tabs: [
    {
      id: "tab-b",
      paneId: "pane-b",
      ptyId: "pty-b",
      command: "luna",
      cwd: "/a",
      width: 80,
      title: "",
      orphaned: false,
    },
  ],
  orphanedTabIds: [],
  activeProjectId: "workspace-a",
  activeGroupId: null,
  activeContainerId: "container-b",
  activePaneId: "pane-b",
  activeTabId: "tab-b",
  layout: { mode: "grid", itemIds: ["container-a", "container-b"] },
};

describe("selectWorkspaceContainerId", () => {
  it("uses the persisted active container instead of the first split", () => {
    expect(selectWorkspaceContainerId(snapshot, [workspace], "workspace-a")).toBe(
      "container-b",
    );
  });

  it("uses the focused terminal's pane when workspace metadata is stale", () => {
    expect(
      selectWorkspaceContainerId(
        {
          ...snapshot,
          activeContainerId: "container-a",
          projects: snapshot.projects.map((project) => ({
            ...project,
            activeContainerId: "container-a",
          })),
        },
        [{
          ...workspace,
          terminals: [{ ...defined(workspace.terminals[0]), paneId: null }],
        }],
        "workspace-a",
        { focusedTerminalId: "pty-b" },
      ),
    ).toBe("container-b");
  });
});
