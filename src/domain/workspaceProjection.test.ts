import { describe, expect, it } from "vitest";
import type { Workspace, WorkspaceGroup } from "../types";
import { deriveSnapshot } from "./workspaceProjection";

const workspace: Workspace = {
  id: "ws-1",
  name: "Demo",
  cwd: "/projects/demo",
  groupId: "group-a",
  terminals: [{ id: "t-1", command: "claude", width: null }],
};

const group: WorkspaceGroup = {
  id: "group-a",
  name: "  ",
  collapsed: false,
  projectIds: [],
  parentGroupId: null,
  suspended: false,
};

describe("deriveSnapshot", () => {
  it("Given a workspace in a group, when deriving the snapshot, then the group lists the project and falls back to its id as name", () => {
    const { snapshot, groups } = deriveSnapshot([workspace], [group], {}, null);

    expect(snapshot.projects[0]?.groupId).toBe("group-a");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.projectIds).toEqual(["ws-1"]);
    expect(groups[0]?.name).toBe("group-a");
    expect(snapshot.groups).toBe(groups);
  });

  it("Given a hidden container, when deriving the snapshot, then the container is closed", () => {
    const first = deriveSnapshot([workspace], [], {}, null);
    const containerId = first.snapshot.containers[0]?.id ?? "";

    const { snapshot } = deriveSnapshot([workspace], [], { [containerId]: false }, first.snapshot);

    expect(snapshot.containers[0]).toMatchObject({ visible: false, closed: true });
  });

  it("Given an active group that no longer exists, when deriving the snapshot, then no group is active", () => {
    const first = deriveSnapshot([workspace], [group], {}, null);
    const previous = { ...first.snapshot, activeGroupId: "group-gone" };

    const { snapshot } = deriveSnapshot([{ ...workspace, groupId: null }], [], {}, previous);

    expect(snapshot.activeGroupId).toBeNull();
  });
});
