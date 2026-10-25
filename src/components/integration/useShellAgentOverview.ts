import { useCallback, useMemo } from "react";
import { useT } from "../../i18n";
import { buildAgentLabels, type AgentLabel } from "../../domain/agentLabels";
import { deriveAgentStatus, type AgentRunStatus } from "../../domain/agentStatus";
import type { McpAgentState } from "../../domain/mcp.model";
import type { Workspace } from "../../domain/workspace.model";
import { useReportedStates } from "../../stores/mcpStore";
import { usePreferencesStore } from "../../stores/preferencesStore";
import type { CollapsedSidebarProject } from "../shell/Sidebar";
import { projectStatus } from "./visualShellModel";

export interface ShellAgentSignals {
  workspaces: readonly Workspace[];
  titles: Readonly<Record<string, string>>;
  exited: Readonly<Record<string, number | null>>;
  notifications: Readonly<Record<string, number>>;
  contextUsage: Readonly<Record<string, number>>;
}

export type AgentStatusOf = (terminal: { id: string; suspended?: boolean }) => AgentRunStatus;

export interface ShellAgentOverview {
  agentLabels: Record<string, AgentLabel>;
  agentStatus: AgentStatusOf;
  reported: Record<string, McpAgentState>;
  attentionCount: number;
  activeCount: number;
  railProjects: CollapsedSidebarProject[];
}

function countTerminals(workspaces: readonly Workspace[], matches: (terminal: Workspace["terminals"][number]) => boolean): number {
  return workspaces.reduce((count, workspace) => count + workspace.terminals.filter(matches).length, 0);
}

export function useShellAgentOverview({ workspaces, titles, exited, notifications, contextUsage }: ShellAgentSignals): ShellAgentOverview {
  const translate = useT();
  const agentNames = usePreferencesStore((state) => state.agentNames);
  const agentLabels = useMemo(() => buildAgentLabels(workspaces, { titles, names: agentNames }), [agentNames, titles, workspaces]);
  const reported = useReportedStates();
  const agentStatus = useCallback<AgentStatusOf>((terminal) => deriveAgentStatus({
    suspended: terminal.suspended,
    exited: terminal.id in exited,
    notifications: notifications[terminal.id],
    contextUsed: contextUsage[terminal.id],
    reported: reported[terminal.id],
  }), [contextUsage, exited, notifications, reported]);
  const railProjects = useMemo<CollapsedSidebarProject[]>(() => workspaces.map((workspace) => {
    const agents = workspace.terminals.map((terminal) => {
      const status = agentStatus(terminal);
      const label = agentLabels[terminal.id];
      const detail = translate(`status.${status}Lower` as const);
      return { id: terminal.id, label: label?.primary ?? terminal.command, status, detail };
    });
    const suspended = workspace.terminals.length > 0 && workspace.terminals.every((terminal) => terminal.suspended);
    const status = projectStatus(agents.map((agent) => agent.status));
    return { id: workspace.id, name: workspace.name, status, suspended, agents };
  }), [agentLabels, agentStatus, workspaces, translate]);
  return {
    agentLabels,
    agentStatus,
    reported,
    attentionCount: countTerminals(workspaces, (terminal) => agentStatus(terminal) === "attention"),
    activeCount: countTerminals(workspaces, (terminal) => !(terminal.id in exited) && !terminal.suspended),
    railProjects,
  };
}
