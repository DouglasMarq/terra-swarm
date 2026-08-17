import { describe, expect, it } from "vitest";
import type { WorkspaceGroup } from "../../types";
import { isTerminalSuspended, suspendedGroupIds } from "./resumeSelection";

const groups: WorkspaceGroup[] = [
  {
    id: "group-paused",
    name: "Paused",
    collapsed: false,
    projectIds: [],
    parentGroupId: null,
    suspended: true,
  },
  {
    id: "group-live",
    name: "Live",
    collapsed: false,
    projectIds: [],
    parentGroupId: null,
    suspended: false,
  },
];

describe("resume selection", () => {
  it("identifies terminal and group suspension independently", () => {
    const suspended = suspendedGroupIds(groups);
    expect(
      isTerminalSuspended(
        { groupId: "group-live" },
        { suspended: true },
        suspended,
      ),
    ).toBe(true);
    expect(
      isTerminalSuspended(
        { groupId: "group-paused" },
        { suspended: false },
        suspended,
      ),
    ).toBe(true);
  });

  it("leaves an unsuspended terminal eligible for resume", () => {
    expect(
      isTerminalSuspended(
        { groupId: "group-live" },
        { suspended: false },
        suspendedGroupIds(groups),
      ),
    ).toBe(false);
  });
});
