import { describe, expect, it } from "vitest";

import { migrateLegacyWorkspaces } from "./migration/legacyMigration";
import { normalizeSnapshotV2 } from "./migration/snapshotNormalize";
import {
  getActiveContainer,
  getActivePane,
  getActiveTab,
  getGroupPtyIds,
  getOrphanedTabs,
  isContainerVisible,
  selectActivePane,
  selectGroupProjectIds,
  selectPaneTabs,
  selectProjectPtyIds,
  shouldTerminatePtyWhenContainerCloses,
} from "./selectors";

describe("orchestration selectors", () => {
  it("resolves active pane and tab without requiring React state", () => {
    const snapshot = migrateLegacyWorkspaces([
      {
        id: "project-a",
        name: "A",
        cwd: "/a",
        terminals: [
          { id: "pty-a-1", command: "codex", width: null },
          { id: "pty-a-2", command: "shell", width: null },
        ],
      },
    ]);

    const pane = getActivePane(snapshot);
    expect(pane?.id).toBe("pane-project-a-1");
    expect(getActiveTab(snapshot)?.ptyId).toBe("pty-a-1");
    expect(selectActivePane(snapshot, "container-project-a")?.id).toBe("pane-project-a-1");
    expect(selectActivePane(snapshot, "project-a")?.id).toBe("pane-project-a-1");
    expect(selectPaneTabs(snapshot, "pane-project-a-1").map((tab) => tab.id)).toEqual([
      "tab-project-a-1",
    ]);
  });

  it("collects all group PTYs, including descendant groups, regardless of visibility", () => {
    const snapshot = normalizeSnapshotV2({
      version: 2,
      projects: [
        { id: "p1", name: "P1", cwd: "/p1", groupId: "root", paneIds: ["pane-1"] },
        { id: "p2", name: "P2", cwd: "/p2", groupId: "child", paneIds: ["pane-2"] },
      ],
      groups: [
        { id: "root", name: "Root", projectIds: ["p1"], parentGroupId: null },
        { id: "child", name: "Child", projectIds: ["p2"], parentGroupId: "root", suspended: true },
      ],
      containers: [
        { id: "c1", projectId: "p1", paneIds: ["pane-1"], visible: false },
        { id: "c2", projectId: "p2", paneIds: ["pane-2"], visible: true },
      ],
      panes: [
        { id: "pane-1", projectId: "p1", containerId: "c1", tabIds: ["tab-1"], activeTabId: "tab-1" },
        { id: "pane-2", projectId: "p2", containerId: "c2", tabIds: ["tab-2"], activeTabId: "tab-2" },
      ],
      tabs: [
        { id: "tab-1", paneId: "pane-1", ptyId: "pty-1", command: "one", cwd: "/p1" },
        { id: "tab-2", paneId: "pane-2", ptyId: "pty-2", command: "two", cwd: "/p2" },
      ],
    });

    expect(selectGroupProjectIds(snapshot, "root")).toEqual(["p1", "p2"]);
    expect(selectProjectPtyIds(snapshot, "p1")).toEqual(["pty-1"]);
    expect(getGroupPtyIds(snapshot, "root")).toEqual(["pty-1", "pty-2"]);
    expect(isContainerVisible(snapshot.containers[0])).toBe(false);
    expect(shouldTerminatePtyWhenContainerCloses()).toBe(false);
  });

  it("exposes retained orphan tabs for recovery UI", () => {
    const snapshot = normalizeSnapshotV2({
      version: 2,
      tabs: [
        { id: "orphan", paneId: "gone", ptyId: "pty-orphan", command: "shell", cwd: "/tmp" },
      ],
    });

    expect(getOrphanedTabs(snapshot).map((tab) => tab.id)).toEqual(["orphan"]);
    expect(getActiveContainer(snapshot)).toBeNull();
    expect(getActivePane(snapshot)).toBeNull();
  });
});
