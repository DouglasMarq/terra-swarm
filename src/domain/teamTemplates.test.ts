import { describe, expect, it } from "vitest";
import { planTeam, TEAM_TEMPLATES } from "./teamTemplates";
import { defined } from "../test/defined";

const feature = defined(TEAM_TEMPLATES.find((template) => template.id === "feature"));

describe("planTeam", () => {
  it("Given the template's agents are installed, when planning the team, then they are used", () => {
    const plan = planTeam(feature, {
      agents: [
        { id: "claude", label: "Claude", isAvailable: true },
        { id: "codex", label: "Codex", isAvailable: true },
      ],
      defaultAgent: null,
      canIsolate: true,
    });
    expect(plan.isBlocked).toBe(false);
    expect(plan.members.map((member) => `${member.role}:${member.agent}:${member.shouldUseWorktree}`)).toEqual([
      "orchestrator:claude:false",
      "executor:claude:true",
      "executor:codex:true",
      "reviewer:claude:false",
      "tester:claude:true",
    ]);
  });

  it("Given a missing agent outside git, when planning the team, then the default agent stands in and worktrees are skipped", () => {
    const plan = planTeam(feature, {
      agents: [
        { id: "claude", label: "Claude", isAvailable: true },
        { id: "codex", label: "Codex", isAvailable: false },
        { id: "kimi", label: "Kimi", isAvailable: true },
      ],
      defaultAgent: "kimi",
      canIsolate: false,
    });
    expect(plan.members[2]).toEqual({ role: "executor", agent: "kimi", shouldUseWorktree: false, isSubstituted: true });
    expect(plan.members.every((member) => !member.shouldUseWorktree)).toBe(true);
  });

  it("Given no agent is installed, when planning the team, then it is blocked", () => {
    expect(planTeam(feature, { agents: [{ id: "shell", label: "Shell", isAvailable: true }], defaultAgent: null, canIsolate: true }).isBlocked).toBe(true);
  });
});
