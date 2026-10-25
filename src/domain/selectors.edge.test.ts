import { describe, expect, it } from "vitest";
import type { WorkspaceSnapshotV2 } from "./workspace.model";
import {
  getActiveContainer,
  getActiveTab,
  getGroupPtyIds,
  getOrphanedTabs,
  isContainerVisible,
  selectActivePane,
  selectGroupProjectIds,
  selectPaneTabs,
  selectProjectPtyIds,
} from "./selectors";
import { containerFixture as container, groupFixture as group, paneFixture as pane, projectFixture as project, snapshotFixture, tabFixture as tab } from "../test/snapshotFixtures";

function snapshotWith(overrides: Partial<WorkspaceSnapshotV2> = {}): WorkspaceSnapshotV2 {
  return snapshotFixture({
    projects: [
      project("p1", { paneIds: ["pane-1", "pane-2"], containerIds: ["c1", "c2"] }),
      project("p2", { paneIds: ["pane-3"], containerIds: ["c3"] }),
      project("empty"),
    ],
    containers: [container("c1", ["pane-1"]), container("c2", ["pane-2"]), container("c3", ["pane-3"], { projectId: "p2" }), container("hollow", ["pane-gone"])],
    panes: [
      pane("pane-1", ["tab-1", "tab-2"]),
      pane("pane-2", ["tab-3"], { containerId: "c2" }),
      pane("pane-3", ["tab-4"], { projectId: "p2", containerId: "c3" }),
      pane("pane-bare", [], { projectId: null, containerId: null }),
    ],
    tabs: [tab("tab-1", "pty-1"), tab("tab-2", null), tab("tab-3", "pty-1"), tab("tab-4", "pty-4")],
    ...overrides,
  });
}

describe("orchestration selectors at the edges", () => {
  it("Given a scope, when selecting the active pane, then pane, container and project scopes resolve and unknown ones do not", () => {
    const snapshot = snapshotWith({
      projects: [project("p1", { paneIds: ["pane-1", "pane-2"], activePaneId: "pane-2" }), project("p2", { paneIds: ["pane-gone", "pane-3"] }), project("empty")],
    });

    expect(selectActivePane(snapshot, "c2")?.id).toBe("pane-2");
    expect(selectActivePane(snapshot, "hollow")).toBeNull();
    expect(selectActivePane(snapshot, "p1")?.id).toBe("pane-2");
    expect(selectActivePane(snapshot, "p2")?.id).toBe("pane-3");
    expect(selectActivePane(snapshot, "empty")).toBeNull();
    expect(selectActivePane(snapshot, "nowhere")).toBeNull();
  });

  it("Given no scope, when selecting the active pane, then the active container and then the active project are used", () => {
    expect(selectActivePane(snapshotWith({ activeContainerId: "c2" }))?.id).toBe("pane-2");
    expect(selectActivePane(snapshotWith({ activeContainerId: "hollow" }))).toBeNull();
    expect(selectActivePane(snapshotWith({ activeProjectId: "p2" }))?.id).toBe("pane-3");
    expect(selectActivePane(snapshotWith())).toBeNull();
  });

  it("Given a pane scope, when selecting the active tab, then the pane's tab, the snapshot's tab or the first tab is picked", () => {
    const withPaneTab = snapshotWith({ panes: [pane("pane-1", ["tab-1", "tab-2"], { activeTabId: "tab-2" })] });
    expect(getActiveTab(withPaneTab, "pane-1")?.id).toBe("tab-2");

    expect(getActiveTab(snapshotWith({ activeTabId: "tab-2" }), "c1")?.id).toBe("tab-2");
    expect(getActiveTab(snapshotWith({ activeTabId: "tab-4" }), "pane-1")?.id).toBe("tab-1");
    expect(getActiveTab(snapshotWith(), "pane-bare")).toBeNull();
    expect(getActiveTab(snapshotWith(), "hollow")).toBeNull();
    expect(getActiveTab(snapshotWith(), "nowhere")).toBeNull();
    expect(getActiveTab(snapshotWith({ activePaneId: "pane-3" }))?.id).toBe("tab-4");
  });

  it("Given an unknown pane, when listing its tabs, then none are returned", () => {
    expect(selectPaneTabs(snapshotWith(), "nowhere")).toEqual([]);
  });

  it("Given groups with repeated and missing projects, when listing a group's projects, then each existing project appears once", () => {
    const snapshot = snapshotWith({ groups: [group("root", ["p1", "ghost"]), group("child", ["p1", "p2"], "root"), group("other", ["empty"])] });

    expect(selectGroupProjectIds(snapshot, "root")).toEqual(["p1", "p2"]);
  });

  it("Given tabs without a pty and ptys shared across panes, when listing a project's ptys, then each pty appears once", () => {
    const snapshot = snapshotWith({ groups: [group("root", ["p1", "p2"])], tabs: [tab("tab-1", "pty-1"), tab("tab-2", null), tab("tab-3", "pty-1"), tab("tab-4", "pty-1")] });

    expect(selectProjectPtyIds(snapshot, "p1")).toEqual(["pty-1"]);
    expect(selectProjectPtyIds(snapshot, "nowhere")).toEqual([]);
    expect(getGroupPtyIds(snapshot, "root")).toEqual(["pty-1"]);
  });

  it("Given tabs flagged or listed as orphans, when selecting orphans, then both kinds are returned", () => {
    const snapshot = snapshotWith({ tabs: [tab("tab-1", "pty-1", { isOrphaned: true }), tab("tab-2", null)], orphanedTabIds: ["tab-2"] });

    expect(getOrphanedTabs(snapshot).map((item) => item.id)).toEqual(["tab-1", "tab-2"]);
  });

  it("Given missing, closed or hidden containers, when checking visibility, then only open visible ones count", () => {
    expect(isContainerVisible(null)).toBe(false);
    expect(isContainerVisible(container("closed", [], { isClosed: true }))).toBe(false);
    expect(isContainerVisible(container("hidden", [], { isVisible: false }))).toBe(false);
    expect(isContainerVisible(container("open", []))).toBe(true);
  });

  it("Given the active ids, when selecting the active container, then the snapshot's, the project's or the project's first container is used", () => {
    expect(getActiveContainer(snapshotWith({ activeContainerId: "c2" }))?.id).toBe("c2");
    expect(getActiveContainer(snapshotWith({ projects: [project("p1", { containerIds: ["c1", "c2"], activeContainerId: "c2" })] }))?.id).toBe("c2");
    expect(getActiveContainer(snapshotWith({ activeProjectId: "p2" }))?.id).toBe("c3");
    expect(getActiveContainer(snapshotWith({ activeProjectId: "empty", projects: [project("empty")] }))).toBeNull();
  });
});
