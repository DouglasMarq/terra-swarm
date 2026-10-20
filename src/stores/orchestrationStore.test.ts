import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../types";

const workspaceApiMock = vi.hoisted(() => ({
  listWorkspaces: vi.fn(() => Promise.resolve([] as Workspace[])),
  listGroups: vi.fn(() => Promise.resolve([])),
  setWorkspaceContainerState: vi.fn(() => Promise.resolve()),
  reorderWorkspaceContainers: vi.fn(() => Promise.resolve()),
  reorderWorkspacePanes: vi.fn(() => Promise.resolve()),
  moveWorkspacePane: vi.fn(() => Promise.resolve()),
  setWorkspaceLayout: vi.fn(() => Promise.resolve()),
  setWorkspaceCollapsed: vi.fn(() => Promise.resolve()),
  setActivePane: vi.fn(() => Promise.resolve()),
}));

vi.mock("../lib/tauri/workspace", () => ({ workspaceApi: workspaceApiMock }));
import {
  ORCHESTRATION_STORAGE_KEY,
  useOrchestrationStore,
} from "./orchestrationStore";

const workspaces: Workspace[] = [
  {
    id: "workspace-a",
    name: "A",
    cwd: "/a",
    groupId: "group-a",
    terminals: [{ id: "pty-a", command: "codex", width: 50 }],
  },
  {
    id: "workspace-b",
    name: "B",
    cwd: "/b",
    terminals: [],
  },
];

afterEach(() => {
  vi.clearAllMocks();
  useOrchestrationStore.getState().reset();
  try {
    localStorage.removeItem(ORCHESTRATION_STORAGE_KEY);
  } catch {
    // Vitest's default environment has no localStorage.
  }
});

describe("orchestration store", () => {
  it("derives a v2 snapshot from legacy workspaces and preserves group membership", () => {
    useOrchestrationStore.getState().sync(workspaces, [
      {
        id: "group-a",
        name: "Agents",
        projectIds: [],
        parentGroupId: null,
        collapsed: false,
        suspended: false,
      },
    ]);

    const state = useOrchestrationStore.getState();
    expect(state.snapshot?.version).toBe(2);
    expect(state.snapshot?.projects[0]?.groupId).toBe("group-a");
    expect(state.groups[0]).toMatchObject({
      id: "group-a",
      projectIds: ["workspace-a"],
    });
  });

  it("closes a container without removing its PTY tab", () => {
    useOrchestrationStore.getState().sync(workspaces);
    const containerId = useOrchestrationStore.getState().snapshot?.containers[0]?.id;
    expect(containerId).toBeTruthy();
    useOrchestrationStore.getState().closeContainer(containerId!);

    const state = useOrchestrationStore.getState();
    expect(state.containerVisibility[containerId!]).toBe(false);
    expect(state.snapshot?.containers[0]?.closed).toBe(true);
    expect(state.snapshot?.tabs[0]?.ptyId).toBe("pty-a");

    useOrchestrationStore.getState().openContainer(containerId!);
    expect(useOrchestrationStore.getState().snapshot?.containers[0]?.visible).toBe(true);
  });

  it("persists feature flags and group suspension metadata", () => {
    useOrchestrationStore.getState().sync(workspaces, [
      {
        id: "group-a",
        name: "Agents",
        projectIds: ["workspace-a"],
        parentGroupId: null,
        collapsed: false,
        suspended: false,
      },
    ]);
    useOrchestrationStore.getState().setFeatureFlag("voiceCommands", true);
    useOrchestrationStore.getState().setGroupSuspended("group-a", true);

    const state = useOrchestrationStore.getState();
    expect(state.flags.voiceCommands).toBe(true);
    expect(state.groups[0]?.suspended).toBe(true);
    expect(state.snapshot?.groups[0]?.suspended).toBe(true);
  });

  it("persists visual detachments without removing the terminal identity", () => {
    useOrchestrationStore.getState().sync(workspaces);
    useOrchestrationStore.getState().detachTerminal("pty-a");

    expect(useOrchestrationStore.getState().detachedTerminalIds).toEqual(["pty-a"]);
    expect(useOrchestrationStore.getState().snapshot?.tabs[0]?.ptyId).toBe("pty-a");

    useOrchestrationStore.getState().reattachTerminal("pty-a");
    expect(useOrchestrationStore.getState().detachedTerminalIds).toEqual([]);
  });

  it("persists visual layout mutations through the backend contract", () => {
    const source: Workspace[] = [
      {
        id: "workspace-layout",
        name: "Layout",
        cwd: "/layout",
        terminals: [
          { id: "pty-one", command: "one", width: 80, paneId: "pane-one", tabId: "tab-one" },
          { id: "pty-two", command: "two", width: 80, paneId: "pane-two", tabId: "tab-two" },
        ],
      },
    ];
    useOrchestrationStore.getState().sync(source);
    const containerId = useOrchestrationStore.getState().snapshot?.containers[0]?.id;
    expect(containerId).toBe("container-workspace-layout");

    useOrchestrationStore.getState().setContainerState(containerId!, {
      collapsed: true,
      activePaneId: "pane-two",
      internalLayout: "vertical",
      size: 42,
    });
    useOrchestrationStore.getState().reorderPanes(containerId!, ["pane-two", "pane-one"]);
    useOrchestrationStore.getState().setWorkspaceLayout("workspace-layout", {
      mode: "spotlight",
      itemIds: [containerId!],
      metadata: { surface: "workbench" },
    });
    useOrchestrationStore.getState().setWorkspaceCollapsed("workspace-layout", true);

    const state = useOrchestrationStore.getState();
    expect(state.snapshot?.containers[0]).toMatchObject({
      id: containerId,
      paneIds: ["pane-two", "pane-one"],
      collapsed: true,
      activePaneId: "pane-two",
      internalLayout: "vertical",
      size: 42,
    });
    expect(state.snapshot).toMatchObject({
      activeContainerId: containerId,
      activePaneId: "pane-two",
      projects: [
        expect.objectContaining({
          id: "workspace-layout",
          activeContainerId: containerId,
          activePaneId: "pane-two",
        }),
      ],
    });
    expect(state.snapshot?.projects[0]).toMatchObject({
      id: "workspace-layout",
      collapsed: true,
      layout: { mode: "spotlight", metadata: { surface: "workbench" } },
    });
    expect(workspaceApiMock.setWorkspaceContainerState).toHaveBeenCalled();
    expect(workspaceApiMock.reorderWorkspacePanes).toHaveBeenCalledWith(
      "workspace-layout",
      containerId,
      ["pane-two", "pane-one"],
    );
    expect(workspaceApiMock.setWorkspaceLayout).toHaveBeenCalledWith(
      "workspace-layout",
      expect.objectContaining({ mode: "spotlight" }),
    );
  });

  it("rejects a pane move across projects before IPC or optimistic state", () => {
    const source: Workspace[] = [
      {
        id: "workspace-a",
        name: "A",
        cwd: "/a",
        terminals: [{ id: "pty-a", command: "one", width: 80, paneId: "pane-a", tabId: "tab-a" }],
      },
      {
        id: "workspace-b",
        name: "B",
        cwd: "/b",
        terminals: [{ id: "pty-b", command: "two", width: 80, paneId: "pane-b", tabId: "tab-b" }],
      },
    ];
    useOrchestrationStore.getState().sync(source);
    workspaceApiMock.moveWorkspacePane.mockClear();
    const before = useOrchestrationStore.getState().snapshot;

    useOrchestrationStore.getState().movePane("pane-a", "container-workspace-b");

    expect(useOrchestrationStore.getState().snapshot).toBe(before);
    expect(workspaceApiMock.moveWorkspacePane).not.toHaveBeenCalled();
  });

  it("persists tab order inside its pane and restores it on refresh", () => {
    const source: Workspace[] = [
      {
        id: "workspace-tab-order",
        name: "Tab order",
        cwd: "/tab-order",
        terminals: [
          { id: "pty-a", command: "one", width: 80, paneId: "pane-shared", tabId: "tab-a" },
          { id: "pty-b", command: "two", width: 80, paneId: "pane-shared", tabId: "tab-b" },
          { id: "pty-c", command: "three", width: 80, paneId: "pane-shared", tabId: "tab-c" },
        ],
      },
    ];
    useOrchestrationStore.getState().sync(source);
    useOrchestrationStore.getState().reorderTabs("pane-shared", ["tab-c", "tab-a", "missing"]);

    expect(useOrchestrationStore.getState().snapshot?.panes[0]).toMatchObject({
      id: "pane-shared",
      tabIds: ["tab-c", "tab-a", "tab-b"],
      layout: { itemIds: ["tab-c", "tab-a", "tab-b"] },
    });
    useOrchestrationStore.getState().sync(source);
    expect(useOrchestrationStore.getState().snapshot?.panes[0]?.tabIds).toEqual([
      "tab-c",
      "tab-a",
      "tab-b",
    ]);
    if (typeof localStorage !== "undefined") {
      const persisted = localStorage.getItem(ORCHESTRATION_STORAGE_KEY);
      expect(persisted).toContain('"tabIds":["tab-c","tab-a","tab-b"]');
    }
  });

  it("reconciles a rejected persistence command with the authoritative backend state", async () => {
    const source: Workspace[] = [
      {
        id: "workspace-persist-error",
        name: "Persist error",
        cwd: "/persist-error",
        terminals: [{ id: "pty-persist-error", command: "shell", width: 80 }],
      },
    ];
    useOrchestrationStore.getState().sync(source);
    workspaceApiMock.listWorkspaces.mockResolvedValueOnce(source);
    workspaceApiMock.listGroups.mockResolvedValueOnce([]);
    workspaceApiMock.setWorkspaceLayout.mockRejectedValueOnce(new Error("disk offline"));

    useOrchestrationStore.getState().setWorkspaceLayout("workspace-persist-error", {
      mode: "spotlight",
      itemIds: ["container-workspace-persist-error"],
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(useOrchestrationStore.getState().snapshot?.projects[0]?.layout.mode).toBe(
      "auto",
    );
    expect(useOrchestrationStore.getState().persistenceError).toMatchObject({
      operation: "workspace layout",
      message: "disk offline",
    });

    useOrchestrationStore.getState().clearPersistenceError();
    expect(useOrchestrationStore.getState().persistenceError).toBeNull();
  });

  it("does not let a stale rejection reconcile over a newer successful mutation", async () => {
    const source: Workspace[] = [
      {
        id: "workspace-stale-persist",
        name: "Stale persist",
        cwd: "/stale-persist",
        terminals: [{ id: "pty-stale-persist", command: "shell", width: 80 }],
      },
    ];
    useOrchestrationStore.getState().sync(source);

    let rejectFirst: (error: unknown) => void = () => undefined;
    const firstCommand = new Promise<void>((_, reject) => {
      rejectFirst = reject;
    });
    workspaceApiMock.setWorkspaceLayout
      .mockImplementationOnce(() => firstCommand)
      .mockImplementationOnce(() => Promise.resolve());
    workspaceApiMock.listWorkspaces.mockClear();
    workspaceApiMock.listGroups.mockClear();

    useOrchestrationStore.getState().setWorkspaceLayout("workspace-stale-persist", {
      mode: "spotlight",
    });
    useOrchestrationStore.getState().setWorkspaceLayout("workspace-stale-persist", {
      mode: "grid",
    });
    rejectFirst(new Error("stale disk failure"));

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(useOrchestrationStore.getState().snapshot?.projects[0]?.layout.mode).toBe("grid");
    expect(workspaceApiMock.listWorkspaces).not.toHaveBeenCalled();
    expect(workspaceApiMock.listGroups).not.toHaveBeenCalled();
    expect(useOrchestrationStore.getState().persistenceError).toMatchObject({
      operation: "workspace layout",
      message: "stale disk failure",
    });
  });

  it("does not rebuild visual state on an idempotent refresh", () => {
    const source: Workspace[] = [
      {
        id: "workspace-tabs",
        name: "Tabs",
        cwd: "/tabs",
        terminals: [
          { id: "pty-1", command: "luna one", width: 80, paneId: "pane-tabs", tabId: "tab-one" },
          { id: "pty-2", command: "luna two", width: 80, paneId: "pane-tabs", tabId: "tab-two" },
        ],
      },
    ];
    useOrchestrationStore.getState().sync(source);
    const initial = useOrchestrationStore.getState().snapshot;
    expect(initial?.panes[0]?.tabIds).toEqual(["tab-one", "tab-two"]);

    useOrchestrationStore.setState({
      snapshot: initial
        ? {
            ...initial,
            activePaneId: "pane-tabs",
            activeTabId: "tab-two",
            layout: { mode: "spotlight", itemIds: initial.containers.map((container) => container.id) },
            panes: initial.panes.map((pane) => ({
              ...pane,
              activeTabId: "tab-two",
              layout: { mode: "horizontal", itemIds: ["tab-one", "tab-two"] },
            })),
          }
        : null,
    });
    const beforeRefresh = useOrchestrationStore.getState().snapshot;
    useOrchestrationStore.getState().sync(source);
    const afterRefresh = useOrchestrationStore.getState().snapshot;

    expect(afterRefresh).toEqual(beforeRefresh);
    expect(afterRefresh?.activeTabId).toBe("tab-two");
    expect(afterRefresh?.panes[0]?.layout.mode).toBe("horizontal");
  });

  it("keeps group suspension metadata and drops only stale backend terminals", () => {
    const source: Workspace[] = [
      {
        id: "workspace-grouped",
        name: "Grouped",
        cwd: "/grouped",
        groupId: "group-luna",
        terminals: [
          { id: "pty-live", command: "luna", width: 80, groupId: "group-luna", suspended: true },
          { id: "pty-stale", command: "luna", width: 80, groupId: "group-luna" },
        ],
      },
    ];
    const groups = [
      {
        id: "group-luna",
        name: "Luna Max",
        projectIds: ["workspace-grouped"],
        parentGroupId: null,
        collapsed: false,
        suspended: true,
        layoutMode: "grid",
      },
    ];
    useOrchestrationStore.getState().sync(source, groups);
    useOrchestrationStore.getState().sync(
      [{ ...source[0], terminals: [source[0].terminals[0]] }],
      groups,
    );

    const state = useOrchestrationStore.getState();
    expect(state.groups[0]).toMatchObject({ id: "group-luna", suspended: true });
    expect(state.snapshot?.tabs.map((tab) => tab.ptyId)).toEqual(["pty-live"]);
    expect(state.snapshot?.projects[0]?.groupId).toBe("group-luna");
  });
});
