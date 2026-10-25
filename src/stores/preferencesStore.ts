import { DEFAULT_NAME_LIST, NAME_SETS, type NameSetId, type NamesExhaustedStrategy } from "../domain/agentNames";
import { create } from "zustand";
import { t } from "../i18n";
import { storageGet, storageRemove, storageSet } from "../lib/storage/safeStorage";
import { DEFAULT_VOICE_LANGUAGE, isVoiceLanguage, type VoiceLanguage } from "../domain/voiceLanguages";
import {
  detectShortcutPlatform,
  formatShortcut,
  type ShortcutDefinition,
  type ShortcutPlatform,
} from "../lib/platform/shortcuts";

export type Hotkey = ShortcutDefinition;

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
export const DEFAULT_HOTKEYS: Readonly<Record<HotkeyActionId, Hotkey>> = {
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
  { id: "newWorkspace" },
  { id: "renameWorkspace" },
  { id: "deleteWorkspace" },
  { id: "newTerminal" },
  { id: "closeTerminal" },
  { id: "maximizeTerminal" },
  { id: "minimizeTerminal" },
  { id: "increaseFontSize" },
  { id: "decreaseFontSize" },
  { id: "resetFontSize" },
  { id: "toggleVoice" },
  { id: "selectWorkspace1" },
  { id: "selectWorkspace2" },
  { id: "selectWorkspace3" },
  { id: "selectWorkspace4" },
  { id: "selectWorkspace5" },
  { id: "selectWorkspace6" },
  { id: "selectWorkspace7" },
  { id: "selectWorkspace8" },
  { id: "selectWorkspace9" },
  { id: "selectTerminal1" },
  { id: "selectTerminal2" },
  { id: "selectTerminal3" },
  { id: "selectTerminal4" },
  { id: "selectTerminal5" },
  { id: "selectTerminal6" },
  { id: "selectTerminal7" },
  { id: "selectTerminal8" },
  { id: "selectTerminal9" },
] as const;

export type HotkeyActionId = (typeof HOTKEY_ACTIONS)[number]["id"];

type NumberedHotkeyActionId = Extract<HotkeyActionId, `selectWorkspace${string}` | `selectTerminal${string}`>;

function isNumberedHotkeyAction(id: HotkeyActionId): id is NumberedHotkeyActionId {
  return id.startsWith("selectWorkspace") || id.startsWith("selectTerminal");
}

/** The action's name in the current language. */
export function hotkeyActionLabel(id: HotkeyActionId): string {
  if (!isNumberedHotkeyAction(id)) return t(`hotkeys.${id}` as const);
  const n = id.slice(-1);
  return id.startsWith("selectWorkspace") ? t("hotkeys.selectWorkspace", { n }) : t("hotkeys.selectTerminal", { n });
}

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
const DEFAULT_FONT_SIZE = 13;
export const GRID_COL_OPTIONS = [2, 3, 4, 5, 6, 7, 8] as const;
const DEFAULT_GRID_COLS = 2;

function loadNameSet(): NameSetId {
  const stored = storageGet("agentNameSet");
  return stored === "rivers" || stored === "custom" ? stored : "stars";
}

/** The user's own list lives apart from the presets, so picking "Stars" and
 * coming back to "Custom" keeps it ("agentNameList" is the legacy key). */
function loadCustomNameList(): string[] {
  try {
    const parsed = JSON.parse(storageGet("agentNameListCustom") ?? storageGet("agentNameList") ?? "null");
    if (Array.isArray(parsed)) return parsed.filter((name): name is string => typeof name === "string" && name.trim().length > 0);
  } catch {
    // Fall back to the default list below.
  }
  return [...DEFAULT_NAME_LIST];
}

function nameListFor(set: NameSetId): string[] {
  return set === "custom" ? loadCustomNameList() : [...NAME_SETS[set]];
}

/** User launch settings of one agent: extra arguments and `KEY=VALUE` lines. */
export interface AgentLaunchSettings {
  args: string;
  env: string;
}

function loadAgentLaunch(): Record<string, AgentLaunchSettings> {
  try {
    const parsed: unknown = JSON.parse(storageGet("agentLaunch") ?? "{}");
    if (!parsed || typeof parsed !== "object") return {};
    const clean: Record<string, AgentLaunchSettings> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as Record<string, unknown>;
      clean[id] = {
        args: typeof entry.args === "string" ? entry.args : "",
        env: typeof entry.env === "string" ? entry.env : "",
      };
    }
    return clean;
  } catch {
    return {};
  }
}

/** Parse `KEY=VALUE` lines; blank lines and `#` comments are skipped. */
export function parseEnvLines(text: string): { env: Record<string, string>; invalid: string[] } {
  const env: Record<string, string> = {};
  const invalid: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    const key = separator > 0 ? line.slice(0, separator).trim() : "";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key.startsWith("TERRA_")) {
      invalid.push(line);
      continue;
    }
    env[key] = line.slice(separator + 1).trim();
  }
  return { env, invalid };
}

function loadAgentNames(): Record<string, string> {
  try {
    const parsed = JSON.parse(storageGet("agentNames") ?? "{}");
    if (parsed && typeof parsed === "object") {
      return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    }
  } catch {
    // Corrupt storage starts empty.
  }
  return {};
}

function loadHotkeys(): Record<HotkeyActionId, Hotkey> {
  try {
    const raw = storageGet("hotkeys");
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      const clean: Record<HotkeyActionId, Hotkey> = { ...DEFAULT_HOTKEYS };
      for (const { id: action } of HOTKEY_ACTIONS) {
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

/** Unknown persisted values (an older or edited preference) fall back to auto-detection. */
function loadVoiceLanguage(): VoiceLanguage {
  const stored = storageGet("voiceLanguage");
  return isVoiceLanguage(stored) ? stored : DEFAULT_VOICE_LANGUAGE;
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
  hotkeys: Record<HotkeyActionId, Hotkey>;
  sidebarCollapsed: boolean;
  fontSize: number;
  /** Terminal font family name; empty means the default stack. */
  terminalFontFamily: string;
  defaultShell: string;
  reduceMotion: boolean;
  /** Resume every saved session at startup without showing the opening screen. */
  autoResume: boolean;
  /** Native notifications and the app icon badge when an agent needs you. */
  systemNotifications: boolean;
  /** Dictation goes to the project's orchestrator when one is running. */
  voiceToOrchestrator: boolean;
  /** Give each new agent a name from `agentNameList` (off by default). */
  agentAutoNames: boolean;
  agentNameSet: NameSetId;
  agentNameList: string[];
  avoidSimilarNames: boolean;
  namesExhausted: NamesExhaustedStrategy;
  /** Names given to agents (automatically or through Rename), by terminal id. */
  agentNames: Record<string, string>;
  /** Extra arguments and environment per agent id. */
  agentLaunch: Record<string, AgentLaunchSettings>;
  gridCols: number;
  voiceEnabled: boolean;
  voiceLang: VoiceLanguage;
  voiceModel: string | null;
  voiceInputDevice: string | null;
  setDefaultAgent: (agent: string | null) => void;
  setHotkeys: (hotkeys: Record<HotkeyActionId, Hotkey>) => void;
  resetHotkeys: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  setFontSize: (size: number) => void;
  setTerminalFontFamily: (name: string) => void;
  changeFontSize: (delta: number) => void;
  resetFontSize: () => void;
  setDefaultShell: (shell: string) => void;
  setReduceMotion: (enabled: boolean) => void;
  setAutoResume: (enabled: boolean) => void;
  setSystemNotifications: (enabled: boolean) => void;
  setVoiceToOrchestrator: (enabled: boolean) => void;
  setAgentAutoNames: (enabled: boolean) => void;
  setAgentNameSet: (set: NameSetId) => void;
  setAgentNameList: (names: string[]) => void;
  setAvoidSimilarNames: (enabled: boolean) => void;
  setNamesExhausted: (strategy: NamesExhaustedStrategy) => void;
  setAgentName: (terminalId: string, name: string | null) => void;
  setAgentLaunch: (agentId: string, settings: AgentLaunchSettings) => void;
  setGridCols: (cols: number) => void;
  setVoiceEnabled: (enabled: boolean) => void;
  setVoiceLang: (lang: VoiceLanguage) => void;
  setVoiceModel: (model: string | null) => void;
  setVoiceInputDevice: (device: string | null) => void;
};

export const usePreferencesStore = create<PreferencesState>((set) => ({
  defaultAgent: storageGet("defaultAgent"),
  hotkeys: loadHotkeys(),
  sidebarCollapsed: storageGet("sidebarCollapsed") === "1",
  fontSize: loadFontSize(),
  terminalFontFamily: storageGet("termFontFamily")?.trim() ?? "",
  defaultShell: storageGet("defaultShell") ?? "",
  reduceMotion: storageGet("reduceMotion") === "1",
  autoResume: storageGet("autoResume") === "1",
  systemNotifications: storageGet("systemNotifications") !== "0",
  voiceToOrchestrator: storageGet("voiceToOrchestrator") !== "0",
  agentAutoNames: storageGet("agentAutoNames") === "1",
  agentNameSet: loadNameSet(),
  agentNameList: nameListFor(loadNameSet()),
  avoidSimilarNames: storageGet("avoidSimilarNames") !== "0",
  namesExhausted: storageGet("namesExhausted") === "repeat" ? "repeat" : "type-number",
  agentNames: loadAgentNames(),
  agentLaunch: loadAgentLaunch(),
  gridCols: loadGridCols(),
  voiceEnabled: storageGet("voiceEnabled") === "1",
  voiceLang: loadVoiceLanguage(),
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

  setTerminalFontFamily: (name) => {
    const terminalFontFamily = name.trim();
    if (terminalFontFamily) storageSet("termFontFamily", terminalFontFamily);
    else storageRemove("termFontFamily");
    set({ terminalFontFamily });
  },

  resetFontSize: () => {
    storageRemove("termFontSize");
    set({ fontSize: DEFAULT_FONT_SIZE });
  },

  setDefaultShell: (defaultShell) => {
    if (defaultShell) storageSet("defaultShell", defaultShell);
    else storageRemove("defaultShell");
    set({ defaultShell });
  },

  setAgentAutoNames: (agentAutoNames) => {
    storageSet("agentAutoNames", agentAutoNames ? "1" : "0");
    set({ agentAutoNames });
  },

  setAgentNameSet: (agentNameSet) => {
    storageSet("agentNameSet", agentNameSet);
    set({ agentNameSet, agentNameList: nameListFor(agentNameSet) });
  },

  setAgentNameList: (names) => {
    const agentNameList = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
    storageSet("agentNameListCustom", JSON.stringify(agentNameList));
    storageSet("agentNameSet", "custom");
    set({ agentNameList, agentNameSet: "custom" });
  },

  setAvoidSimilarNames: (avoidSimilarNames) => {
    storageSet("avoidSimilarNames", avoidSimilarNames ? "1" : "0");
    set({ avoidSimilarNames });
  },

  setNamesExhausted: (namesExhausted) => {
    storageSet("namesExhausted", namesExhausted);
    set({ namesExhausted });
  },

  setAgentLaunch: (agentId, settings) =>
    set((state) => {
      const agentLaunch = { ...state.agentLaunch };
      if (settings.args.trim() || settings.env.trim()) agentLaunch[agentId] = { args: settings.args, env: settings.env };
      else delete agentLaunch[agentId];
      storageSet("agentLaunch", JSON.stringify(agentLaunch));
      return { agentLaunch };
    }),

  setAgentName: (terminalId, name) =>
    set((state) => {
      const agentNames = { ...state.agentNames };
      if (name && name.trim()) agentNames[terminalId] = name.trim();
      else delete agentNames[terminalId];
      storageSet("agentNames", JSON.stringify(agentNames));
      return { agentNames };
    }),

  setAutoResume: (autoResume) => {
    storageSet("autoResume", autoResume ? "1" : "0");
    set({ autoResume });
  },

  setSystemNotifications: (systemNotifications) => {
    storageSet("systemNotifications", systemNotifications ? "1" : "0");
    set({ systemNotifications });
  },

  setVoiceToOrchestrator: (voiceToOrchestrator) => {
    storageSet("voiceToOrchestrator", voiceToOrchestrator ? "1" : "0");
    set({ voiceToOrchestrator });
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
