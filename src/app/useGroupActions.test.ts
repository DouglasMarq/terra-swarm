// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResumeItem } from "../domain/terminal.model";
import type { Workspace, WorkspaceGroup } from "../domain/workspace.model";
import type { SpawnQueueResult } from "../domain/session/spawnQueue";

const apiMock = vi.hoisted(() => ({
  createGroup: vi.fn(() => Promise.resolve()),
  renameGroup: vi.fn(() => Promise.resolve()),
  suspendGroup: vi.fn(() => Promise.resolve()),
  resumeGroup: vi.fn(() => Promise.resolve()),
}));

vi.mock("../api", () => ({ api: apiMock }));

import { useOrchestrationStore } from "../stores/orchestrationStore";
import { useTerminalRuntimeStore } from "../stores/terminalRuntimeStore";
import { useGroupActions } from "./useGroupActions";

const groups: WorkspaceGroup[] = [
  { id: "grp-core", name: "Core", collapsed: false, projectIds: ["ws-alpha"], parentGroupId: null, suspended: false },
];

const workspaces: Workspace[] = [
  { id: "ws-alpha", name: "Alpha", cwd: "/alpha", terminals: [{ id: "term-one", command: "claude", width: null }] },
  { id: "ws-beta", name: "Beta", cwd: "/beta", groupId: "grp-core", terminals: [{ id: "term-two", command: "codex", width: null }] },
  { id: "ws-gamma", name: "Gamma", cwd: "/gamma", terminals: [{ id: "term-three", command: "zsh", width: null }] },
];

function result(id: string, status: SpawnQueueResult<void>["status"]): SpawnQueueResult<void> {
  return { id, status, startedAt: 0, finishedAt: 1 };
}

function renderActions(statuses: readonly SpawnQueueResult<void>["status"][] = ["succeeded", "succeeded"]) {
  const sessions = {
    resumeItems: vi.fn((items: readonly ResumeItem[]) => Promise.resolve(items.map((item, position) => result(item.terminalId, statuses[position] ?? "succeeded")))),
    notifyResumeFailures: vi.fn(),
  };
  const refresh = vi.fn(() => Promise.resolve());
  let current = workspaces;
  const setWorkspaces = vi.fn((update: Workspace[] | ((previous: Workspace[]) => Workspace[])) => {
    current = typeof update === "function" ? update(current) : update;
  });
  const actions = renderHook(() => useGroupActions({ workspaces, groups, sessions, refresh, setWorkspaces })).result.current;
  return { actions, sessions, refresh, workspacesNow: () => current };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  useOrchestrationStore.setState({ groups: groups.map((group) => ({ ...group, layout: { mode: "grid", itemIds: [] } })) });
  useTerminalRuntimeStore.setState({ notifItems: [] });
});

describe("useGroupActions", () => {
  it("Given a name, when a group is created or renamed, then the backend is called and the tree refreshes", async () => {
    const { actions, refresh } = renderActions();

    await actions.createGroup("Infra");
    await actions.renameGroup("grp-core", "Core 2");

    expect(apiMock.createGroup).toHaveBeenCalledWith("Infra");
    expect(apiMock.renameGroup).toHaveBeenCalledWith("grp-core", "Core 2");
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("Given a group with members listed and assigned, when it is suspended, then only its agents are marked suspended", async () => {
    const { actions, workspacesNow } = renderActions();

    await actions.suspendGroup("grp-core");

    expect(apiMock.suspendGroup).toHaveBeenCalledWith("grp-core");
    const suspended = workspacesNow().flatMap((workspace) => workspace.terminals).filter((terminal) => terminal.suspended);
    expect(suspended.map((terminal) => terminal.id)).toEqual(["term-one", "term-two"]);
    expect(useOrchestrationStore.getState().groups[0]?.suspended).toBe(true);
  });

  it("Given a failing backend, when a group is suspended, then no agent is marked suspended", async () => {
    apiMock.suspendGroup.mockRejectedValueOnce(new Error("offline"));
    const { actions, refresh } = renderActions();

    await actions.suspendGroup("grp-core");

    expect(refresh).not.toHaveBeenCalled();
  });

  it("Given every agent resumes, when the group is resumed, then the group is activated", async () => {
    const { actions, sessions } = renderActions();

    await actions.resumeGroup("grp-core");

    expect(sessions.resumeItems).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ terminalId: "term-one", wsId: "ws-alpha" }),
      expect.objectContaining({ terminalId: "term-two", wsId: "ws-beta" }),
    ]));
    expect(apiMock.resumeGroup).toHaveBeenCalledWith("grp-core");
    expect(useOrchestrationStore.getState().groups[0]?.suspended).toBe(false);
  });

  it("Given one agent fails to resume, when the group is resumed, then the group is suspended again with a notice", async () => {
    const { actions } = renderActions(["succeeded", "failed"]);

    await actions.resumeGroup("grp-core");

    expect(apiMock.resumeGroup).not.toHaveBeenCalled();
    expect(apiMock.suspendGroup).toHaveBeenCalledWith("grp-core");
    expect(useOrchestrationStore.getState().groups[0]?.suspended).toBe(true);
    expect(useTerminalRuntimeStore.getState().notifItems).toHaveLength(1);
  });

  it("Given the backend refuses to activate, when the group is resumed, then it stays suspended with a notice", async () => {
    apiMock.resumeGroup.mockRejectedValueOnce(new Error("offline"));
    const { actions } = renderActions();

    await actions.resumeGroup("grp-core");

    expect(apiMock.suspendGroup).toHaveBeenCalledWith("grp-core");
    expect(useOrchestrationStore.getState().groups[0]?.suspended).toBe(true);
    expect(useTerminalRuntimeStore.getState().notifItems).toHaveLength(1);
  });
});
