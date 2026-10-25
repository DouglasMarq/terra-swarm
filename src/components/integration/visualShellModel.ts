import { CONTEXT_ATTENTION_PERCENT, isTerminalRunning, type AgentRunStatus } from "../../domain/agentStatus";
import { latestUnreadPerAgent } from "../../domain/notifications";
import type { Translate } from "../../i18n";
import type { NotificationItem } from "../../domain/notification.model";
import type { VoiceStatus } from "../../domain/voice.model";
import type { Workspace, WorkspaceSnapshotV2 } from "../../domain/workspace.model";
import type { VoiceCapsuleState } from "../voice/voiceModel";
import type { ShellSurface } from "../../stores/shellStore";
import { selectWorkspaceContainerId } from "../../domain/session/workspaceContainerSelection";

export function visibleSnapshot(
  snapshot: WorkspaceSnapshotV2 | null,
  detachedTerminalIds: readonly string[],
  focusedId: string | null,
): WorkspaceSnapshotV2 | null {
  if (!snapshot || (detachedTerminalIds.length === 0 && !focusedId)) return snapshot;
  const detached = new Set(detachedTerminalIds);
  const tabs = snapshot.tabs.filter((tab) => !tab.ptyId || !detached.has(tab.ptyId));
  const tabIds = new Set(tabs.map((tab) => tab.id));
  const panes = snapshot.panes.map((pane) => {
    const nextTabIds = pane.tabIds.filter((id) => tabIds.has(id));
    const focusedTab = focusedId
      ? pane.tabIds
        .map((id) => snapshot.tabs.find((tab) => tab.id === id))
        .find((tab) => tab?.ptyId === focusedId)
      : undefined;
    return {
      ...pane,
      tabIds: nextTabIds,
      activeTabId: focusedTab && tabIds.has(focusedTab.id)
        ? focusedTab.id
        : pane.activeTabId && tabIds.has(pane.activeTabId)
          ? pane.activeTabId
          : nextTabIds[0] ?? null,
    };
  });
  const activeTabId = snapshot.activeTabId && tabIds.has(snapshot.activeTabId) ? snapshot.activeTabId : tabs[0]?.id ?? null;
  return { ...snapshot, tabs, panes, activeTabId };
}

export interface WorkbenchView {
  detachedTerminalIds: readonly string[];
  focusedId: string | null;
  activeProjectId: string | null;
}

export function workbenchSnapshot(snapshot: WorkspaceSnapshotV2 | null, view: WorkbenchView): WorkspaceSnapshotV2 | null {
  const visible = visibleSnapshot(snapshot, view.detachedTerminalIds, view.focusedId);
  const { activeProjectId } = view;
  if (!visible || !activeProjectId) return visible;
  return { ...visible, containers: visible.containers.filter((container) => container.projectId === activeProjectId) };
}

export function projectStatus(agentStatuses: readonly AgentRunStatus[]): "attention" | "working" | "idle" {
  if (agentStatuses.includes("attention")) return "attention";
  if (agentStatuses.includes("working")) return "working";
  return "idle";
}

export interface ContextAlert {
  terminalId: string;
  workspaceId: string;
  used: number;
}

export function nearlyFullContexts(
  workspaces: readonly Workspace[],
  exited: Readonly<Record<string, number | null>>,
  contextUsage: Readonly<Record<string, number>>,
): ContextAlert[] {
  return workspaces.flatMap((workspace) => workspace.terminals
    .filter((terminal) => isTerminalRunning(terminal, exited) && (contextUsage[terminal.id] ?? 0) >= CONTEXT_ATTENTION_PERCENT)
    .map((terminal) => ({ terminalId: terminal.id, workspaceId: workspace.id, used: contextUsage[terminal.id] ?? 0 })));
}

export function latestMessageByAgent(items: readonly NotificationItem[]): Record<string, string> {
  return Object.fromEntries(latestUnreadPerAgent(items).map((item) => [item.terminalId, item.message]));
}

export function lastActivityByAgent(items: readonly NotificationItem[]): Record<string, number> {
  const latest: Record<string, number> = {};
  for (const item of items) {
    if (item.isSystem) continue;
    latest[item.terminalId] = Math.max(latest[item.terminalId] ?? 0, item.ts);
  }
  return latest;
}

export function shellVoiceState(voiceState: VoiceCapsuleState | undefined, voiceStatus: VoiceStatus): VoiceCapsuleState {
  if (voiceState) return voiceState;
  if (voiceStatus === "recording") return "listening";
  if (voiceStatus === "transcribing") return "transcribing";
  return "idle";
}

export function shellVoiceLabel(state: VoiceCapsuleState, translate: Translate): string {
  switch (state) {
    case "listening":
      return translate("shell.voiceListening");
    case "transcribing":
      return translate("shell.voiceTranscribing");
    case "preview":
      return translate("shell.voicePreview");
    case "error":
      return translate("shell.voiceError");
    case "idle":
      return translate("shell.voice");
  }
}

export function worktreeBranchesByTerminal(workspaces: readonly Workspace[]): Record<string, string> {
  return Object.fromEntries(
    workspaces
      .flatMap((workspace) => workspace.terminals)
      .flatMap((terminal) => (terminal.worktree ? [[terminal.id, terminal.worktree.branch]] : [])),
  );
}

export function roleLabelsByTerminal(workspaces: readonly Workspace[], translate: Translate): Record<string, string> {
  return Object.fromEntries(
    workspaces
      .flatMap((workspace) => workspace.terminals)
      .flatMap((terminal) => (terminal.role ? [[terminal.id, translate(`roles.${terminal.role}`)]] : [])),
  );
}

export function containerVisibilityByWorkspace(
  snapshot: WorkspaceSnapshotV2 | null,
  workspaces: readonly Workspace[],
  focusedId: string | null,
): Record<string, boolean> {
  return Object.fromEntries(workspaces.map((workspace) => {
    const containerId = selectWorkspaceContainerId(snapshot, workspaces, {
      workspaceId: workspace.id,
      focusedTerminalId: focusedId,
    });
    return [workspace.id, containerId ? snapshot?.containers.find((container) => container.id === containerId)?.visible !== false : true];
  }));
}

export function shellSurfaceTitle(surface: ShellSurface, translate: Translate): string {
  if (surface === "fleet") return translate("common.fleet");
  if (surface === "board") return translate("common.board");
  if (surface === "settings") return translate("common.settings");
  return translate("common.appName");
}
