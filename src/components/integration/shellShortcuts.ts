import { useEffect } from "react";
import { formatShortcut, type ShortcutDefinition, type ShortcutPlatform } from "../../lib/platform/shortcuts";

const NO_MODIFIERS = { meta: false, shift: false, ctrl: false, alt: false } as const;

const SHELL_SHORTCUTS = {
  interrupt: { ...NO_MODIFIERS, key: "c", ctrl: true },
  inspector: { ...NO_MODIFIERS, key: "i", meta: true },
  sidebar: { ...NO_MODIFIERS, key: "b", meta: true },
} satisfies Record<string, ShortcutDefinition>;

interface ShellShortcutHandlers {
  toggleSidebar: () => void;
  isDockOpen: boolean;
  setDockOpen: (isOpen: boolean) => void;
  setCommandPaletteOpen: (isOpen: boolean) => void;
}

function shellShortcut(event: KeyboardEvent): "sidebar" | "inspector" | null {
  if (event.defaultPrevented || event.shiftKey || event.altKey) return null;
  if (!(event.metaKey || event.ctrlKey)) return null;
  const target = event.target;
  if (typeof Element !== "undefined" && target instanceof Element && target.closest('[role="dialog"]')) return null;
  const key = event.key.toLowerCase();
  if (key === "b") return "sidebar";
  if (key === "i") return "inspector";
  return null;
}

export function shellShortcutLabels(platform?: ShortcutPlatform): Record<keyof typeof SHELL_SHORTCUTS, string> {
  return {
    interrupt: formatShortcut(SHELL_SHORTCUTS.interrupt, platform),
    inspector: formatShortcut(SHELL_SHORTCUTS.inspector, platform),
    sidebar: formatShortcut(SHELL_SHORTCUTS.sidebar, platform),
  };
}

export function shouldOpenCommandPaletteShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) return false;
  const target = event.target;
  if (typeof Element !== "undefined" && target instanceof Element && target.closest('[role="dialog"]')) {
    return false;
  }
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
}

export function useShellShortcuts({ toggleSidebar, isDockOpen, setDockOpen, setCommandPaletteOpen }: ShellShortcutHandlers) {
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const shellKey = shellShortcut(event);
      if (shellKey === "sidebar") {
        event.preventDefault();
        toggleSidebar();
        return;
      }
      if (shellKey === "inspector") {
        event.preventDefault();
        setDockOpen(!isDockOpen);
        return;
      }
      if (!shouldOpenCommandPaletteShortcut(event)) return;
      event.preventDefault();
      setCommandPaletteOpen(true);
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [isDockOpen, setDockOpen, toggleSidebar, setCommandPaletteOpen]);
}
