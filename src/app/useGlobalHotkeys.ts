import { useEffect, useRef } from "react";
import type { Workspace } from "../domain/workspace.model";
import { t } from "../i18n";
import { HOTKEY_ACTIONS, hotkeyActionLabel, matchHotkey, type Hotkey, type HotkeyActionId, usePreferencesStore } from "../stores/preferencesStore";
import { useTerminalRuntimeStore } from "../stores/terminalRuntimeStore";
import { useUiStore } from "../stores/uiStore";

interface GlobalHotkeysInput {
  /** A dialog is open: shortcuts stay off. */
  modalOpen: boolean;
  /** The action whose shortcut is being recorded in Settings, if any. */
  capturing: HotkeyActionId | null;
  setCapturing: (action: HotkeyActionId | null) => void;
  /** Settings → Shortcuts is on screen; capture ends when it is left. */
  shortcutsSectionOpen: boolean;
  active: Workspace | null;
  focusedId: string | null;
  workspaces: readonly Workspace[];
  actions: {
    openWorkspaceCreator: () => void;
    renameWorkspace: (workspace: Workspace) => void;
    closeWorkspace: (id: string) => unknown;
    quickNewTerminal: (workspaceId: string) => unknown;
    closeTerminal: (id: string) => unknown;
    toggleVoice: () => void;
  };
}

/** The app-wide keyboard shortcuts and recording a new one in Settings. */
export function useGlobalHotkeys({
  modalOpen,
  capturing,
  setCapturing,
  shortcutsSectionOpen,
  active,
  focusedId,
  workspaces,
  actions,
}: GlobalHotkeysInput) {
  const hotkeys = usePreferencesStore((state) => state.hotkeys);

  // Recording ends when the Shortcuts section is left: left on, it would
  // swallow every key in the app and save the next ⌘-combo as a shortcut.
  useEffect(() => {
    if (shortcutsSectionOpen) return;
    setCapturing(null);
  }, [shortcutsSectionOpen, setCapturing]);

  // Latest-values ref so the global hotkey listener can be registered once
  // instead of being torn down and re-added on every render.
  const hotkeyCtx = useRef({ modalOpen, capturing, hotkeys, active, focusedId, workspaces });
  hotkeyCtx.current = { modalOpen, capturing, hotkeys, active, focusedId, workspaces };
  const hotkeyActions = useRef(actions);
  hotkeyActions.current = actions;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const { modalOpen, capturing, hotkeys, active, focusedId, workspaces } =
        hotkeyCtx.current;
      const actions = hotkeyActions.current;
      if (modalOpen || capturing) return;
      const target = e.target as HTMLElement | null;
      if (
        target?.closest("input, select") ||
        target?.closest("textarea:not(.xterm-helper-textarea)")
      )
        return;
      for (const [action, hk] of Object.entries(hotkeys)) {
        if (!matchHotkey(e, hk)) continue;
        e.preventDefault();
        e.stopPropagation();
        switch (action) {
          case "newWorkspace":
            actions.openWorkspaceCreator();
            break;
          case "renameWorkspace":
            if (active) {
              actions.renameWorkspace(active);
            }
            break;
          case "deleteWorkspace":
            if (active) actions.closeWorkspace(active.id);
            break;
          case "newTerminal":
            if (active) actions.quickNewTerminal(active.id);
            break;
          case "closeTerminal":
            if (focusedId) actions.closeTerminal(focusedId);
            break;
          case "maximizeTerminal": {
            const last = active?.terminals[active.terminals.length - 1];
            const target =
              focusedId && active?.terminals.some((t) => t.id === focusedId)
                ? focusedId
                : last?.id;
            if (target) {
              useUiStore.getState().setExpandedId((prev) => (prev === target ? null : target));
            }
            break;
          }
          case "minimizeTerminal":
            useUiStore.getState().setExpandedId(null);
            break;
          case "increaseFontSize":
            usePreferencesStore.getState().changeFontSize(1);
            break;
          case "decreaseFontSize":
            usePreferencesStore.getState().changeFontSize(-1);
            break;
          case "resetFontSize":
            usePreferencesStore.getState().resetFontSize();
            break;
          case "toggleVoice":
            actions.toggleVoice();
            break;
          default: {
            const wsMatch = /^selectWorkspace([1-9])$/.exec(action);
            if (wsMatch) {
              const ws = workspaces[Number(wsMatch[1]) - 1];
              if (ws) {
                useUiStore.getState().setActiveId(ws.id);
                useUiStore.getState().setExpandedId(null);
              }
              break;
            }
            const termMatch = /^selectTerminal([1-9])$/.exec(action);
            if (termMatch) {
              const t = active?.terminals[Number(termMatch[1]) - 1];
              if (t) {
                useUiStore.getState().setFocusedId(t.id);
                useUiStore.getState().setExpandedId((cur) => (cur === t.id ? cur : null));
              }
            }
            break;
          }
        }
        return;
      }
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, []);

  useEffect(() => {
    if (!capturing) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturing(null);
        return;
      }
      if (["Meta", "Shift", "Control", "Alt"].includes(e.key)) return;
      const hk: Hotkey = {
        key: e.key,
        meta: e.metaKey,
        shift: e.shiftKey,
        ctrl: e.ctrlKey,
        alt: e.altKey,
      };
      if (!hk.meta && !hk.ctrl && !hk.alt) return;
      // Reject duplicates: dispatch stops at the first match, so a combo
      // already bound to another action would silently never fire.
      const conflict = HOTKEY_ACTIONS.find(
        (a) =>
          a.id !== capturing &&
          hotkeys[a.id] &&
          hotkeys[a.id].key === hk.key &&
          hotkeys[a.id].meta === hk.meta &&
          hotkeys[a.id].shift === hk.shift &&
          hotkeys[a.id].ctrl === hk.ctrl &&
          hotkeys[a.id].alt === hk.alt,
      );
      if (conflict) {
        useTerminalRuntimeStore.getState().pushSystemNotification(
          t("app.shortcutTaken", { action: hotkeyActionLabel(conflict.id) }),
        );
        setCapturing(null);
        return;
      }
      const next = { ...hotkeys, [capturing]: hk };
      usePreferencesStore.getState().setHotkeys(next);
      setCapturing(null);
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, [capturing, hotkeys]);
}
