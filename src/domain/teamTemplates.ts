import type { AgentInfo, AgentRole } from "./agent.model";

export interface TeamMember {
  role: AgentRole;
  /** Preferred agent profile; another available one stands in when it is missing. */
  agent: string;
  /** Work in an isolated git worktree (only in git projects). */
  worktree?: boolean;
}

export interface TeamTemplate {
  /** Also the i18n key under `teams.`. */
  id: "feature" | "pair" | "review";
  members: readonly TeamMember[];
}

export const TEAM_TEMPLATES: readonly TeamTemplate[] = [
  {
    id: "feature",
    members: [
      { role: "orchestrator", agent: "claude" },
      { role: "executor", agent: "claude", worktree: true },
      { role: "executor", agent: "codex", worktree: true },
      { role: "reviewer", agent: "claude" },
      { role: "tester", agent: "claude", worktree: true },
    ],
  },
  {
    id: "pair",
    members: [
      { role: "orchestrator", agent: "claude" },
      { role: "executor", agent: "claude", worktree: true },
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
  worktree: boolean;
  /** The preferred agent was not installed, so `agent` stands in. */
  substituted: boolean;
}

export interface TeamPlan {
  members: PlannedMember[];
  /** Nothing usable is installed: the team cannot start. */
  blocked: boolean;
}

/**
 * Which agent fills each seat: the template's choice when installed, else
 * the user's default agent, else the first installed coding agent.
 */
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
  if (!fallback) return { members: [], blocked: true };
  const members = template.members.map((member) => {
    const installed = has(member.agent);
    return {
      role: member.role,
      agent: installed ? member.agent : fallback,
      worktree: Boolean(member.worktree && canIsolate),
      substituted: !installed,
    };
  });
  return { members, blocked: false };
}
