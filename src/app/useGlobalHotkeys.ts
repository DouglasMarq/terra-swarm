import { useEffect, useRef } from "react";
import type { Workspace } from "../domain/workspace.model";
import { t } from "../i18n";
import { hotkeyActionLabel, matchHotkey, type HotkeyActionId, usePreferencesStore } from "../stores/preferencesStore";
import { useTerminalRuntimeStore } from "../stores/terminalRuntimeStore";
import { conflictingAction, isEditableTarget, recordedHotkey, runHotkeyAction, type HotkeyActionHandlers } from "./hotkeyActions";

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
  actions: HotkeyActionHandlers;
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
      if (modalOpen || capturing) return;
      if (isEditableTarget(e.target)) return;
      const matched = Object.entries(hotkeys).find(([, hk]) => matchHotkey(e, hk));
      if (!matched) return;
      e.preventDefault();
      e.stopPropagation();
      runHotkeyAction(matched[0], { active, focusedId, workspaces, actions: hotkeyActions.current });
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
      const hk = recordedHotkey(e);
      if (!hk) return;
      // Reject duplicates: dispatch stops at the first match, so a combo
      // already bound to another action would silently never fire.
      const conflict = conflictingAction(hk, { hotkeys, capturing });
      if (conflict) {
        useTerminalRuntimeStore.getState().pushSystemNotification(
          t("app.shortcutTaken", { action: hotkeyActionLabel(conflict) }),
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
  }, [capturing, hotkeys, setCapturing]);
}
