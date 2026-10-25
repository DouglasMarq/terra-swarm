// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace, WorkspaceGroup, WorkspaceSnapshotV2 } from "../domain/workspace.model";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { ORCHESTRATION_STORAGE_KEY, useOrchestrationStore } from "./orchestrationStore";
import { defined } from "../test/defined";

const workspaces: Workspace[] = [
  {
    id: "ws-a",
    name: "A",
    cwd: "/a",
    groupId: "g-1",
    terminals: [
      { id: "pty-1", command: "codex", width: 50 },
      { id: "pty-2", command: "claude", width: 50 },
    ],
  },
  { id: "ws-b", name: "B", cwd: "/b", terminals: [{ id: "pty-3", command: "zsh", width: null }] },
];

const groups: WorkspaceGroup[] = [
  { id: "g-1", name: "G", projectIds: [], parentGroupId: null, isCollapsed: false, isSuspended: false },
];

const store = () => useOrchestrationStore.getState();
const snapshot = () => defined(store().snapshot);
const container = (id: string) => defined(snapshot().containers.find((candidate) => candidate.id === id));
const project = (id: string) => defined(snapshot().projects.find((candidate) => candidate.id === id));
const commandsSent = () => invoke.mock.calls.map(([command]) => command);

function withSecondContainer(): void {
  const current = snapshot();
  const extra = { ...container("container-ws-a"), id: "container-ws-a-2", paneIds: ["pane-ws-a-2"] };
  useOrchestrationStore.setState({
    snapshot: {
      ...current,
      containers: [
        { ...container("container-ws-a"), paneIds: ["pane-ws-a-1"] },
        extra,
        ...current.containers.filter((candidate) => candidate.id !== "container-ws-a"),
      ],
      projects: current.projects.map((candidate) =>
        candidate.id === "ws-a" ? { ...candidate, containerIds: ["container-ws-a", "container-ws-a-2"] } : candidate,
      ),
    },
  });
}

describe("orchestration store actions", () => {
  beforeEach(() => {
    invoke.mockReset().mockResolvedValue(undefined);
    store().sync(workspaces, groups);
  });

  afterEach(() => {
    store().reset();
    localStorage.clear();
  });

  it("Given a visible container, when toggling it twice, then it closes and opens again", () => {
    store().toggleContainer("container-ws-a");
    expect(container("container-ws-a")).toMatchObject({ isVisible: false, isClosed: true });

    store().setContainerVisibility("container-ws-a", true);
    store().toggleContainer("container-ws-a");
    store().toggleContainer("container-ws-a");
    expect(container("container-ws-a")).toMatchObject({ isVisible: true, isClosed: false });
    expect(commandsSent()).toContain("set_workspace_container_state");
  });

  it("Given an unknown container, when hiding it, then only local visibility changes and no command is sent", () => {
    store().setContainerVisible("container-ghost", false);

    expect(store().containerVisibility["container-ghost"]).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("Given container patches, when collapsing, fullscreening, resizing and changing the layout, then the container reflects each one", () => {
    store().setContainerCollapsed("container-ws-a", true);
    store().setContainerFullscreen("container-ws-a", true);
    store().setContainerInternalLayout("container-ws-a", "rows");
    store().setContainerState("container-ws-a", { size: 0.4, layout: { mode: "grid", columns: 3 }, isClosed: true });

    expect(container("container-ws-a")).toMatchObject({
      isCollapsed: true,
      isFullscreen: true,
      internalLayout: "rows",
      size: 0.4,
      isClosed: true,
      isVisible: false,
      layout: { mode: "grid", columns: 3 },
    });
    expect(store().containerVisibility["container-ws-a"]).toBe(false);
  });

  it("Given a container, when choosing its active pane, then the project and snapshot focus follow", () => {
    store().setContainerActivePane("container-ws-b", "pane-ws-b-1");

    expect(snapshot()).toMatchObject({ activeProjectId: "ws-b", activeContainerId: "container-ws-b", activePaneId: "pane-ws-b-1" });
    expect(project("ws-b").activePaneId).toBe("pane-ws-b-1");
  });

  it("Given a container with an active pane, when clearing it, then the backend is told to clear the active pane", () => {
    store().setContainerActivePane("container-ws-a", null);

    expect(container("container-ws-a").activePaneId).toBeNull();
    expect(snapshot().activePaneId).toBeNull();
    expect(invoke).toHaveBeenCalledWith("set_workspace_container_state", {
      request: { workspaceId: "ws-a", containerId: "container-ws-a", patch: { activePaneId: undefined, shouldClearActivePane: true } },
    });
  });

  it("Given an unknown container, when patching its state, then nothing is sent to the backend", () => {
    const before = snapshot();

    store().setContainerState("container-ghost", { isVisible: false });

    expect(snapshot()).toBe(before);
    expect(store().containerVisibility["container-ghost"]).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("Given a project with two containers, when reordering them, then the order and the backend follow", () => {
    withSecondContainer();

    store().reorderContainers("ws-a", ["container-ws-a-2", "container-ghost"]);

    expect(project("ws-a").containerIds).toEqual(["container-ws-a-2", "container-ws-a"]);
    expect(snapshot().containers.map((candidate) => candidate.id).slice(0, 2)).toEqual(["container-ws-a-2", "container-ws-a"]);
    expect(invoke).toHaveBeenCalledWith("reorder_workspace_containers", { request: { workspaceId: "ws-a", order: ["container-ws-a-2", "container-ws-a"] } });
  });

  it("Given an unknown project or no snapshot, when reordering containers, then nothing happens", () => {
    store().reorderContainers("ws-ghost", []);
    store().reset();
    store().reorderContainers("ws-a", []);

    expect(invoke).not.toHaveBeenCalled();
  });

  it("Given a container with two panes, when reordering them, then its pane order and layout follow", () => {
    store().reorderPanes("container-ws-a", ["pane-ws-a-2"]);

    expect(container("container-ws-a")).toMatchObject({ paneIds: ["pane-ws-a-2", "pane-ws-a-1"], layout: { itemIds: ["pane-ws-a-2", "pane-ws-a-1"] } });
    expect(commandsSent()).toEqual(["reorder_workspace_panes"]);
  });

  it("Given an unknown container or pane, when reordering, then nothing happens", () => {
    const before = snapshot();

    store().reorderPanes("container-ghost", []);
    store().reorderTabs("pane-ghost", []);

    expect(snapshot()).toBe(before);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("Given two containers in one project, when moving a pane with and without an index, then it lands in the target", () => {
    withSecondContainer();

    store().movePane("pane-ws-a-1", "container-ws-a-2", 0);
    expect(container("container-ws-a-2").paneIds).toEqual(["pane-ws-a-1", "pane-ws-a-2"]);
    expect(container("container-ws-a").paneIds).toEqual([]);

    store().movePane("pane-ws-a-1", "container-ws-a");
    expect(container("container-ws-a").paneIds).toEqual(["pane-ws-a-1"]);
    expect(snapshot().panes.find((pane) => pane.id === "pane-ws-a-1")?.containerId).toBe("container-ws-a");
    expect(commandsSent()).toEqual(["move_workspace_pane", "move_workspace_pane"]);
  });

  it("Given the active project, when changing its layout, then the project and the snapshot layout follow", () => {
    store().setWorkspaceLayout("ws-a", { mode: "grid", columns: 2 });

    expect(project("ws-a").layout).toMatchObject({ mode: "grid", columns: 2 });
    expect(snapshot().layout).toMatchObject({ mode: "grid", columns: 2 });
  });

  it("Given an inactive project, when changing its layout, then the snapshot layout is kept", () => {
    const layout = snapshot().layout;

    store().setWorkspaceLayout("ws-b", { mode: "vertical" });

    expect(project("ws-b").layout.mode).toBe("vertical");
    expect(snapshot().layout).toEqual(layout);
  });

  it("Given a project, when collapsing it, then it is collapsed and the backend is told", () => {
    store().setWorkspaceCollapsed("ws-b", true);

    expect(project("ws-b").isCollapsed).toBe(true);
    expect(invoke).toHaveBeenCalledWith("set_workspace_collapsed", { request: { workspaceId: "ws-b", isCollapsed: true } });
  });

  it("Given no snapshot, when changing layout, collapse or active pane, then nothing is sent", () => {
    store().reset();

    store().setWorkspaceLayout("ws-a", { mode: "grid" });
    store().setWorkspaceCollapsed("ws-a", true);
    store().setActivePane("pane-ws-a-1");
    store().setGroupSuspended("g-1", true);
    store().setProjectGroup("ws-a", null);

    expect(store().snapshot).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("Given an ungrouped project, when moving it into a group and back out, then group membership follows", () => {
    store().setProjectGroup("ws-b", "g-1");
    expect(store().groups[0].projectIds).toEqual(["ws-a", "ws-b"]);
    expect(project("ws-b").groupId).toBe("g-1");

    store().setProjectGroup("ws-b", null);
    expect(store().groups[0].projectIds).toEqual(["ws-a"]);
    expect(project("ws-b").groupId).toBeNull();
  });

  it("Given a pane in another project, when activating it, then the project, container and backend follow", () => {
    store().setActivePane("pane-ws-b-1");

    expect(snapshot()).toMatchObject({ activePaneId: "pane-ws-b-1", activeProjectId: "ws-b", activeContainerId: "container-ws-b" });
    expect(project("ws-b")).toMatchObject({ activePaneId: "pane-ws-b-1", activeContainerId: "container-ws-b" });
    expect(invoke).toHaveBeenCalledWith("set_active_pane", { request: { workspaceId: "ws-b", paneId: "pane-ws-b-1" } });
  });

  it("Given no pane, when clearing the active pane, then the active project stays and no command is sent", () => {
    store().setActivePane(null);

    expect(snapshot()).toMatchObject({ activePaneId: null, activeProjectId: "ws-a" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("Given detach requests, when detaching blank, twice and reattaching, then only real changes are kept", () => {
    store().detachTerminal("  ");
    expect(store().detachedTerminalIds).toEqual([]);

    store().detachTerminal("pty-1");
    const detached = store().detachedTerminalIds;
    store().detachTerminal("pty-1");
    expect(store().detachedTerminalIds).toBe(detached);

    store().reattachTerminal("pty-1");
    expect(store().detachedTerminalIds).toEqual([]);
  });

  it("Given feature flags, when setting one and several, then they are stored", () => {
    store().setFlag("durableScrollback", true);
    store().setFeatureFlags({ voiceCommands: true });

    expect(store().flags).toEqual({ durableScrollback: true, voiceCommands: true });
    expect(JSON.parse(localStorage.getItem(ORCHESTRATION_STORAGE_KEY) ?? "{}").flags).toEqual({ durableScrollback: true, voiceCommands: true });
  });

  it("Given a failed backend command, when clearing the error, then the error is gone", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "set_workspace_collapsed") throw new Error("disk full");
      return [];
    });

    store().setWorkspaceCollapsed("ws-a", true);
    await vi.waitFor(() => expect(store().persistenceError).not.toBeNull());

    store().clearPersistenceError();
    expect(store().persistenceError).toBeNull();
  });

  it("Given hydrate and syncWorkspaces, when called, then both derive the snapshot like sync", () => {
    store().reset();

    store().hydrate(workspaces);
    expect(store().isHydrated).toBe(true);

    store().syncWorkspaces([workspaces[1]]);
    expect(snapshot().projects.map((candidate) => candidate.id)).toEqual(["ws-b"]);
  });
});

describe("orchestration state restored from storage", () => {
  afterEach(() => localStorage.clear());

  async function loadStore() {
    vi.resetModules();
    return import("./orchestrationStore");
  }

  it("Given a stored state with stray values, when the store loads, then only valid visibility and detached ids survive", async () => {
    const stored: { snapshot: WorkspaceSnapshotV2 | null } & Record<string, unknown> = {
      version: 1,
      containerVisibility: { "container-ws-a": false, "container-ws-b": "yes", "": true },
      flags: { durableScrollback: true },
      detachedTerminalIds: ["pty-1", " ", 4, "pty-1"],
      snapshot: null,
    };
    localStorage.setItem(ORCHESTRATION_STORAGE_KEY, JSON.stringify(stored));

    const { useOrchestrationStore: restored } = await loadStore();

    expect(restored.getState()).toMatchObject({
      containerVisibility: { "container-ws-a": false },
      flags: { durableScrollback: true, voiceCommands: false },
      detachedTerminalIds: ["pty-1"],
      snapshot: null,
      isHydrated: false,
    });
  });

  it("Given a stored snapshot, when the store loads, then it starts hydrated with the snapshot groups", async () => {
    store().sync(workspaces, groups);
    const saved = localStorage.getItem(ORCHESTRATION_STORAGE_KEY);
    localStorage.clear();
    localStorage.setItem(ORCHESTRATION_STORAGE_KEY, defined(saved));

    const { useOrchestrationStore: restored } = await loadStore();

    expect(restored.getState().isHydrated).toBe(true);
    expect(restored.getState().groups.map((group) => group.id)).toEqual(["g-1"]);
    expect(restored.getState().snapshot?.projects.map((candidate) => candidate.id)).toEqual(["ws-a", "ws-b"]);
  });

  it("Given a stored state without a detached list, when the store loads, then nothing is detached", async () => {
    localStorage.setItem(ORCHESTRATION_STORAGE_KEY, JSON.stringify({ version: 1, containerVisibility: {}, flags: {} }));

    const { useOrchestrationStore: restored } = await loadStore();

    expect(restored.getState().detachedTerminalIds).toEqual([]);
  });

  it("Given corrupted stored state, when the store loads, then the defaults are used", async () => {
    localStorage.setItem(ORCHESTRATION_STORAGE_KEY, "{broken");

    const { useOrchestrationStore: restored } = await loadStore();

    expect(restored.getState()).toMatchObject({ containerVisibility: {}, detachedTerminalIds: [], snapshot: null });
  });
});
