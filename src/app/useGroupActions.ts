import type { Dispatch, SetStateAction } from "react";
import { api } from "../api";
import type { ResumeItem } from "../domain/terminal.model";
import type { Workspace, WorkspaceGroup } from "../domain/workspace.model";
import { translateNow } from "../i18n";
import { agentKind } from "../domain/agentLabels";
import { planResume } from "../domain/session/resumePlanner";
import { useOrchestrationStore } from "../stores/orchestrationStore";
import { useTerminalRuntimeStore } from "../stores/terminalRuntimeStore";
import { resumeCommandFor } from "../domain/session/resumeItems";
import type { TerminalSessions } from "./useTerminalSessions";

export type GroupSessions = Pick<TerminalSessions, "resumeItems" | "notifyResumeFailures">;

interface GroupActionsInput {
  workspaces: Workspace[];
  groups: readonly WorkspaceGroup[];
  sessions: GroupSessions;
  refresh: () => Promise<void>;
  setWorkspaces: Dispatch<SetStateAction<Workspace[]>>;
}

export function useGroupActions({ workspaces, groups, sessions, refresh, setWorkspaces }: GroupActionsInput) {
  const notify = (message: string) => useTerminalRuntimeStore.getState().pushSystemNotification(message);

  const createGroup = async (name: string) => {
    await api.createGroup(name).then(() => refresh()).catch((error) => {
      console.error("failed to create group:", error);
    });
  };

  const renameGroup = async (id: string, name: string) => {
    await api.renameGroup(id, name).then(() => refresh()).catch((err) => {
      console.error(`failed to rename group ${id}:`, err);
    });
  };

  const groupWorkspaceIds = (groupId: string): string[] => {
    const group = groups.find((candidate) => candidate.id === groupId);
    const fromGroup = group?.projectIds ?? [];
    const fromWorkspaces = workspaces
      .filter((workspace) => workspace.groupId === groupId)
      .map((workspace) => workspace.id);
    return [...new Set([...fromGroup, ...fromWorkspaces])];
  };

  const terminalEntriesForGroup = (groupId: string) =>
    groupWorkspaceIds(groupId).flatMap((workspaceId) => {
      const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
      return (workspace?.terminals ?? []).map((terminal) => ({ workspace, terminal }));
    }).filter((entry): entry is { workspace: Workspace; terminal: Workspace["terminals"][number] } => Boolean(entry.workspace));

  const suspendGroup = async (groupId: string) => {
    const entries = terminalEntriesForGroup(groupId);
    try {
      await api.suspendGroup(groupId);
    } catch (err) {
      console.error(`failed to suspend group ${groupId}:`, err);
      return;
    }
    useOrchestrationStore.getState().setGroupSuspended(groupId, true);
    const suspendedIds = new Set(entries.map(({ terminal }) => terminal.id));
    setWorkspaces((previous) => previous.map((workspace) => ({
      ...workspace,
      terminals: workspace.terminals.map((terminal) =>
        suspendedIds.has(terminal.id) ? { ...terminal, isSuspended: true } : terminal,
      ),
    })));
    await refresh();
  };

  const resumeGroup = async (groupId: string) => {
    const group = groups.find((candidate) => candidate.id === groupId);
    const groupName = group?.name ?? groupId;
    const entries = terminalEntriesForGroup(groupId);
    const candidates = entries.map(({ workspace, terminal }) => ({
      terminalId: terminal.id,
      projectId: workspace.id,
      projectName: workspace.name,
      groupId,
      groupName,
      cwd: workspace.cwd,
      command: terminal.command,
      resumeCommand: resumeCommandFor(terminal.command),
    }));
    const plan = planResume(candidates);
    const resumeItems: ResumeItem[] = plan.items.map((candidate) => ({
      terminalId: candidate.terminalId,
      wsId: candidate.projectId,
      wsName: candidate.projectName,
      cwd: candidate.cwd ?? "",
      command: candidate.command ?? "shell",
      agentId: candidate.agentId ?? agentKind(candidate.command),
      resumeCommand: candidate.resumeCommand ?? candidate.command ?? "shell",
    }));
    const results = await sessions.resumeItems(resumeItems);
    const labels = new Map(resumeItems.map((item) => [item.terminalId, groupName]));
    sessions.notifyResumeFailures(results, labels);
    const failed = results.filter((result) => result.status !== "succeeded");
    if (failed.length > 0) {
      await api.suspendGroup(groupId).catch((err) => {
        console.error(`failed to restore suspended group ${groupId}:`, err);
      });
      useOrchestrationStore.getState().setGroupSuspended(groupId, true);
      notify(
        translateNow("app.groupResumePartial", { count: failed.length, group: groupName }),
      );
      await refresh();
      return;
    }
    try {
      await api.resumeGroup(groupId);
      useOrchestrationStore.getState().setGroupSuspended(groupId, false);
    } catch (err) {
      console.error(`failed to resume group ${groupId}:`, err);
      await api.suspendGroup(groupId).catch((restoreError) => {
        console.error(`failed to restore suspended group ${groupId}:`, restoreError);
      });
      useOrchestrationStore.getState().setGroupSuspended(groupId, true);
      notify(translateNow("app.groupActivateFailed", { group: groupName }));
    }
    await refresh();
  };

  return { createGroup, renameGroup, suspendGroup, resumeGroup };
}
