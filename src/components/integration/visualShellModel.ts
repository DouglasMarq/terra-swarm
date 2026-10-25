import { CONTEXT_ATTENTION_PERCENT, isTerminalRunning, type AgentRunStatus } from "../../domain/agentStatus";
import { latestUnreadPerAgent } from "../../domain/notifications";
import type { Translate } from "../../i18n";
import type { NotificationItem } from "../../domain/notification.model";
import type { VoiceStatus } from "../../domain/voice.model";
import type { Workspace, WorkspaceSnapshotV2 } from "../../domain/workspace.model";
import type { VoiceCapsuleState } from "../voice/voiceModel";
import type { ShellSurface } from "../../stores/shellStore";
import { selectWorkspaceContainerId } from "../../domain/session/workspaceContainerSelection";

/**
 * The snapshot without the tabs of detached terminals. Each pane keeps an
 * active tab: the focused terminal's tab when the pane holds it, else its
 * own active tab while still visible, else its first visible tab.
 */
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

/** What the Workbench shows: one project at a time, the sidebar switches between them. */
export function workbenchSnapshot(
  snapshot: WorkspaceSnapshotV2 | null,
  detachedTerminalIds: readonly string[],
  focusedId: string | null,
  activeProjectId: string | null,
): WorkspaceSnapshotV2 | null {
  const visible = visibleSnapshot(snapshot, detachedTerminalIds, focusedId);
  if (!visible || !activeProjectId) return visible;
  return { ...visible, containers: visible.containers.filter((container) => container.projectId === activeProjectId) };
}

/** A project needs attention when one of its agents does, else works while one works. */
export function projectStatus(agentStatuses: readonly AgentRunStatus[]): "attention" | "working" | "idle" {
  if (agentStatuses.includes("attention")) return "attention";
  if (agentStatuses.includes("working")) return "working";
  return "idle";
}

export interface ContextAlert {
  terminalId: string;
  workspaceId: string;
  /** Percent of the context window used. */
  used: number;
}

/** Running agents whose context window is nearly full (≥ `CONTEXT_ATTENTION_PERCENT`). */
export function nearlyFullContexts(
  workspaces: readonly Workspace[],
  exited: Readonly<Record<string, number | null>>,
  contextUsage: Readonly<Record<string, number>>,
): ContextAlert[] {
  return workspaces.flatMap((workspace) => workspace.terminals
    .filter((terminal) => isTerminalRunning(terminal, exited) && (contextUsage[terminal.id] ?? 0) >= CONTEXT_ATTENTION_PERCENT)
    .map((terminal) => ({ terminalId: terminal.id, workspaceId: workspace.id, used: contextUsage[terminal.id] ?? 0 })));
}

/** The latest unread message of each agent, by terminal id. */
export function latestMessageByAgent(items: readonly NotificationItem[]): Record<string, string> {
  return Object.fromEntries(latestUnreadPerAgent(items).map((item) => [item.terminalId, item.message]));
}

/** When each agent last said something (system notices aside), by terminal id. */
export function lastActivityByAgent(items: readonly NotificationItem[]): Record<string, number> {
  const latest: Record<string, number> = {};
  for (const item of items) {
    if (item.system) continue;
    latest[item.terminalId] = Math.max(latest[item.terminalId] ?? 0, item.ts);
  }
  return latest;
}

/** The capsule state the host chose, else the one the recorder's status implies. */
export function shellVoiceState(voiceState: VoiceCapsuleState | undefined, voiceStatus: VoiceStatus): VoiceCapsuleState {
  if (voiceState) return voiceState;
  if (voiceStatus === "recording") return "listening";
  if (voiceStatus === "transcribing") return "transcribing";
  return "idle";
}

/** The label of the window chrome's voice button. */
export function shellVoiceLabel(state: VoiceCapsuleState, t: Translate): string {
  switch (state) {
    case "listening":
      return t("shell.voiceListening");
    case "transcribing":
      return t("shell.voiceTranscribing");
    case "preview":
      return t("shell.voicePreview");
    case "error":
      return t("shell.voiceError");
    case "idle":
      return t("shell.voice");
  }
}

/** The worktree branch of each isolated agent, by terminal id. */
export function worktreeBranchesByTerminal(workspaces: readonly Workspace[]): Record<string, string> {
  return Object.fromEntries(
    workspaces
      .flatMap((workspace) => workspace.terminals)
      .flatMap((terminal) => (terminal.worktree ? [[terminal.id, terminal.worktree.branch]] : [])),
  );
}

/** The translated team role of each agent that has one, by terminal id. */
export function roleLabelsByTerminal(workspaces: readonly Workspace[], t: Translate): Record<string, string> {
  return Object.fromEntries(
    workspaces
      .flatMap((workspace) => workspace.terminals)
      .flatMap((terminal) => (terminal.role ? [[terminal.id, t(`roles.${terminal.role}`)]] : [])),
  );
}

/** Whether each workspace's selected container is visible, by workspace id. */
export function containerVisibilityByWorkspace(
  snapshot: WorkspaceSnapshotV2 | null,
  workspaces: readonly Workspace[],
  focusedId: string | null,
): Record<string, boolean> {
  return Object.fromEntries(workspaces.map((workspace) => {
    const containerId = selectWorkspaceContainerId(snapshot, workspaces, workspace.id, {
      focusedTerminalId: focusedId,
    });
    return [workspace.id, containerId ? snapshot?.containers.find((container) => container.id === containerId)?.visible !== false : true];
  }));
}

/** The window title of each shell surface. */
export function shellSurfaceTitle(surface: ShellSurface, t: Translate): string {
  if (surface === "fleet") return t("common.fleet");
  if (surface === "board") return t("common.board");
  if (surface === "settings") return t("common.settings");
  return t("common.appName");
}
