import { describe, expect, it } from "vitest";
import type { NotificationItem } from "../../domain/notification.model";
import type { WorkspaceSnapshotV2 } from "../../domain/workspace.model";
import { filterNotificationItemsForTarget } from "./notificationScope";

const items: NotificationItem[] = [
  { key: 1, terminalId: "term-a", workspaceId: "project-a", message: "A", ts: 1, read: false },
  { key: 2, terminalId: "term-b", workspaceId: "project-a", message: "B", ts: 2, read: false },
  { key: 3, terminalId: "term-c", workspaceId: "project-b", message: "C", ts: 3, read: false },
];

const snapshot: WorkspaceSnapshotV2 = {
  version: 2,
  projects: [],
  groups: [],
  containers: [{ id: "container-a", projectId: "project-a", paneIds: ["pane-a"], layout: { mode: "auto", itemIds: ["pane-a"] }, visible: true, collapsed: false, closed: false, fullscreen: false }],
  panes: [{ id: "pane-a", projectId: "project-a", containerId: "container-a", tabIds: ["tab-a", "tab-b"], activeTabId: "tab-b", layout: { mode: "auto", itemIds: ["tab-a", "tab-b"] } }],
  tabs: [
    { id: "tab-a", paneId: "pane-a", ptyId: "term-a", command: "shell", cwd: "/tmp/a", width: null, title: "A", orphaned: false },
    { id: "tab-b", paneId: "pane-a", ptyId: "term-b", command: "shell", cwd: "/tmp/a", width: null, title: "B", orphaned: false },
  ],
  orphanedTabIds: [],
  activeProjectId: "project-a",
  activeGroupId: null,
  activeContainerId: "container-a",
  activePaneId: "pane-a",
  activeTabId: "tab-b",
  layout: { mode: "auto", itemIds: ["container-a"] },
};

describe("notification scope", () => {
  it("prefers the focused terminal over sibling project events", () => {
    expect(filterNotificationItemsForTarget(items, { workspaceId: "project-a", terminalId: "term-a" }).map((item) => item.key)).toEqual([1]);
  });

  it("projects active tab/pane/container targets back to their PTYs", () => {
    expect(filterNotificationItemsForTarget(items, { workspaceId: "project-a", snapshot }).map((item) => item.key)).toEqual([2]);
    expect(filterNotificationItemsForTarget(items, {
      workspaceId: "project-a",
      snapshot: { ...snapshot, activeTabId: null, panes: [{ ...snapshot.panes[0], activeTabId: null }], activePaneId: "pane-a" },
    }).map((item) => item.key)).toEqual([1, 2]);
  });

  it("falls back to project scope and stays empty without a target", () => {
    expect(filterNotificationItemsForTarget(items, { workspaceId: "project-a" }).map((item) => item.key)).toEqual([1, 2]);
    expect(filterNotificationItemsForTarget(items, {}).map((item) => item.key)).toEqual([]);
  });
});
