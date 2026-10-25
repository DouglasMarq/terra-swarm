import type {
  AgentTokenUsage,
  Group,
  Workspace,
  WorkspaceSnapshotV2,
} from "../../types";
import { profileForCommand } from "../../domain/agentProfiles";

export type InspectorRuntimeState = "ativo" | "suspenso" | "encerrado";
export type InspectorActionKind = "focus" | "restart" | "detach" | "reattach" | "kill";

/** Lifecycle mutations must be routed through the explicit confirmation UI. */
export function inspectorActionRequiresConfirmation(action: InspectorActionKind): boolean {
  return action === "restart" || action === "kill";
}

/**
 * The Inspector is deliberately a projection of existing workspace metadata.
 * It does not manufacture process metrics: the current PTY API exposes the
 * PTY id and lifecycle state, but not a PID/CPU/memory telemetry contract.
 */
export interface InspectorTarget {
  terminalId: string;
  displayName: string;
  workspaceId: string;
  workspaceName: string;
  projectName: string;
  groupName: string | null;
  containerId: string | null;
  paneId: string | null;
  tabId: string | null;
  command: string;
  profileId: string;
  profileLabel: string;
  cwd: string;
  state: InspectorRuntimeState;
  contextUsage: number | null;
  detached: boolean;
}

export interface ResolveInspectorTargetOptions {
  focusedId: string | null;
  workspaces: readonly Workspace[];
  groups?: readonly Group[];
  snapshot?: WorkspaceSnapshotV2 | null;
  titles?: Readonly<Record<string, string>>;
  contextUsage?: Readonly<Record<string, number>>;
  exited?: Readonly<Record<string, number | null>>;
  detachedTerminalIds?: readonly string[];
}

/** Resolve the focused PTY to its project/group/container/pane/tab chain. */
export function resolveInspectorTarget(
  options: ResolveInspectorTargetOptions,
): InspectorTarget | null {
  const {
    focusedId,
    workspaces,
    groups = [],
    snapshot,
    titles = {},
    contextUsage = {},
    exited = {},
    detachedTerminalIds = [],
  } = options;
  if (!focusedId) return null;

  const match = workspaces
    .flatMap((workspace) => workspace.terminals.map((terminal) => ({ workspace, terminal })))
    .find(({ terminal }) => terminal.id === focusedId);
  if (!match) return null;

  const { workspace, terminal } = match;
  const tab = snapshot?.tabs.find(
    (candidate) => candidate.ptyId === terminal.id || candidate.id === terminal.tabId,
  ) ?? null;
  const paneId = tab?.paneId ?? terminal.paneId ?? null;
  const pane = paneId ? snapshot?.panes.find((candidate) => candidate.id === paneId) ?? null : null;
  const container = pane
    ? snapshot?.containers.find(
        (candidate) => candidate.id === pane.containerId || candidate.paneIds.includes(pane.id),
      ) ?? null
    : null;
  const project = snapshot?.projects.find((candidate) => candidate.id === workspace.id) ?? null;
  const groupId = terminal.groupId ?? workspace.groupId ?? project?.groupId ?? null;
  const group = groups.find((candidate) => candidate.id === groupId)
    ?? snapshot?.groups.find((candidate) => candidate.id === groupId)
    ?? null;
  const profile = profileForCommand(terminal.command);
  const tabSuspended = tab !== null
    && typeof tab === "object"
    && "suspended" in tab
    && Boolean((tab as { suspended?: unknown }).suspended);
  const state: InspectorRuntimeState = terminal.id in exited
    ? "encerrado"
    : terminal.suspended || tabSuspended || group?.suspended
      ? "suspenso"
      : "ativo";
  const usage = contextUsage[terminal.id];

  return {
    terminalId: terminal.id,
    displayName: titles[terminal.id] || tab?.title || profile.label || terminal.command || "Terminal",
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    projectName: project?.name ?? workspace.name,
    groupName: group?.name ?? null,
    containerId: container?.id ?? workspace.activeContainerId ?? null,
    paneId,
    tabId: tab?.id ?? terminal.tabId ?? null,
    command: terminal.command,
    profileId: profile.id,
    profileLabel: profile.label,
    cwd: tab?.cwd || workspace.cwd,
    state,
    contextUsage: typeof usage === "number" && Number.isFinite(usage) ? usage : null,
    detached: detachedTerminalIds.includes(terminal.id),
  };
}

/** Every token the agent's session spent: input, output and both cache directions. */
export function totalTokens(usage: AgentTokenUsage): number {
  return usage.input_tokens + usage.output_tokens + usage.cache_read_tokens + usage.cache_write_tokens;
}
