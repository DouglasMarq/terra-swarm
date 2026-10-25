import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../domain/workspace.model";

const workspaceApiMock = vi.hoisted(() => ({
  listWorkspaces: vi.fn<() => Promise<unknown>>(),
  listGroups: vi.fn<() => Promise<unknown>>(),
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

  it("Given backend containers that are hidden or closed, when reconciling, then their visibility follows the backend", async () => {
    workspaceApiMock.listWorkspaces.mockResolvedValue([{
      ...backendWorkspace,
      containers: [
        { id: "container-open", projectId: "ws-1", paneIds: [] },
        { id: "container-hidden", projectId: "ws-1", paneIds: [], isVisible: false },
        { id: "container-closed", projectId: "ws-1", paneIds: [], isClosed: true },
      ],
    }]);
    workspaceApiMock.listGroups.mockResolvedValue(null);
    const { engine, read } = harness(optimistic);

    engine.persistCommand(Promise.reject(new Error("rejected")), "container visibility", ["container:open"]);
    await settle();

    expect(read().containerVisibility).toMatchObject({ "container-open": true, "container-hidden": false, "container-closed": false });
    expect(read().groups).toEqual([]);
  });

  it("Given the backend returns no workspace list, when reconciling, then only the rollback is applied", async () => {
    workspaceApiMock.listWorkspaces.mockResolvedValue(null);
    const { engine, applied } = harness(optimistic);

    engine.persistCommand(Promise.reject(new Error("rejected")), "pane order", ["pane:1"]);
    await settle();

    expect(applied).toEqual([optimistic]);
  });

  it("Given a newer projection while the backend is read, when the read settles, then it is ignored even if it fails", async () => {
    let failRead: (error: unknown) => void = () => undefined;
    workspaceApiMock.listWorkspaces.mockReturnValueOnce(new Promise((_resolve, reject) => {
      failRead = reject;
    }));
    const { engine, applied, reportError } = harness(optimistic);

    engine.persistCommand(Promise.reject(new Error("rejected")), "pane order", ["pane:1"]);
    await settle();
    engine.markNewerProjection();
    failRead(new Error("offline"));
    await settle();

    expect(applied).toEqual([optimistic]);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("Given a newer projection while the backend is read, when the read succeeds, then its projection is dropped", async () => {
    let finishRead: (workspaces: Workspace[]) => void = () => undefined;
    workspaceApiMock.listWorkspaces.mockReturnValueOnce(new Promise((resolve) => {
      finishRead = resolve;
    }));
    const { engine, applied } = harness(optimistic);

    engine.persistCommand(Promise.reject(new Error("rejected")), "pane order", ["pane:1"]);
    await settle();
    engine.markNewerProjection();
    finishRead([backendWorkspace]);
    await settle();

    expect(applied).toEqual([optimistic]);
  });
});
