import { describe, expect, it } from "vitest";
import type { NotificationItem } from "../../domain/notification.model";
import type { WorkspaceSnapshotV2 } from "../../domain/workspace.model";
import { filterNotificationItemsForTarget } from "./notificationScope";

const items: NotificationItem[] = [
  { key: 1, terminalId: "term-a", workspaceId: "project-a", message: "A", ts: 1, isRead: false },
  { key: 2, terminalId: "term-b", workspaceId: "project-a", message: "B", ts: 2, isRead: false },
  { key: 3, terminalId: "term-c", workspaceId: "project-b", message: "C", ts: 3, isRead: false },
];

const snapshot: WorkspaceSnapshotV2 = {
  version: 2,
  projects: [],
  groups: [],
  containers: [{ id: "container-a", projectId: "project-a", paneIds: ["pane-a"], layout: { mode: "auto", itemIds: ["pane-a"] }, isVisible: true, isCollapsed: false, isClosed: false, isFullscreen: false }],
  panes: [{ id: "pane-a", projectId: "project-a", containerId: "container-a", tabIds: ["tab-a", "tab-b"], activeTabId: "tab-b", layout: { mode: "auto", itemIds: ["tab-a", "tab-b"] } }],
  tabs: [
    { id: "tab-a", paneId: "pane-a", ptyId: "term-a", command: "shell", cwd: "/tmp/a", width: null, title: "A", isOrphaned: false },
    { id: "tab-b", paneId: "pane-a", ptyId: "term-b", command: "shell", cwd: "/tmp/a", width: null, title: "B", isOrphaned: false },
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
  it("Given a focused terminal, when scoping notifications, then it wins over sibling project events", () => {
    expect(filterNotificationItemsForTarget(items, { workspaceId: "project-a", terminalId: "term-a" }).map((item) => item.key)).toEqual([1]);
  });

  it("Given active tab, pane or container targets, when scoping notifications, then they are projected back to their PTYs", () => {
    expect(filterNotificationItemsForTarget(items, { workspaceId: "project-a", snapshot }).map((item) => item.key)).toEqual([2]);
    expect(filterNotificationItemsForTarget(items, {
      workspaceId: "project-a",
      snapshot: { ...snapshot, activeTabId: null, panes: [{ ...snapshot.panes[0], activeTabId: null }], activePaneId: "pane-a" },
    }).map((item) => item.key)).toEqual([1, 2]);
  });

  it("Given no visual target, when scoping notifications, then it falls back to the project scope or stays empty", () => {
    expect(filterNotificationItemsForTarget(items, { workspaceId: "project-a" }).map((item) => item.key)).toEqual([1, 2]);
    expect(filterNotificationItemsForTarget(items, {}).map((item) => item.key)).toEqual([]);
  });
});
