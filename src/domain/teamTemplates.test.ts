import { describe, expect, it } from "vitest";
import { planTeam, TEAM_TEMPLATES } from "./teamTemplates";

const feature = TEAM_TEMPLATES.find((template) => template.id === "feature")!;

describe("planTeam", () => {
  it("uses the template's agents when they are installed", () => {
    const plan = planTeam(feature, [
      { id: "claude", label: "Claude", available: true },
      { id: "codex", label: "Codex", available: true },
    ], null, true);
    expect(plan.blocked).toBe(false);
    expect(plan.members.map((member) => `${member.role}:${member.agent}:${member.worktree}`)).toEqual([
      "orchestrator:claude:false",
      "executor:claude:true",
      "executor:codex:true",
      "reviewer:claude:false",
      "tester:claude:true",
    ]);
  });

  it("stands in the default agent and skips worktrees outside git", () => {
    const plan = planTeam(feature, [
      { id: "claude", label: "Claude", available: true },
      { id: "codex", label: "Codex", available: false },
      { id: "kimi", label: "Kimi", available: true },
    ], "kimi", false);
    expect(plan.members[2]).toEqual({ role: "executor", agent: "kimi", worktree: false, substituted: true });
    expect(plan.members.every((member) => !member.worktree)).toBe(true);
  });

  it("is blocked when no agent is installed", () => {
    expect(planTeam(feature, [{ id: "shell", label: "Shell", available: true }], null, true).blocked).toBe(true);
  });
});
