import { describe, expect, it } from "vitest";
import { planResume, resumeCandidateKey } from "./resumePlanner";

describe("resume planner", () => {
  it("Given sessions, when planning the resume, then they are grouped by project and group in their original order", () => {
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

  it("Given duplicate sessions, when planning the resume, then the first is kept and the skipped candidate is recorded", () => {
    const first = { terminalId: "same", projectId: "p1", command: "claude" };
    const second = { terminalId: "same", projectId: "p2", command: "codex" };
    const plan = planResume([first, second]);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]?.projectId).toBe("p1");
    expect(plan.duplicates).toHaveLength(1);
    expect(plan.duplicates[0]?.skipped).toBe(second);
  });

  it("Given legacy records without terminal ids, when computing their key, then the key is stable", () => {
    const candidate = { projectId: "p", groupId: "g", cwd: "/repo", command: "claude" };
    expect(resumeCandidateKey(candidate)).toBe(resumeCandidateKey({ ...candidate }));
    expect(planResume([candidate, { ...candidate }]).items).toHaveLength(1);
  });
});

