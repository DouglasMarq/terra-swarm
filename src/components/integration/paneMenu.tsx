import { Copy, Eraser, GitCompare, PanelRight, Pencil, Power, RotateCcw, Square, SquareArrowOutUpRight } from "lucide-react";
import type { Translate } from "../../i18n";
import { profileForCommand, resolveResumeCommand } from "../../domain/agentProfiles";
import type { PaneMenuGroups, PaneMenuItem } from "../workbench/PaneActionsMenu";
import type { CommandConfirmRequest, FocusedAgentAction } from "../overlays/CommandPalette";
import type { shellShortcutLabels } from "./shellShortcuts";

export type FocusedAgentActionHandler = (
  action: FocusedAgentAction,
  context: { workspaceId: string; terminalId: string; command: string },
) => void;

export interface PaneMenuTarget {
  ptyId: string;
  command: string;
  workspaceId: string | null;
  label: string;
  isDetached: boolean;
  hasWorktree: boolean;
}

export interface PaneMenuActions {
  onFocusedAgentAction?: FocusedAgentActionHandler;
  onRestart: (id: string, command: string) => void;
  onReattach: (id: string) => void;
  onDetach: (id: string) => void;
  onOpenInspector: (id: string) => void;
  onOpenReview: (id: string) => void;
  onRenameAgent?: (id: string) => void;
  onRequestConfirm: (request: CommandConfirmRequest) => void;
}

export interface PaneMenuLabels {
  translate: Translate;
  shortcuts: ReturnType<typeof shellShortcutLabels>;
}

interface PaneMenuInput {
  target: PaneMenuTarget;
  actions: PaneMenuActions;
  labels: PaneMenuLabels;
  canRunAgentAction: boolean;
  runAgentAction: (action: FocusedAgentAction) => void;
}

function detachItem({ target, actions, labels }: PaneMenuInput): PaneMenuItem {
  const { translate } = labels;
  if (target.isDetached) {
    return { id: "reattach", label: translate("pane.menu.reattach"), icon: <SquareArrowOutUpRight size={13} />, onSelect: () => actions.onReattach(target.ptyId) };
  }
  return { id: "detach", label: translate("pane.menu.detach"), icon: <SquareArrowOutUpRight size={13} />, onSelect: () => actions.onDetach(target.ptyId) };
}

function agentItems(input: PaneMenuInput): PaneMenuItem[] {
  const { target, actions, labels } = input;
  const { translate } = labels;
  return [
    { id: "interrupt", label: translate("pane.menu.interrupt"), icon: <Square size={13} />, shortcut: labels.shortcuts.interrupt, disabled: !input.canRunAgentAction, onSelect: () => input.runAgentAction("interrupt") },
    { id: "restart", label: translate("pane.menu.restart"), icon: <RotateCcw size={13} />, onSelect: () => actions.onRestart(target.ptyId, target.command) },
    detachItem(input),
    { id: "inspector", label: translate("pane.menu.inspector"), icon: <PanelRight size={13} />, shortcut: labels.shortcuts.inspector, onSelect: () => actions.onOpenInspector(target.ptyId) },
    ...(target.hasWorktree ? [{ id: "review", label: translate("review.open"), icon: <GitCompare size={13} />, onSelect: () => actions.onOpenReview(target.ptyId) }] : []),
  ];
}

function sessionItems(input: PaneMenuInput): PaneMenuItem[] {
  const { target, actions, labels } = input;
  const { translate } = labels;
  const resumeCommand = resolveResumeCommand(profileForCommand(target.command), target.command);
  return [
    { id: "copy-resume", label: translate("pane.menu.copyResume"), detail: resumeCommand, icon: <Copy size={13} />, onSelect: () => { void window.navigator.clipboard?.writeText(resumeCommand).catch((error) => console.warn("failed to copy the resume command:", error)); } },
    ...(actions.onRenameAgent ? [{ id: "rename", label: translate("pane.menu.rename"), icon: <Pencil size={13} />, onSelect: () => actions.onRenameAgent?.(target.ptyId) }] : []),
    { id: "clear-history", label: translate("pane.menu.clearHistory"), icon: <Eraser size={13} />, disabled: !input.canRunAgentAction, onSelect: () => input.runAgentAction("clear-scrollback") },
  ];
}

function killItem({ target, actions, labels, canRunAgentAction }: PaneMenuInput): PaneMenuItem {
  const { translate } = labels;
  return {
    id: "kill",
    label: translate("pane.menu.kill"),
    icon: <Power size={13} />,
    danger: true,
    disabled: !canRunAgentAction,
    onSelect: () => actions.onRequestConfirm({
      kind: "stop-agent",
      commandId: `pane:kill:${target.ptyId}`,
      title: translate("pane.confirmKill.title"),
      description: translate("pane.confirmKill.description"),
      resourceId: target.ptyId,
      resourceLabel: target.label,
      workspaceId: target.workspaceId ?? undefined,
      terminalId: target.ptyId,
      action: "stop",
    }),
  };
}

export function buildPaneMenu(target: PaneMenuTarget, actions: PaneMenuActions, labels: PaneMenuLabels): PaneMenuGroups {
  const { workspaceId, ptyId, command } = target;
  const input: PaneMenuInput = {
    target,
    actions,
    labels,
    canRunAgentAction: Boolean(workspaceId && actions.onFocusedAgentAction),
    runAgentAction: (action) => {
      if (workspaceId) actions.onFocusedAgentAction?.(action, { workspaceId, terminalId: ptyId, command });
    },
  };
  return [agentItems(input), sessionItems(input), [killItem(input)]];
}
