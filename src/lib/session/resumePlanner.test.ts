import { describe, expect, it } from "vitest";
import { planResume, resumeCandidateKey } from "./resumePlanner";

describe("resume planner", () => {
  it("groups sessions by project and group while preserving order", () => {
    const plan = planResume([
      { terminalId: "a", projectId: "p1", projectName: "One", groupId: "g1", groupName: "UI" },
      { terminalId: "b", projectId: "p1", projectName: "One", groupId: "g2", groupName: "API" },
      { terminalId: "c", projectId: "p1", projectName: "One", groupId: "g1", groupName: "UI" },
      { terminalId: "d", projectId: "p2", projectName: "Two" },
    ]);

    expect(plan.projects.map((project) => project.projectId)).toEqual(["p1", "p2"]);
    expect(plan.projects[0]?.groups.map((group) => group.groupId)).toEqual(["g1", "g2"]);
    expect(plan.groups.map((group) => group.items.map((item) => item.terminalId))).toEqual([
      ["a", "c"],
      ["b"],
      ["d"],
    ]);
  });

  it("keeps the first duplicate and records the skipped candidate", () => {
    const first = { terminalId: "same", projectId: "p1", command: "claude" };
    const second = { terminalId: "same", projectId: "p2", command: "codex" };
    const plan = planResume([first, second]);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]?.projectId).toBe("p1");
    expect(plan.duplicates).toHaveLength(1);
    expect(plan.duplicates[0]?.skipped).toBe(second);
  });

  it("derives a stable key for legacy records without terminal IDs", () => {
    const candidate = { projectId: "p", groupId: "g", cwd: "/repo", command: "claude" };
    expect(resumeCandidateKey(candidate)).toBe(resumeCandidateKey({ ...candidate }));
    expect(planResume([candidate, { ...candidate }]).items).toHaveLength(1);
  });
});

