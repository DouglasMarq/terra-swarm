// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace, WorkspaceContainer, WorkspaceSnapshotV2 } from "../domain/workspace.model";

const workspaceApiMock = vi.hoisted(() => ({
  setWorkspaceContainerState: vi.fn(() => Promise.resolve()),
}));

vi.mock("../lib/tauri/workspace", () => ({ workspaceApi: workspaceApiMock }));

import { useOrchestrationStore } from "../stores/orchestrationStore";
import { useUiStore } from "../stores/uiStore";
import { useWorkspaceNavigation } from "./useWorkspaceNavigation";

const workspaces: Workspace[] = [
  { id: "ws-alpha", name: "Alpha", cwd: "/alpha", terminals: [] },
  { id: "ws-beta", name: "Beta", cwd: "/beta", terminals: [] },
];

function container(id: string, projectId: string): WorkspaceContainer {
  return {
    id,
    projectId,
    paneIds: [],
    layout: { mode: "grid", itemIds: [] },
    isVisible: true,
    isCollapsed: false,
    isClosed: false,
    isFullscreen: false,
  };
}

function project(id: string, containerId: string) {
  return {
    id,
    name: id,
    cwd: `/${id}`,
    groupId: null,
    paneIds: [],
    containerIds: [containerId],
    activePaneId: null,
    activeContainerId: containerId,
    layout: { mode: "grid" as const, itemIds: [containerId] },
    isCollapsed: false,
  };
}

const snapshot: WorkspaceSnapshotV2 = {
  version: 2,
  projects: [project("ws-alpha", "box-alpha"), project("ws-beta", "box-beta")],
  groups: [],
  containers: [container("box-alpha", "ws-alpha"), container("box-beta", "ws-beta")],
  panes: [],
  tabs: [],
  orphanedTabIds: [],
  activeProjectId: "ws-alpha",
  activeGroupId: null,
  activeContainerId: "box-alpha",
  activePaneId: null,
  activeTabId: null,
  layout: { mode: "grid", itemIds: ["box-alpha", "box-beta"] },
};

function navigation(activeId: string | null) {
  const snapshotNow = useOrchestrationStore.getState().snapshot;
  return renderHook(() => useWorkspaceNavigation({ workspaces, snapshot: snapshotNow, activeId, focusedId: null })).result.current;
}

function isVisible(containerId: string): boolean | undefined {
  return useOrchestrationStore.getState().snapshot?.containers.find((candidate) => candidate.id === containerId)?.isVisible;
}

beforeEach(() => {
  useOrchestrationStore.setState({ snapshot, containerVisibility: {} });
  useUiStore.setState({ activeId: "ws-alpha", expandedId: "term-one", focusedId: "term-one" });
});

describe("useWorkspaceNavigation", () => {
  it("Given the active project, when it is hidden, then its container closes and the other visible project becomes active", () => {
    navigation("ws-alpha").hideWorkspace("ws-alpha");

    expect(isVisible("box-alpha")).toBe(false);
    expect(useUiStore.getState()).toMatchObject({ activeId: "ws-beta", expandedId: null, focusedId: null });
  });

  it("Given a background project, when its container is hidden, then the active project and focus stay", () => {
    navigation("ws-alpha").hideContainer("box-beta");

    expect(isVisible("box-beta")).toBe(false);
    expect(useUiStore.getState()).toMatchObject({ activeId: "ws-alpha", focusedId: "term-one" });
  });

  it("Given an unknown container, when it is hidden, then nothing changes", () => {
    navigation("ws-alpha").hideContainer("box-missing");

    expect(useOrchestrationStore.getState().snapshot).toBe(snapshot);
  });

  it("Given a hidden project, when it is selected, then its container reopens and it becomes active without a maximized agent", () => {
    navigation("ws-alpha").hideContainer("box-beta");

    navigation("ws-alpha").selectWorkspace("ws-beta");

    expect(isVisible("box-beta")).toBe(true);
    expect(useUiStore.getState()).toMatchObject({ activeId: "ws-beta", expandedId: null });
  });

  it("Given the active project with a maximized agent, when it is selected again, then the agent stays maximized", () => {
    navigation("ws-alpha").selectWorkspace("ws-alpha");

    expect(useUiStore.getState()).toMatchObject({ activeId: "ws-alpha", expandedId: "term-one" });
  });

  it("Given no layout snapshot and the active project, when it is hidden, then no project stays active", () => {
    useOrchestrationStore.setState({ snapshot: null });

    navigation("ws-alpha").hideWorkspace("ws-alpha");

    expect(useUiStore.getState()).toMatchObject({ activeId: null, expandedId: null, focusedId: null });
  });
});
