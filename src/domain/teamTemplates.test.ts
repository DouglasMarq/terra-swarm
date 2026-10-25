import { describe, expect, it } from "vitest";
import { planTeam, TEAM_TEMPLATES } from "./teamTemplates";
import { defined } from "../test/defined";

const feature = defined(TEAM_TEMPLATES.find((template) => template.id === "feature"));

describe("planTeam", () => {
  it("uses the template's agents when they are installed", () => {
    const plan = planTeam(feature, {
      agents: [
        { id: "claude", label: "Claude", available: true },
        { id: "codex", label: "Codex", available: true },
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

  it("stands in the default agent and skips worktrees outside git", () => {
    const plan = planTeam(feature, {
      agents: [
        { id: "claude", label: "Claude", available: true },
        { id: "codex", label: "Codex", available: false },
        { id: "kimi", label: "Kimi", available: true },
      ],
      defaultAgent: "kimi",
      canIsolate: false,
    });
    expect(plan.members[2]).toEqual({ role: "executor", agent: "kimi", shouldUseWorktree: false, isSubstituted: true });
    expect(plan.members.every((member) => !member.shouldUseWorktree)).toBe(true);
  });

  it("is blocked when no agent is installed", () => {
    expect(planTeam(feature, { agents: [{ id: "shell", label: "Shell", available: true }], defaultAgent: null, canIsolate: true }).isBlocked).toBe(true);
  });
});
