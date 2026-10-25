import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace, WorkspaceGroup } from "../domain/workspace.model";

const workspaceApiMock = vi.hoisted(() => ({
  listWorkspaces: vi.fn<() => Promise<Workspace[]>>(),
  listGroups: vi.fn<() => Promise<WorkspaceGroup[]>>(),
}));

vi.mock("../lib/tauri/workspace", () => ({ workspaceApi: workspaceApiMock }));

import { createPersistenceEngine, type OrchestrationProjection } from "./orchestrationPersistence";

const backendWorkspace: Workspace = {
  id: "ws-1",
  name: "Demo",
  cwd: "/projects/demo",
  terminals: [{ id: "t-live", command: "claude", width: null }],
};

function harness(initial: OrchestrationProjection) {
  let state = initial;
  const applied: OrchestrationProjection[] = [];
  const reportError = vi.fn();
  const engine = createPersistenceEngine({
    read: () => state,
    apply: (projection) => {
      applied.push(projection);
      state = projection;
    },
    reportError,
  });
  const setState = (next: OrchestrationProjection) => {
    state = next;
  };
  return { engine, applied, reportError, setState, read: () => state };
}

const optimistic: OrchestrationProjection = {
  snapshot: null,
  groups: [],
  containerVisibility: { "container-1": false },
  detachedTerminalIds: ["t-live", "t-gone"],
  isHydrated: false,
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createPersistenceEngine", () => {
  beforeEach(() => {
    workspaceApiMock.listWorkspaces.mockReset().mockResolvedValue([backendWorkspace]);
    workspaceApiMock.listGroups.mockReset().mockResolvedValue([]);
  });

  it("Given a rejected command, when it fails, then it rolls back and applies the backend projection", async () => {
    const { engine, applied, reportError, read } = harness(optimistic);

    engine.persistCommand(Promise.reject(new Error("disk full")), "container order", ["project:ws-1"]);
    await settle();

    expect(reportError).toHaveBeenCalledWith("container order", expect.any(Error));
    expect(applied[0]).toEqual(optimistic);
    expect(read().isHydrated).toBe(true);
    expect(read().snapshot?.projects.map((project) => project.id)).toEqual(["ws-1"]);
    expect(read().detachedTerminalIds).toEqual(["t-live"]);
  });

  it("Given a newer projection, when an older command rejects, then nothing is rolled back", async () => {
    const { engine, applied } = harness(optimistic);

    engine.persistCommand(Promise.reject(new Error("late")), "pane order", ["container:1"]);
    engine.markNewerProjection();
    await settle();

    expect(applied).toEqual([]);
    expect(workspaceApiMock.listWorkspaces).not.toHaveBeenCalled();
  });

  it("Given the backend read fails, when a command rejects, then it restores the previous projection and reports the reconciliation", async () => {
    workspaceApiMock.listWorkspaces.mockRejectedValue(new Error("offline"));
    const { engine, applied, reportError, setState } = harness(optimistic);

    engine.persistCommand(Promise.reject(new Error("rejected")), "workspace layout", ["project:ws-1"]);
    setState({ ...optimistic, isHydrated: true });
    await settle();

    expect(applied[applied.length - 1]).toEqual(optimistic);
    expect(reportError).toHaveBeenLastCalledWith("workspace layout reconciliation", expect.any(Error));
  });
});
