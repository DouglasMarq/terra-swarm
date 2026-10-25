import { describe, expect, it } from "vitest";

import {
  mergeWorkspaceSnapshot,
  migrateLegacyWorkspaces,
  migrateWorkspacesToSnapshotV2,
  normalizeSnapshotV2,
} from "./migration";

describe("migrateLegacyWorkspaces", () => {
  it("maps each legacy workspace terminal to one project, container, pane, and tab", () => {
    const snapshot = migrateLegacyWorkspaces([
      {
        id: "ws-alpha",
        name: "Alpha",
        cwd: "/work/alpha",
        terminals: [
          { id: "pty-1", command: "codex", width: 60 },
          { id: "pty-2", command: "bash", width: null },
        ],
      },
      { id: "ws-beta", name: "Beta", cwd: "/work/beta", terminals: [] },
    ]);

    expect(snapshot.version).toBe(2);
    expect(snapshot.projects.map((project) => project.id)).toEqual(["ws-alpha", "ws-beta"]);
    expect(snapshot.projects[0]).toMatchObject({
      name: "Alpha",
      cwd: "/work/alpha",
      paneIds: ["pane-ws-alpha-1", "pane-ws-alpha-2"],
      containerIds: ["container-ws-alpha"],
    });
    expect(snapshot.containers[0]).toMatchObject({
      projectId: "ws-alpha",
      paneIds: ["pane-ws-alpha-1", "pane-ws-alpha-2"],
      visible: true,
      closed: false,
    });
    expect(snapshot.panes.map((pane) => pane.tabIds)).toEqual([["tab-ws-alpha-1"], ["tab-ws-alpha-2"]]);
    expect(snapshot.tabs).toMatchObject([
      {
        id: "tab-ws-alpha-1",
        paneId: "pane-ws-alpha-1",
        ptyId: "pty-1",
        command: "codex",
        cwd: "/work/alpha",
        orphaned: false,
      },
      {
        id: "tab-ws-alpha-2",
        paneId: "pane-ws-alpha-2",
        ptyId: "pty-2",
        command: "bash",
        orphaned: false,
      },
    ]);
    expect(snapshot.activeProjectId).toBe("ws-alpha");
    expect(snapshot.activePaneId).toBe("pane-ws-alpha-1");
    expect(snapshot.activeTabId).toBe("tab-ws-alpha-1");
  });

  it("Given legacy containers and panes with their own order, when migrating, then the source order, visibility and active ids are kept", () => {
    const snapshot = migrateLegacyWorkspaces([
      {
        id: "ws-split",
        name: "Split",
        cwd: "/work/split",
        activeContainerId: "c-right",
        activePaneId: "p-c",
        containers: [
          { id: "c-left", paneIds: ["p-b", "p-a"], activePaneId: "p-a" },
          { id: "c-right", visible: false, size: 30 },
        ],
        panes: [
          { id: "p-a", activeTabId: "t-a2", tabs: [{ id: "t-a2" }, { id: "t-a1" }] },
          { id: "p-b" },
          { id: "p-c", containerId: "c-right" },
        ],
        terminals: [
          { id: "pty-a1", command: "codex", paneId: "p-a", tabId: "t-a1" },
          { id: "pty-a2", command: "claude", paneId: "p-a", tabId: "t-a2" },
          { id: "pty-b", command: "bash", paneId: "p-b", tabId: "t-b", groupId: "group-1" },
          { id: "pty-c", command: "zsh", paneId: "p-c", tabId: "t-c" },
        ],
      },
    ]);

    expect(snapshot.projects[0]).toMatchObject({
      containerIds: ["c-left", "c-right"],
      activeContainerId: "c-right",
      activePaneId: "p-c",
      groupId: "group-1",
    });
    expect(snapshot.containers).toMatchObject([
      { id: "c-left", paneIds: ["p-b", "p-a"], activePaneId: "p-a", visible: true },
      { id: "c-right", paneIds: ["p-c"], activePaneId: "p-c", visible: false, closed: true, size: 30 },
    ]);
    expect(snapshot.panes.find((pane) => pane.id === "p-a")).toMatchObject({
      tabIds: ["t-a2", "t-a1"],
      activeTabId: "t-a2",
      containerId: "c-left",
    });
    expect(snapshot.tabs.find((tab) => tab.id === "t-b")).toMatchObject({
      paneId: "p-b",
      legacyWorkspaceId: "ws-split",
      orphaned: false,
    });
  });

  it("is deterministic and keeps the old workspace ids", () => {
    const legacy = [
      {
        id: "same",
        name: "One",
        cwd: "/one",
        terminals: [{ id: "one", command: "shell", width: 50 }],
      },
      {
        id: "same",
        name: "Two",
        cwd: "/two",
        terminals: [{ id: "two", command: "shell", width: 50 }],
      },
    ];

    const first = migrateLegacyWorkspaces(legacy);
    expect(first).toEqual(migrateWorkspacesToSnapshotV2(legacy));
    expect(first.projects.map((project) => project.id)).toEqual(["same", "same-2"]);
    expect(first.projects[1]?.containerIds[0]).toBe("container-same-2");
  });

  it("retains malformed and duplicate terminals as orphaned tabs", () => {
    const snapshot = migrateLegacyWorkspaces([
      {
        id: "ws-1",
        name: "Workspace",
        cwd: "/tmp/project",
        terminals: [
          { id: "dup", command: "first", width: null },
          { id: "dup", command: "second", width: 80 },
          { id: "", command: "missing id", width: null },
          null as never,
        ],
      },
    ]);

    expect(snapshot.tabs).toHaveLength(4);
    expect(snapshot.tabs[0]?.ptyId).toBe("dup");
    expect(snapshot.tabs.slice(1).every((tab) => tab.orphaned)).toBe(true);
    expect(snapshot.tabs.slice(1).map((tab) => tab.legacyTerminalId)).toEqual(["dup", undefined, undefined]);
    expect(snapshot.orphanedTabIds).toEqual([
      "tab-ws-1-2",
      "tab-ws-1-3",
      "tab-ws-1-4",
    ]);
    expect(snapshot.tabs.slice(1).map((tab) => tab.command)).toEqual([
      "second",
      "missing id",
      "",
    ]);
  });
});

describe("normalizeSnapshotV2", () => {
  it("repairs invalid references without silently dropping tabs", () => {
    const normalized = normalizeSnapshotV2({
      version: 2,
      projects: [
        {
          id: "project-1",
          name: "Project",
          cwd: "/project",
          groupId: "missing-group",
          paneIds: ["pane-1", "missing-pane", "pane-1"],
          containerIds: ["container-1", "missing-container"],
          activePaneId: "missing-pane",
          activeContainerId: "missing-container",
        },
      ],
      groups: [
        {
          id: "group-1",
          name: "Group",
          projectIds: ["project-1", "missing-project"],
          parentGroupId: "missing-parent",
          suspended: true,
        },
      ],
      containers: [
        {
          id: "container-1",
          projectId: "project-1",
          paneIds: ["pane-1", "missing-pane"],
          visible: false,
          closed: false,
        },
      ],
      panes: [
        {
          id: "pane-1",
          projectId: "project-1",
          containerId: "container-1",
          tabIds: ["tab-1", "missing-tab"],
          activeTabId: "missing-tab",
        },
      ],
      tabs: [
        { id: "tab-1", paneId: "pane-1", ptyId: "pty-1", command: "codex", cwd: "/project" },
        { id: "tab-orphan", paneId: "missing-pane", ptyId: "pty-orphan", command: "shell", cwd: "/project" },
      ],
      activeProjectId: "missing-project",
      activeContainerId: "missing-container",
      activePaneId: "missing-pane",
      activeTabId: "missing-tab",
    });

    expect(normalized.projects[0]).toMatchObject({
      groupId: null,
      paneIds: ["pane-1"],
      containerIds: ["container-1"],
      activePaneId: "pane-1",
      activeContainerId: "container-1",
    });
    expect(normalized.groups[0]).toMatchObject({
      projectIds: ["project-1"],
      parentGroupId: null,
      suspended: true,
    });
    expect(normalized.containers[0]).toMatchObject({
      visible: false,
      closed: true,
      paneIds: ["pane-1"],
    });
    expect(normalized.panes[0]?.activeTabId).toBe("tab-1");
    expect(normalized.tabs).toHaveLength(2);
    expect(normalized.tabs[1]).toMatchObject({
      id: "tab-orphan",
      paneId: null,
      ptyId: "pty-orphan",
      orphaned: true,
    });
    expect(normalized.orphanedTabIds).toEqual(["tab-orphan"]);
    expect(normalized.activeProjectId).toBe("project-1");
    expect(normalized.activePaneId).toBe("pane-1");
    expect(normalized.activeTabId).toBe("tab-1");
  });

  it("normalizes duplicate entity ids deterministically", () => {
    const normalized = normalizeSnapshotV2({
      version: 900,
      projects: [
        { id: "p", name: "First", paneIds: [], containerIds: [] },
        { id: "p", name: "Second", paneIds: [], containerIds: [] },
      ],
    });

    expect(normalized.projects.map((project) => project.id)).toEqual(["p", "p-2"]);
    expect(normalized).toEqual(normalizeSnapshotV2(normalized));
  });
});

describe("mergeWorkspaceSnapshot", () => {
  const sharedPaneWorkspaces = [
    {
      id: "workspace-shared",
      name: "Shared",
      cwd: "/shared",
      groupId: "group-agents",
      terminals: [
        {
          id: "pty-one",
          command: "luna --one",
          width: 80,
          paneId: "pane-main",
          tabId: "tab-one",
          groupId: "group-agents",
          suspended: true,
        },
        {
          id: "pty-two",
          command: "luna --two",
          width: 90,
          paneId: "pane-main",
          tabId: "tab-two",
          groupId: "group-agents",
        },
      ],
    },
  ];

  it("keeps stable pane/tab ids and makes an identical refresh idempotent", () => {
    const first = mergeWorkspaceSnapshot(sharedPaneWorkspaces, null);
    const refreshed = mergeWorkspaceSnapshot(sharedPaneWorkspaces, first);

    expect(first.panes).toHaveLength(1);
    expect(first.panes[0]).toMatchObject({
      id: "pane-main",
      tabIds: ["tab-one", "tab-two"],
      activeTabId: "tab-one",
    });
    expect(first.tabs.map((tab) => tab.id)).toEqual(["tab-one", "tab-two"]);
    expect((first.tabs[0] as typeof first.tabs[number] & { suspended?: boolean }).suspended).toBe(true);
    expect(refreshed).toEqual(first);
  });

  it("Given a previous orphan tab and a visibility override, when refreshing, then the orphan is kept and the container follows the override", () => {
    const first = mergeWorkspaceSnapshot(sharedPaneWorkspaces, null);
    const previous = {
      ...first,
      tabs: [...first.tabs, { ...first.tabs[0], id: "tab-orphan", ptyId: null, orphaned: true }],
      panes: first.panes.map((pane) => ({ ...pane, tabIds: [...pane.tabIds, "tab-orphan"] })),
    };
    const containerId = first.containers[0]?.id ?? "";

    const refreshed = mergeWorkspaceSnapshot(sharedPaneWorkspaces, previous, {
      containerVisibility: { [containerId]: false },
    });

    expect(refreshed.tabs.find((tab) => tab.id === "tab-orphan")).toMatchObject({ orphaned: true, ptyId: null });
    expect(refreshed.orphanedTabIds).toEqual(["tab-orphan"]);
    expect(refreshed.panes[0]?.tabIds).toEqual(["tab-one", "tab-two", "tab-orphan"]);
    expect(refreshed.containers[0]).toMatchObject({ id: containerId, visible: false, closed: true });
  });

  it("preserves visual active state and layout while removing a stale PTY", () => {
    const first = mergeWorkspaceSnapshot(sharedPaneWorkspaces, null);
    const visualState = {
      ...first,
      activePaneId: "pane-main",
      activeTabId: "tab-two",
      layout: { mode: "spotlight" as const, itemIds: first.containers.map((container) => container.id) },
      panes: first.panes.map((pane) => ({
        ...pane,
        activeTabId: "tab-two",
        layout: { mode: "horizontal" as const, itemIds: ["tab-one", "tab-two"] },
      })),
    };
    const refreshed = mergeWorkspaceSnapshot(
      [
        {
          ...sharedPaneWorkspaces[0],
          terminals: [sharedPaneWorkspaces[0].terminals[0]],
        },
      ],
      visualState,
    );

    expect(refreshed.tabs.map((tab) => tab.ptyId)).toEqual(["pty-one"]);
    expect(refreshed.tabs.some((tab) => tab.id === "tab-two")).toBe(false);
    expect(refreshed.activePaneId).toBe("pane-main");
    expect(refreshed.activeTabId).toBe("tab-one");
    expect(refreshed.layout.mode).toBe("spotlight");
    expect(refreshed.panes[0]?.layout.mode).toBe("horizontal");
  });

  it("uses nested pane/tab placement when terminal metadata comes from the backend envelope", () => {
    const snapshot = mergeWorkspaceSnapshot([
      {
        id: "workspace-nested",
        name: "Nested",
        cwd: "/nested",
        terminals: [
          { id: "pty-nested", command: "shell", width: null },
        ],
        panes: [
          {
            id: "pane-nested",
            activeTabId: "tab-nested",
            tabs: [{ id: "tab-nested", ptyId: "pty-nested" }],
          },
        ],
      },
    ], null);

    expect(snapshot.panes[0]).toMatchObject({
      id: "pane-nested",
      tabIds: ["tab-nested"],
      activeTabId: "tab-nested",
    });
    expect(snapshot.tabs[0]).toMatchObject({ id: "tab-nested", paneId: "pane-nested" });
  });
});
