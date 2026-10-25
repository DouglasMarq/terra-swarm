import type { TerminalMeta } from "../domain/terminal.model";
import type { Workspace } from "../domain/workspace.model";
import { HOTKEY_ACTIONS, usePreferencesStore, type Hotkey, type HotkeyActionId } from "../stores/preferencesStore";
import { useUiStore } from "../stores/uiStore";

const FONT_SIZE_STEP = 1;
const WORKSPACE_SLOT_PATTERN = /^selectWorkspace([1-9])$/;
const TERMINAL_SLOT_PATTERN = /^selectTerminal([1-9])$/;
const MODIFIER_KEYS = ["Meta", "Shift", "Control", "Alt"];
const EDITABLE_TARGETS = "input, select";
const EDITABLE_TEXTAREAS = "textarea:not(.xterm-helper-textarea)";

export interface HotkeyActionHandlers {
  openWorkspaceCreator: () => void;
  renameWorkspace: (workspace: Workspace) => void;
  closeWorkspace: (id: string) => unknown;
  quickNewTerminal: (workspaceId: string) => unknown;
  closeTerminal: (id: string) => unknown;
  toggleVoice: () => void;
}

export interface HotkeyActionContext {
  active: Workspace | null;
  focusedId: string | null;
  workspaces: readonly Workspace[];
  actions: HotkeyActionHandlers;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(EDITABLE_TARGETS) || target.closest(EDITABLE_TEXTAREAS));
}

function maximizeTarget(active: Workspace | null, focusedId: string | null): string | undefined {
  const last = active?.terminals[active.terminals.length - 1];
  return focusedId && active?.terminals.some((terminal) => terminal.id === focusedId) ? focusedId : last?.id;
}

function toggleMaximized(active: Workspace | null, focusedId: string | null): void {
  const target = maximizeTarget(active, focusedId);
  if (!target) return;
  useUiStore.getState().setExpandedId((prev) => (prev === target ? null : target));
}

function slotIndex(action: string, pattern: RegExp): number | null {
  const match = pattern.exec(action);
  return match ? Number(match[1]) - 1 : null;
}

function showWorkspace(workspace: Workspace | undefined): void {
  if (!workspace) return;
  useUiStore.getState().setActiveId(workspace.id);
  useUiStore.getState().setExpandedId(null);
}

function focusTerminal(terminal: TerminalMeta | undefined): void {
  if (!terminal) return;
  useUiStore.getState().setFocusedId(terminal.id);
  useUiStore.getState().setExpandedId((current) => (current === terminal.id ? current : null));
}

function runSlotAction(action: string, context: HotkeyActionContext): void {
  const workspaceIndex = slotIndex(action, WORKSPACE_SLOT_PATTERN);
  if (workspaceIndex !== null) {
    showWorkspace(context.workspaces[workspaceIndex]);
    return;
  }
  const terminalIndex = slotIndex(action, TERMINAL_SLOT_PATTERN);
  if (terminalIndex !== null) focusTerminal(context.active?.terminals[terminalIndex]);
}

export function runHotkeyAction(action: string, context: HotkeyActionContext): void {
  const { active, focusedId, actions } = context;
  switch (action) {
    case "newWorkspace":
      actions.openWorkspaceCreator();
      return;
    case "renameWorkspace":
      if (active) actions.renameWorkspace(active);
      return;
    case "deleteWorkspace":
      if (active) actions.closeWorkspace(active.id);
      return;
    case "newTerminal":
      if (active) actions.quickNewTerminal(active.id);
      return;
    case "closeTerminal":
      if (focusedId) actions.closeTerminal(focusedId);
      return;
    case "maximizeTerminal":
      toggleMaximized(active, focusedId);
      return;
    case "minimizeTerminal":
      useUiStore.getState().setExpandedId(null);
      return;
    case "increaseFontSize":
      usePreferencesStore.getState().changeFontSize(FONT_SIZE_STEP);
      return;
    case "decreaseFontSize":
      usePreferencesStore.getState().changeFontSize(-FONT_SIZE_STEP);
      return;
    case "resetFontSize":
      usePreferencesStore.getState().resetFontSize();
      return;
    case "toggleVoice":
      actions.toggleVoice();
      return;
    default:
      runSlotAction(action, context);
  }
}

export function recordedHotkey(event: KeyboardEvent): Hotkey | null {
  if (MODIFIER_KEYS.includes(event.key)) return null;
  const hotkey: Hotkey = {
    key: event.key,
    meta: event.metaKey,
    shift: event.shiftKey,
    ctrl: event.ctrlKey,
    alt: event.altKey,
  };
  if (!hotkey.meta && !hotkey.ctrl && !hotkey.alt) return null;
  return hotkey;
}

function sameHotkey(left: Hotkey, right: Hotkey): boolean {
  return left.key === right.key
    && left.meta === right.meta
    && left.shift === right.shift
    && left.ctrl === right.ctrl
    && left.alt === right.alt;
}

export interface HotkeyCapture {
  hotkeys: Readonly<Record<HotkeyActionId, Hotkey>>;
  capturing: HotkeyActionId;
}

export function conflictingAction(hotkey: Hotkey, capture: HotkeyCapture): HotkeyActionId | null {
  const conflict = HOTKEY_ACTIONS.find(
    (candidate) => candidate.id !== capture.capturing && capture.hotkeys[candidate.id] && sameHotkey(capture.hotkeys[candidate.id], hotkey),
  );
  return conflict?.id ?? null;
}
