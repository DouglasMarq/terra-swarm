import type { AgentInfo, AgentRole } from "./agent.model";

export interface TeamMember {
  role: AgentRole;
  agent: string;
  shouldUseWorktree?: boolean;
}

export interface TeamTemplate {
  id: "feature" | "pair" | "review";
  members: readonly TeamMember[];
}

export const TEAM_TEMPLATES: readonly TeamTemplate[] = [
  {
    id: "feature",
    members: [
      { role: "orchestrator", agent: "claude" },
      { role: "executor", agent: "claude", shouldUseWorktree: true },
      { role: "executor", agent: "codex", shouldUseWorktree: true },
      { role: "reviewer", agent: "claude" },
      { role: "tester", agent: "claude", shouldUseWorktree: true },
    ],
  },
  {
    id: "pair",
    members: [
      { role: "orchestrator", agent: "claude" },
      { role: "executor", agent: "claude", shouldUseWorktree: true },
    ],
  },
  {
    id: "review",
    members: [
      { role: "reviewer", agent: "claude" },
      { role: "tester", agent: "codex" },
    ],
  },
];

export interface PlannedMember {
  role: AgentRole;
  agent: string;
  shouldUseWorktree: boolean;
  isSubstituted: boolean;
}

export interface TeamPlan {
  members: PlannedMember[];
  isBlocked: boolean;
}

export interface TeamRoster {
  agents: readonly AgentInfo[];
  defaultAgent: string | null;
  canIsolate: boolean;
}

export function planTeam(template: TeamTemplate, roster: TeamRoster): TeamPlan {
  const { agents, defaultAgent, canIsolate } = roster;
  const available = agents.filter((agent) => agent.available && agent.id !== "shell");
  const has = (id: string | null): id is string => Boolean(id && available.some((agent) => agent.id === id));
  const fallback = has(defaultAgent) ? defaultAgent : available[0]?.id ?? null;
  if (!fallback) return { members: [], isBlocked: true };
  const members = template.members.map((member) => {
    const isInstalled = has(member.agent);
    return {
      role: member.role,
      agent: isInstalled ? member.agent : fallback,
      shouldUseWorktree: Boolean(member.shouldUseWorktree && canIsolate),
      isSubstituted: !isInstalled,
    };
  });
  return { members, isBlocked: false };
}
