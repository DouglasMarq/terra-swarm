import { useEffect, useRef } from "react";
import type { Workspace } from "../domain/workspace.model";
import { translateNow } from "../i18n";
import { hotkeyActionLabel, matchHotkey, type HotkeyActionId, usePreferencesStore } from "../stores/preferencesStore";
import { useTerminalRuntimeStore } from "../stores/terminalRuntimeStore";
import { conflictingAction, isEditableTarget, recordedHotkey, runHotkeyAction, type HotkeyActionHandlers } from "./hotkeyActions";

interface GlobalHotkeysInput {
  isModalOpen: boolean;
  capturing: HotkeyActionId | null;
  setCapturing: (action: HotkeyActionId | null) => void;
  isShortcutsSectionOpen: boolean;
  active: Workspace | null;
  focusedId: string | null;
  workspaces: readonly Workspace[];
  actions: HotkeyActionHandlers;
}

export function useGlobalHotkeys({
  isModalOpen,
  capturing,
  setCapturing,
  isShortcutsSectionOpen,
  active,
  focusedId,
  workspaces,
  actions,
}: GlobalHotkeysInput) {
  const hotkeys = usePreferencesStore((state) => state.hotkeys);

  useEffect(() => {
    if (isShortcutsSectionOpen) return;
    setCapturing(null);
  }, [isShortcutsSectionOpen, setCapturing]);

  const latestHotkeyContext = useRef({ isModalOpen, capturing, hotkeys, active, focusedId, workspaces });
  latestHotkeyContext.current = { isModalOpen, capturing, hotkeys, active, focusedId, workspaces };
  const latestHotkeyActions = useRef(actions);
  latestHotkeyActions.current = actions;

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const { isModalOpen, capturing, hotkeys, active, focusedId, workspaces } =
        latestHotkeyContext.current;
      if (isModalOpen || capturing) return;
      if (isEditableTarget(event.target)) return;
      const matched = Object.entries(hotkeys).find(([, hk]) => matchHotkey(event, hk));
      if (!matched) return;
      event.preventDefault();
      event.stopPropagation();
      runHotkeyAction(matched[0], { active, focusedId, workspaces, actions: latestHotkeyActions.current });
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, []);

  useEffect(() => {
    if (!capturing) return;
    const handler = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setCapturing(null);
        return;
      }
      const hk = recordedHotkey(event);
      if (!hk) return;
      const conflict = conflictingAction(hk, { hotkeys, capturing });
      if (conflict) {
        useTerminalRuntimeStore.getState().pushSystemNotification(
          translateNow("app.shortcutTaken", { action: hotkeyActionLabel(conflict) }),
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
