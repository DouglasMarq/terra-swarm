import { create } from "zustand";
import {
  detectShortcutPlatform,
  formatShortcut,
  type ShortcutPlatform,
} from "../lib/platform/shortcuts";

export interface Hotkey {
  key: string;
  meta: boolean;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

const mk = (
  key: string,
  meta = false,
  shift = false,
  ctrl = false,
  alt = false,
): Hotkey => ({ key, meta, shift, ctrl, alt });

const IS_MAC = detectShortcutPlatform() === "mac";

const wsSelect = (n: number): Hotkey =>
  IS_MAC ? mk(String(n), true) : mk(String(n), false, false, true);

const termSelect = (n: number): Hotkey =>
  IS_MAC ? mk(String(n), true, true) : mk(String(n), false, true, true);

// On Windows the meta key is the Win key: Win+W opens Widgets, Win+Enter
// launches Narrator, Win+= drives the Magnifier, etc. Use Ctrl+Shift / Alt
// combos there; keep Cmd combos on macOS.
export const DEFAULT_HOTKEYS: Record<string, Hotkey> = {
  newWorkspace: IS_MAC ? mk("n", true, true) : mk("n", false, true, true),
  renameWorkspace: IS_MAC ? mk("r", true, true) : mk("r", false, true, true),
  deleteWorkspace: IS_MAC
    ? mk("Backspace", true, true)
    : mk("Backspace", false, true, true),
  newTerminal: IS_MAC ? mk("t", true) : mk("t", false, true, true),
  closeTerminal: IS_MAC ? mk("w", true) : mk("w", false, true, true),
  maximizeTerminal: IS_MAC
    ? mk("Enter", true)
    : mk("Enter", false, false, false, true),
  minimizeTerminal: IS_MAC
    ? mk("Enter", true, true)
    : mk("Enter", false, true, false, true),
  increaseFontSize: IS_MAC ? mk("=", true) : mk("=", false, false, true),
  decreaseFontSize: IS_MAC ? mk("-", true) : mk("-", false, false, true),
  resetFontSize: IS_MAC ? mk("0", true) : mk("0", false, false, true),
  toggleVoice: IS_MAC ? mk(" ", true, true) : mk(" ", false, true, true),
  selectWorkspace1: wsSelect(1),
  selectWorkspace2: wsSelect(2),
  selectWorkspace3: wsSelect(3),
  selectWorkspace4: wsSelect(4),
  selectWorkspace5: wsSelect(5),
  selectWorkspace6: wsSelect(6),
  selectWorkspace7: wsSelect(7),
  selectWorkspace8: wsSelect(8),
  selectWorkspace9: wsSelect(9),
  selectTerminal1: termSelect(1),
  selectTerminal2: termSelect(2),
  selectTerminal3: termSelect(3),
  selectTerminal4: termSelect(4),
  selectTerminal5: termSelect(5),
  selectTerminal6: termSelect(6),
  selectTerminal7: termSelect(7),
  selectTerminal8: termSelect(8),
  selectTerminal9: termSelect(9),
};

export const HOTKEY_ACTIONS = [
  { id: "newWorkspace", label: "Novo workspace" },
  { id: "renameWorkspace", label: "Renomear workspace" },
  { id: "deleteWorkspace", label: "Excluir workspace" },
  { id: "newTerminal", label: "Novo agente" },
  { id: "closeTerminal", label: "Fechar agente em foco" },
  { id: "maximizeTerminal", label: "Maximizar pane (alternar)" },
  { id: "minimizeTerminal", label: "Voltar à grade" },
  { id: "increaseFontSize", label: "Aumentar fonte do terminal" },
  { id: "decreaseFontSize", label: "Diminuir fonte do terminal" },
  { id: "resetFontSize", label: "Restaurar fonte do terminal" },
  { id: "toggleVoice", label: "Abrir ou fechar a voz" },
  { id: "selectWorkspace1", label: "Ir para o workspace 1" },
  { id: "selectWorkspace2", label: "Ir para o workspace 2" },
  { id: "selectWorkspace3", label: "Ir para o workspace 3" },
  { id: "selectWorkspace4", label: "Ir para o workspace 4" },
  { id: "selectWorkspace5", label: "Ir para o workspace 5" },
  { id: "selectWorkspace6", label: "Ir para o workspace 6" },
  { id: "selectWorkspace7", label: "Ir para o workspace 7" },
  { id: "selectWorkspace8", label: "Ir para o workspace 8" },
  { id: "selectWorkspace9", label: "Ir para o workspace 9" },
  { id: "selectTerminal1", label: "Focar o agente 1" },
  { id: "selectTerminal2", label: "Focar o agente 2" },
  { id: "selectTerminal3", label: "Focar o agente 3" },
  { id: "selectTerminal4", label: "Focar o agente 4" },
  { id: "selectTerminal5", label: "Focar o agente 5" },
  { id: "selectTerminal6", label: "Focar o agente 6" },
  { id: "selectTerminal7", label: "Focar o agente 7" },
  { id: "selectTerminal8", label: "Focar o agente 8" },
  { id: "selectTerminal9", label: "Focar o agente 9" },
] as const;

/** Keep persisted shortcuts executable when a profile moves between OSes. */
export function normalizeHotkeyForPlatform(
  hotkey: Hotkey,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): Hotkey {
  if (platform === "other" && hotkey.meta && !hotkey.ctrl) {
    return { ...hotkey, meta: false, ctrl: true };
  }
  if (platform === "mac" && hotkey.ctrl && !hotkey.meta) {
    return { ...hotkey, ctrl: false, meta: true };
  }
  return { ...hotkey };
}

export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 32;
export const DEFAULT_FONT_SIZE = 13;
export const GRID_COL_OPTIONS = [2, 3, 4, 5, 6, 7, 8] as const;
const DEFAULT_GRID_COLS = 2;

const storageGet = (key: string): string | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
};

const storageSet = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable in private or restricted web views.
  }
};

const storageRemove = (key: string): void => {
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage can be unavailable in private or restricted web views.
  }
};

export function loadHotkeys(): Record<string, Hotkey> {
  try {
    const raw = storageGet("hotkeys");
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      const clean: Record<string, Hotkey> = {};
      for (const [action, def] of Object.entries(DEFAULT_HOTKEYS)) {
        const value = (parsed as Record<string, unknown>)?.[action];
        if (
          value &&
          typeof value === "object" &&
          typeof (value as Hotkey).key === "string" &&
          (value as Hotkey).key.length > 0 &&
          ["meta", "shift", "ctrl", "alt"].every(
            (modifier) =>
              typeof (value as unknown as Record<string, unknown>)[modifier] ===
              "boolean",
          )
        ) {
          const hotkey = value as Hotkey;
          clean[action] = normalizeHotkeyForPlatform({
            key: hotkey.key,
            meta: hotkey.meta,
            shift: hotkey.shift,
            ctrl: hotkey.ctrl,
            alt: hotkey.alt,
          });
        } else {
          clean[action] = def;
        }
      }
      return clean;
    }
  } catch {
    // Corrupted value; fall back to defaults.
  }
  return { ...DEFAULT_HOTKEYS };
}

export function formatHotkey(hotkey: Hotkey, platform?: ShortcutPlatform): string {
  return formatShortcut(hotkey, platform);
}

export function matchHotkey(event: KeyboardEvent, hotkey: Hotkey): boolean {
  return (
    event.key.toLowerCase() === hotkey.key.toLowerCase() &&
    event.metaKey === hotkey.meta &&
    event.ctrlKey === hotkey.ctrl &&
    event.altKey === hotkey.alt &&
    event.shiftKey === hotkey.shift
  );
}

function loadFontSize(): number {
  const raw = Number(storageGet("termFontSize"));
  return Number.isFinite(raw) && raw >= MIN_FONT_SIZE && raw <= MAX_FONT_SIZE
    ? Math.round(raw)
    : DEFAULT_FONT_SIZE;
}

function loadGridCols(): number {
  const raw = Number(storageGet("gridCols"));
  return GRID_COL_OPTIONS.includes(raw as (typeof GRID_COL_OPTIONS)[number])
    ? raw
    : DEFAULT_GRID_COLS;
}

export type PreferencesState = {
  defaultAgent: string | null;
  hotkeys: Record<string, Hotkey>;
  sidebarCollapsed: boolean;
  fontSize: number;
  defaultShell: string;
  reduceMotion: boolean;
  /** Resume every saved session at startup without showing the opening screen. */
  autoResume: boolean;
  gridCols: number;
  voiceEnabled: boolean;
  voiceLang: string;
  voiceModel: string | null;
  voiceInputDevice: string | null;
  setDefaultAgent: (agent: string | null) => void;
  setHotkeys: (hotkeys: Record<string, Hotkey>) => void;
  resetHotkeys: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  setFontSize: (size: number) => void;
  changeFontSize: (delta: number) => void;
  resetFontSize: () => void;
  setDefaultShell: (shell: string) => void;
  setReduceMotion: (enabled: boolean) => void;
  setAutoResume: (enabled: boolean) => void;
  setGridCols: (cols: number) => void;
  setVoiceEnabled: (enabled: boolean) => void;
  setVoiceLang: (lang: string) => void;
  setVoiceModel: (model: string | null) => void;
  setVoiceInputDevice: (device: string | null) => void;
};

export const usePreferencesStore = create<PreferencesState>((set) => ({
  defaultAgent: storageGet("defaultAgent"),
  hotkeys: loadHotkeys(),
  sidebarCollapsed: storageGet("sidebarCollapsed") === "1",
  fontSize: loadFontSize(),
  defaultShell: storageGet("defaultShell") ?? "",
  reduceMotion: storageGet("reduceMotion") === "1",
  autoResume: storageGet("autoResume") === "1",
  gridCols: loadGridCols(),
  voiceEnabled: storageGet("voiceEnabled") === "1",
  voiceLang: storageGet("voiceLanguage") ?? "auto",
  voiceModel: storageGet("voiceModel"),
  voiceInputDevice: storageGet("voiceInputDevice"),

  setDefaultAgent: (defaultAgent) => {
    if (defaultAgent) storageSet("defaultAgent", defaultAgent);
    else storageRemove("defaultAgent");
    set({ defaultAgent });
  },

  setHotkeys: (hotkeys) => {
    storageSet("hotkeys", JSON.stringify(hotkeys));
    set({ hotkeys });
  },

  resetHotkeys: () => {
    storageRemove("hotkeys");
    set({ hotkeys: { ...DEFAULT_HOTKEYS } });
  },

  setSidebarCollapsed: (sidebarCollapsed) => {
    storageSet("sidebarCollapsed", sidebarCollapsed ? "1" : "0");
    set({ sidebarCollapsed });
  },

  toggleSidebar: () =>
    set((state) => {
      const sidebarCollapsed = !state.sidebarCollapsed;
      storageSet("sidebarCollapsed", sidebarCollapsed ? "1" : "0");
      return { sidebarCollapsed };
    }),

  setFontSize: (fontSize) => {
    const next = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(fontSize)));
    if (next === DEFAULT_FONT_SIZE) storageRemove("termFontSize");
    else storageSet("termFontSize", String(next));
    set({ fontSize: next });
  },

  changeFontSize: (delta) =>
    set((state) => {
      const fontSize = Math.min(
        MAX_FONT_SIZE,
        Math.max(MIN_FONT_SIZE, state.fontSize + delta),
      );
      storageSet("termFontSize", String(fontSize));
      return { fontSize };
    }),

  resetFontSize: () => {
    storageRemove("termFontSize");
    set({ fontSize: DEFAULT_FONT_SIZE });
  },

  setDefaultShell: (defaultShell) => {
    if (defaultShell) storageSet("defaultShell", defaultShell);
    else storageRemove("defaultShell");
    set({ defaultShell });
  },

  setAutoResume: (autoResume) => {
    storageSet("autoResume", autoResume ? "1" : "0");
    set({ autoResume });
  },

  setReduceMotion: (reduceMotion) => {
    storageSet("reduceMotion", reduceMotion ? "1" : "0");
    set({ reduceMotion });
  },

  setGridCols: (gridCols) => {
    if (!GRID_COL_OPTIONS.includes(gridCols as (typeof GRID_COL_OPTIONS)[number])) return;
    storageSet("gridCols", String(gridCols));
    set({ gridCols });
  },

  setVoiceEnabled: (voiceEnabled) => {
    storageSet("voiceEnabled", voiceEnabled ? "1" : "0");
    set({ voiceEnabled });
  },

  setVoiceLang: (voiceLang) => {
    storageSet("voiceLanguage", voiceLang);
    set({ voiceLang });
  },

  setVoiceModel: (voiceModel) => {
    if (voiceModel) storageSet("voiceModel", voiceModel);
    else storageRemove("voiceModel");
    set({ voiceModel });
  },

  setVoiceInputDevice: (voiceInputDevice) => {
    if (voiceInputDevice) storageSet("voiceInputDevice", voiceInputDevice);
    else storageRemove("voiceInputDevice");
    set({ voiceInputDevice });
  },
}));
