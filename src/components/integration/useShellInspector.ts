import type { AgentLabel } from "../../domain/agentLabels";
import type { NotificationItem } from "../../domain/notification.model";
import { useAgentUsage } from "../../app/useAgentUsage";
import { useInspectorRuntime } from "../../app/useInspectorRuntime";
import type { AgentInspectorProps } from "../inspector/AgentInspector";
import { resolveInspectorTarget, type ResolveInspectorTargetOptions } from "../inspector/inspectorModel";
import type { AgentStatusOf } from "./useShellAgentOverview";

const INSPECTOR_ACTIVITY_LIMIT = 4;

export interface ShellInspectorSignals extends ResolveInspectorTargetOptions {
  notificationItems: readonly NotificationItem[];
}

export interface ShellInspectorAgents {
  agentLabels: Readonly<Record<string, AgentLabel | undefined>>;
  agentStatus: AgentStatusOf;
}

export interface ShellInspectorControls {
  isActive: boolean;
  onAction: AgentInspectorProps["onAction"];
}

function newestFirst(left: NotificationItem, right: NotificationItem): number {
  return right.ts - left.ts;
}

export function useShellInspector(
  signals: ShellInspectorSignals,
  agents: ShellInspectorAgents,
  controls: ShellInspectorControls,
): AgentInspectorProps {
  const runtime = useInspectorRuntime(signals.focusedId, controls.isActive);
  const target = resolveInspectorTarget(signals);
  const usage = useAgentUsage(target?.workspaceId ?? null, target?.terminalId ?? null, controls.isActive);
  const terminal = target
    ? signals.workspaces.flatMap((workspace) => workspace.terminals).find((candidate) => candidate.id === target.terminalId)
    : undefined;
  const inspectorSignals = target
    ? signals.notificationItems.filter((item) => item.terminalId === target.terminalId).sort(newestFirst)
    : [];
  return {
    target,
    label: target ? agents.agentLabels[target.terminalId] ?? null : null,
    status: terminal ? agents.agentStatus(terminal) : "working",
    request: inspectorSignals.find((item) => !item.read && !item.system) ?? null,
    activity: inspectorSignals.slice(0, INSPECTOR_ACTIVITY_LIMIT),
    runtime,
    usage,
    onAction: controls.onAction,
  };
}
