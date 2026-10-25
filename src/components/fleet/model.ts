import { agentKind } from "../../domain/agentLabels";
import { deriveAgentStatus, type AgentRunStatus } from "../../domain/agentStatus";
import type { McpAgentState } from "../../domain/mcp.model";
import { DEFAULT_AGENT_PROFILES } from "../../domain/agentProfiles";
import type { Translate } from "../../i18n";
import { elapsedTime } from "../../domain/elapsedTime";
import { clamp } from "../../lib/math/clamp";
import { MS_PER_SECOND, SECONDS_PER_HOUR, SECONDS_PER_MINUTE } from "../../lib/time/durations";
import type { TerminalMeta } from "../../domain/terminal.model";
import type { Workspace, WorkspaceGroup } from "../../domain/workspace.model";

export type FleetStatus = AgentRunStatus;

export type FleetStatusFilter = FleetStatus | "all";

export type FleetViewMode = "cards" | "list";

export type FleetValue = number | string | Date;

export interface FleetFilters {
  groupId: string;
  status: FleetStatusFilter;
  agent: string;
  query: string;
}

export interface FleetDerivationInput {
  workspaces: readonly Workspace[];
  groups?: readonly WorkspaceGroup[];
  exited?: Readonly<Record<string, number | null>>;
  notifications?: Readonly<Record<string, number>>;
  contextUsage?: Readonly<Record<string, number>>;
  titles?: Readonly<Record<string, string>>;
  branches?: Readonly<Record<string, string>>;
  lastActivity?: Readonly<Record<string, FleetValue>>;
  durations?: Readonly<Record<string, FleetValue>>;
  agentLabels?: Readonly<Record<string, string>>;
  reported?: Readonly<Record<string, McpAgentState>>;
}

export interface FleetAgentModel {
  id: string;
  terminalId: string;
  workspaceId: string;
  workspaceName: string;
  projectId: string;
  projectName: string;
  groupId: string;
  groupName: string;
  label: string;
  title: string;
  command: string;
  cwd: string;
  branch: string;
  status: FleetStatus;
  contextUsage: number | null;
  notificationCount: number;
  exitCode: number | null | undefined;
  lastActivity?: FleetValue;
  duration?: FleetValue;
}

export interface FleetProjectModel {
  id: string;
  name: string;
  cwd: string;
  branch: string;
  groupId: string;
  groupName: string;
  status: FleetStatus;
  agents: FleetAgentModel[];
}

export interface FleetGroupModel {
  id: string;
  name: string;
  isSuspended: boolean;
  status: FleetStatus;
  projects: FleetProjectModel[];
}

export interface FleetSummary {
  total: number;
  working: number;
  idle: number;
  attention: number;
  suspended: number;
  exited: number;
}

export interface FleetModel {
  agents: FleetAgentModel[];
  groups: FleetGroupModel[];
  summary: FleetSummary;
}

export const DEFAULT_FLEET_FILTERS: FleetFilters = {
  groupId: "all",
  status: "all",
  agent: "all",
  query: "",
};

const EMPTY_RECORD: Readonly<Record<string, never>> = {};
const DURATION_SECONDS_LIMIT = 1000;
const UNGROUPED_ID = "ungrouped";
const UNGROUPED_NAME = "—";

function clean(value: string | undefined | null, fallback = ""): string {
  const result = value?.trim();
  return result || fallback;
}

function mapValue<T>(record: Readonly<Record<string, T>> | undefined, id: string): T | undefined {
  return record?.[id];
}

const SCRIPT_EXTENSION = /\.(?:cmd|sh)$/i;
const SHELL_KIND = "shell";
const KNOWN_AGENT_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  DEFAULT_AGENT_PROFILES.filter((profile) => profile.command).map((profile) => [profile.command, profile.label]),
);

function agentLabelFromCommand(command: string, translate: Translate): string {
  const kind = agentKind(command).replace(SCRIPT_EXTENSION, "");
  if (kind === SHELL_KIND) return translate("fleet.shellAgent");
  return KNOWN_AGENT_LABELS[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
}

const MIN_CONTEXT_USAGE = 0;
const MAX_CONTEXT_USAGE = 100;

function clampContext(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return clamp(value, MIN_CONTEXT_USAGE, MAX_CONTEXT_USAGE);
}

function membershipByWorkspace(
  workspaces: readonly Workspace[],
  groups: readonly WorkspaceGroup[],
): Map<string, WorkspaceGroup> {
  const result = new Map<string, WorkspaceGroup>();
  const byId = new Map(groups.map((group) => [group.id, group]));
  for (const workspace of workspaces) {
    const direct = workspace.groupId ? byId.get(workspace.groupId) : undefined;
    if (direct) {
      result.set(workspace.id, direct);
      continue;
    }
    const listed = groups.find((group) => group.projectIds.includes(workspace.id));
    if (listed) result.set(workspace.id, listed);
  }
  return result;
}

export const FLEET_STATUS_PRIORITY: readonly FleetStatus[] = ["attention", "working", "idle", "suspended", "exited"];

export function fleetAggregateStatus(statuses: readonly FleetStatus[]): FleetStatus {
  if (statuses.length === 0) return "working";
  return FLEET_STATUS_PRIORITY.find((status) => statuses.includes(status)) ?? "working";
}

function groupForId(groups: readonly WorkspaceGroup[], id: string): WorkspaceGroup {
  return (
    groups.find((group) => group.id === id) ?? {
      id: UNGROUPED_ID,
      name: UNGROUPED_NAME,
      isCollapsed: false,
      projectIds: [],
      parentGroupId: null,
      isSuspended: false,
    }
  );
}

interface AgentPlacement {
  workspace: Workspace;
  terminal: TerminalMeta;
  group: WorkspaceGroup;
}

function makeAgent(placement: AgentPlacement, input: FleetDerivationInput, translate: Translate): FleetAgentModel {
  const { workspace, terminal, group } = placement;
  const exited = input.exited ?? EMPTY_RECORD as Readonly<Record<string, number | null>>;
  const notifications = input.notifications ?? EMPTY_RECORD as Readonly<Record<string, number>>;
  const contextUsage = input.contextUsage ?? EMPTY_RECORD as Readonly<Record<string, number>>;
  const isGroupSuspended = Boolean(group.isSuspended || workspace.terminals.length > 0 && workspace.terminals.every((item) => item.isSuspended));
  const command = clean(terminal.command, "shell");
  const label = clean(mapValue(input.agentLabels, terminal.id), agentLabelFromCommand(command, translate));
  const title = clean(mapValue(input.titles, terminal.id));
  return {
    id: terminal.id,
    terminalId: terminal.id,
    workspaceId: workspace.id,
    workspaceName: clean(workspace.name, workspace.id),
    projectId: workspace.id,
    projectName: clean(workspace.name, workspace.id),
    groupId: group.id,
    groupName: clean(group.name, group.id),
    label,
    title,
    command,
    cwd: workspace.cwd,
    branch: clean(mapValue(input.branches, workspace.id)),
    status: deriveAgentStatus({
      isSuspended: isGroupSuspended || terminal.isSuspended,
      hasExited: terminal.id in exited,
      notifications: notifications[terminal.id],
      contextUsed: contextUsage[terminal.id],
      reported: input.reported?.[terminal.id],
    }),
    contextUsage: clampContext(mapValue(contextUsage, terminal.id)),
    notificationCount: Math.max(0, mapValue(notifications, terminal.id) ?? 0),
    exitCode: mapValue(exited, terminal.id),
    lastActivity: mapValue(input.lastActivity, terminal.id),
    duration: mapValue(input.durations, terminal.id),
  };
}

function projectStatus(agents: readonly FleetAgentModel[]): FleetStatus {
  return fleetAggregateStatus(agents.map((agent) => agent.status));
}

function summaryFor(agents: readonly FleetAgentModel[]): FleetSummary {
  return {
    total: agents.length,
    working: agents.filter((agent) => agent.status === "working").length,
    idle: agents.filter((agent) => agent.status === "idle").length,
    attention: agents.filter((agent) => agent.status === "attention").length,
    suspended: agents.filter((agent) => agent.status === "suspended").length,
    exited: agents.filter((agent) => agent.status === "exited").length,
  };
}

function groupModelFromAgents(
  group: WorkspaceGroup,
  workspaces: readonly Workspace[],
  agents: readonly FleetAgentModel[],
): FleetGroupModel {
  const projects = workspaces
    .map((workspace): FleetProjectModel | null => {
      const projectAgents = agents.filter((agent) => agent.workspaceId === workspace.id);
      if (projectAgents.length === 0) return null;
      return {
        id: workspace.id,
        name: clean(workspace.name, workspace.id),
        cwd: workspace.cwd,
        branch: projectAgents[0]?.branch ?? "",
        groupId: group.id,
        groupName: clean(group.name, group.id),
        status: projectStatus(projectAgents),
        agents: [...projectAgents],
      };
    })
    .filter((project): project is FleetProjectModel => project !== null);
  return {
    id: group.id,
    name: clean(group.name, group.id),
    isSuspended: Boolean(group.isSuspended),
    status: projectStatus(projects.flatMap((project) => project.agents)),
    projects,
  };
}

export function deriveFleetModel(input: FleetDerivationInput, translate: Translate): FleetModel {
  const workspaces = input.workspaces ?? [];
  const groups = input.groups ?? [];
  const membership = membershipByWorkspace(workspaces, groups);
  const ungrouped = groupForId(groups, UNGROUPED_ID);
  const agents = workspaces.flatMap((workspace) => {
    const group = membership.get(workspace.id) ?? ungrouped;
    return workspace.terminals.map((terminal) => makeAgent({ workspace, terminal, group }, input, translate));
  });

  const groupModels = [
    ...groups.map((group) => groupModelFromAgents(
      group,
      workspaces.filter((workspace) => membership.get(workspace.id)?.id === group.id),
      agents.filter((agent) => agent.groupId === group.id),
    )),
    groupModelFromAgents(
      ungrouped,
      workspaces.filter((workspace) => !membership.has(workspace.id)),
      agents.filter((agent) => agent.groupId === UNGROUPED_ID),
    ),
  ].filter((group) => group.projects.length > 0);

  return { agents, groups: groupModels, summary: summaryFor(agents) };
}

function searchText(agent: FleetAgentModel): string {
  return [
    agent.label,
    agent.title,
    agent.command,
    agent.cwd,
    agent.branch,
    agent.workspaceName,
    agent.groupName,
  ].join(" ").toLocaleLowerCase();
}

export function filterFleetModel(model: FleetModel, filters: Partial<FleetFilters> = {}): FleetModel {
  const groupId = filters.groupId ?? "all";
  const status = filters.status ?? "all";
  const agent = filters.agent ?? "all";
  const query = (filters.query ?? "").trim().toLocaleLowerCase();
  const filteredAgents = model.agents.filter((candidate) => {
    if (groupId !== "all" && candidate.groupId !== groupId) return false;
    if (status !== "all" && candidate.status !== status) return false;
    if (agent !== "all" && candidate.label !== agent) return false;
    return !query || searchText(candidate).includes(query);
  });

  const groups = model.groups
    .map((group): FleetGroupModel => {
      const groupAgents = filteredAgents.filter((candidate) => candidate.groupId === group.id);
      const projects = group.projects
        .map((project): FleetProjectModel | null => {
          const projectAgents = groupAgents.filter((candidate) => candidate.workspaceId === project.id);
          return projectAgents.length === 0 ? null : {
            ...project,
            status: projectStatus(projectAgents),
            agents: projectAgents,
          };
        })
        .filter((project): project is FleetProjectModel => project !== null);
      return { ...group, status: projectStatus(projects.flatMap((project) => project.agents)), projects };
    })
    .filter((group) => group.projects.length > 0);

  return { agents: filteredAgents, groups, summary: summaryFor(filteredAgents) };
}

export function formatFleetDuration(value: FleetValue | undefined, now: number, translate: Translate): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string") return value;
  if (value instanceof Date) return formatFleetRelativeTime(value.getTime(), now, translate);
  if (!Number.isFinite(value)) return null;
  const milliseconds = value < DURATION_SECONDS_LIMIT ? value * MS_PER_SECOND : value;
  const totalSeconds = Math.max(0, Math.floor(milliseconds / MS_PER_SECOND));
  const hours = Math.floor(totalSeconds / SECONDS_PER_HOUR);
  const minutes = Math.floor((totalSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const seconds = totalSeconds % SECONDS_PER_MINUTE;
  if (hours > 0) return translate("time.durationHours", { hours, minutes: String(minutes).padStart(2, "0") });
  if (minutes > 0) return translate("time.durationMinutes", { minutes, seconds: String(seconds).padStart(2, "0") });
  return translate("time.durationSeconds", { seconds });
}

export function formatFleetRelativeTime(value: FleetValue | undefined, now: number, translate: Translate): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string") return value;
  const timestamp = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(timestamp)) return null;
  const elapsed = elapsedTime(timestamp, now);
  if (elapsed.unit === "now") return translate("time.ago.now");
  if (elapsed.unit === "minutes") return translate("time.ago.minutes", { count: elapsed.count });
  if (elapsed.unit === "hours") return translate("time.ago.hours", { count: elapsed.count });
  return translate("time.ago.days", { count: elapsed.count });
}

