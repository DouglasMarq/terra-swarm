import { describe, expect, it } from "vitest";
import type { WorkspaceGroup } from "../workspace.model";
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
  it("Given terminal and group suspension, when selecting sessions to resume, then each is identified independently", () => {
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

  it("Given an unsuspended terminal, when selecting sessions to resume, then it stays eligible", () => {
    expect(
      isTerminalSuspended(
        { groupId: "group-live" },
        { suspended: false },
        suspendedGroupIds(groups),
      ),
    ).toBe(false);
  });
});
