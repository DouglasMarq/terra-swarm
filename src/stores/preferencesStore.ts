import { DEFAULT_NAME_LIST, NAME_SETS, type NameSetId, type NamesExhaustedStrategy } from "../domain/agentNames";
import { create } from "zustand";
import type { AgentLaunchSettings } from "../domain/agentLaunchEnv";
import { translateNow } from "../i18n";
import { isRecord } from "../lib/records/records";
import { storageGet, storageRemove, storageSet } from "../lib/storage/safeStorage";
import { DEFAULT_VOICE_LANGUAGE, isVoiceLanguage, type VoiceLanguage } from "../domain/voiceLanguages";
import {
  detectShortcutPlatform,
  formatShortcut,
  type ShortcutDefinition,
  type ShortcutPlatform,
} from "../lib/platform/shortcuts";

export type Hotkey = ShortcutDefinition;

type HotkeyModifiers = Partial<Omit<Hotkey, "key">>;

const mk = (key: string, modifiers: HotkeyModifiers = {}): Hotkey => ({
  key,
  hasMeta: false,
  hasShift: false,
  hasCtrl: false,
  hasAlt: false,
  ...modifiers,
});

const isMacPlatform = detectShortcutPlatform() === "mac";

const wsSelect = (digit: string): Hotkey =>
  isMacPlatform ? mk(digit, { hasMeta: true }) : mk(digit, { hasCtrl: true });

const termSelect = (digit: string): Hotkey =>
  isMacPlatform ? mk(digit, { hasMeta: true, hasShift: true }) : mk(digit, { hasShift: true, hasCtrl: true });

export const DEFAULT_HOTKEYS: Readonly<Record<HotkeyActionId, Hotkey>> = {
  newWorkspace: isMacPlatform ? mk("n", { hasMeta: true, hasShift: true }) : mk("n", { hasShift: true, hasCtrl: true }),
  renameWorkspace: isMacPlatform ? mk("r", { hasMeta: true, hasShift: true }) : mk("r", { hasShift: true, hasCtrl: true }),
  deleteWorkspace: isMacPlatform
    ? mk("Backspace", { hasMeta: true, hasShift: true })
    : mk("Backspace", { hasShift: true, hasCtrl: true }),
  newTerminal: isMacPlatform ? mk("t", { hasMeta: true }) : mk("t", { hasShift: true, hasCtrl: true }),
  closeTerminal: isMacPlatform ? mk("w", { hasMeta: true }) : mk("w", { hasShift: true, hasCtrl: true }),
  maximizeTerminal: isMacPlatform
    ? mk("Enter", { hasMeta: true })
    : mk("Enter", { hasAlt: true }),
  minimizeTerminal: isMacPlatform
    ? mk("Enter", { hasMeta: true, hasShift: true })
    : mk("Enter", { hasShift: true, hasAlt: true }),
  increaseFontSize: isMacPlatform ? mk("=", { hasMeta: true }) : mk("=", { hasCtrl: true }),
  decreaseFontSize: isMacPlatform ? mk("-", { hasMeta: true }) : mk("-", { hasCtrl: true }),
  resetFontSize: isMacPlatform ? mk("0", { hasMeta: true }) : mk("0", { hasCtrl: true }),
  toggleVoice: isMacPlatform ? mk(" ", { hasMeta: true, hasShift: true }) : mk(" ", { hasShift: true, hasCtrl: true }),
  selectWorkspace1: wsSelect("1"),
  selectWorkspace2: wsSelect("2"),
  selectWorkspace3: wsSelect("3"),
  selectWorkspace4: wsSelect("4"),
  selectWorkspace5: wsSelect("5"),
  selectWorkspace6: wsSelect("6"),
  selectWorkspace7: wsSelect("7"),
  selectWorkspace8: wsSelect("8"),
  selectWorkspace9: wsSelect("9"),
  selectTerminal1: termSelect("1"),
  selectTerminal2: termSelect("2"),
  selectTerminal3: termSelect("3"),
  selectTerminal4: termSelect("4"),
  selectTerminal5: termSelect("5"),
  selectTerminal6: termSelect("6"),
  selectTerminal7: termSelect("7"),
  selectTerminal8: termSelect("8"),
  selectTerminal9: termSelect("9"),
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

export function hotkeyActionLabel(id: HotkeyActionId): string {
  if (!isNumberedHotkeyAction(id)) return translateNow(`hotkeys.${id}` as const);
  const slotNumber = id.slice(-1);
  return id.startsWith("selectWorkspace") ? translateNow("hotkeys.selectWorkspace", { n: slotNumber }) : translateNow("hotkeys.selectTerminal", { n: slotNumber });
}

export function normalizeHotkeyForPlatform(
  hotkey: Hotkey,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): Hotkey {
  if (platform === "other" && hotkey.hasMeta && !hotkey.hasCtrl) {
    return { ...hotkey, hasMeta: false, hasCtrl: true };
  }
  if (platform === "mac" && hotkey.hasCtrl && !hotkey.hasMeta) {
    return { ...hotkey, hasCtrl: false, hasMeta: true };
  }
  return { ...hotkey };
}

export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 32;
const DEFAULT_FONT_SIZE = 13;
const MIN_GRID_COLS = 2;
const MAX_GRID_COLS = 8;
export const GRID_COL_OPTIONS: readonly number[] = [...Array(MAX_GRID_COLS - MIN_GRID_COLS + 1).keys()].map((offset) => MIN_GRID_COLS + offset);
const DEFAULT_GRID_COLS = 2;

function loadNameSet(): NameSetId {
  const stored = storageGet("agentNameSet");
  return stored === "rivers" || stored === "custom" ? stored : "stars";
}

function loadCustomNameList(): string[] {
  try {
    const parsed = JSON.parse(storageGet("agentNameListCustom") ?? storageGet("agentNameList") ?? "null");
    if (Array.isArray(parsed)) return parsed.filter((name): name is string => typeof name === "string" && name.trim().length > 0);
  } catch {}
  return [...DEFAULT_NAME_LIST];
}

function nameListFor(set: NameSetId): string[] {
  return set === "custom" ? loadCustomNameList() : [...NAME_SETS[set]];
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

function loadAgentNames(): Record<string, string> {
  try {
    const parsed = JSON.parse(storageGet("agentNames") ?? "{}");
    if (parsed && typeof parsed === "object") {
      return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    }
  } catch {}
  return {};
}

const LEGACY_HOTKEY_MODIFIERS = {
  hasMeta: "meta",
  hasShift: "shift",
  hasCtrl: "ctrl",
  hasAlt: "alt",
} as const satisfies Record<keyof HotkeyModifiers, string>;

function readStoredModifier(value: Record<string, unknown>, modifier: keyof HotkeyModifiers): boolean | null {
  const stored = value[modifier] ?? value[LEGACY_HOTKEY_MODIFIERS[modifier]];
  return typeof stored === "boolean" ? stored : null;
}

function readStoredHotkey(value: unknown): Hotkey | null {
  if (!isRecord(value)) return null;
  if (typeof value.key !== "string" || value.key.length === 0) return null;
  const hasMeta = readStoredModifier(value, "hasMeta");
  const hasShift = readStoredModifier(value, "hasShift");
  const hasCtrl = readStoredModifier(value, "hasCtrl");
  const hasAlt = readStoredModifier(value, "hasAlt");
  if (hasMeta === null || hasShift === null || hasCtrl === null || hasAlt === null) return null;
  return { key: value.key, hasMeta, hasShift, hasCtrl, hasAlt };
}

function parseHotkeys(raw: string): Record<HotkeyActionId, Hotkey> {
  const parsed: unknown = JSON.parse(raw);
  const stored = isRecord(parsed) ? parsed : {};
  const clean: Record<HotkeyActionId, Hotkey> = { ...DEFAULT_HOTKEYS };
  for (const { id: action } of HOTKEY_ACTIONS) {
    const hotkey = readStoredHotkey(stored[action]);
    if (!hotkey) continue;
    clean[action] = normalizeHotkeyForPlatform(hotkey);
  }
  return clean;
}

function loadHotkeys(): Record<HotkeyActionId, Hotkey> {
  try {
    const raw = storageGet("hotkeys");
    if (raw) return parseHotkeys(raw);
  } catch {}
  return { ...DEFAULT_HOTKEYS };
}

export function formatHotkey(hotkey: Hotkey, platform?: ShortcutPlatform): string {
  return formatShortcut(hotkey, platform);
}

export function matchHotkey(event: KeyboardEvent, hotkey: Hotkey): boolean {
  return (
    event.key.toLowerCase() === hotkey.key.toLowerCase() &&
    event.metaKey === hotkey.hasMeta &&
    event.ctrlKey === hotkey.hasCtrl &&
    event.altKey === hotkey.hasAlt &&
    event.shiftKey === hotkey.hasShift
  );
}

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
  return GRID_COL_OPTIONS.includes(raw)
    ? raw
    : DEFAULT_GRID_COLS;
}

export type PreferencesState = {
  defaultAgent: string | null;
  hotkeys: Record<HotkeyActionId, Hotkey>;
  isSidebarCollapsed: boolean;
  fontSize: number;
  terminalFontFamily: string;
  defaultShell: string;
  shouldReduceMotion: boolean;
  shouldAutoResume: boolean;
  isSystemNotificationsEnabled: boolean;
  shouldSendVoiceToOrchestrator: boolean;
  shouldAutoNameAgents: boolean;
  agentNameSet: NameSetId;
  agentNameList: string[];
  shouldAvoidSimilarNames: boolean;
  namesExhausted: NamesExhaustedStrategy;
  agentNames: Record<string, string>;
  agentLaunch: Record<string, AgentLaunchSettings>;
  gridCols: number;
  isVoiceEnabled: boolean;
  voiceLang: VoiceLanguage;
  voiceModel: string | null;
  voiceInputDevice: string | null;
  setDefaultAgent: (agent: string | null) => void;
  setHotkeys: (hotkeys: Record<HotkeyActionId, Hotkey>) => void;
  resetHotkeys: () => void;
  setSidebarCollapsed: (isCollapsed: boolean) => void;
  toggleSidebar: () => void;
  setFontSize: (size: number) => void;
  setTerminalFontFamily: (name: string) => void;
  changeFontSize: (delta: number) => void;
  resetFontSize: () => void;
  setDefaultShell: (shell: string) => void;
  setReduceMotion: (isEnabled: boolean) => void;
  setAutoResume: (isEnabled: boolean) => void;
  setSystemNotifications: (isEnabled: boolean) => void;
  setVoiceToOrchestrator: (isEnabled: boolean) => void;
  setAgentAutoNames: (isEnabled: boolean) => void;
  setAgentNameSet: (set: NameSetId) => void;
  setAgentNameList: (names: string[]) => void;
  setAvoidSimilarNames: (isEnabled: boolean) => void;
  setNamesExhausted: (strategy: NamesExhaustedStrategy) => void;
  setAgentName: (terminalId: string, name: string | null) => void;
  setAgentLaunch: (agentId: string, settings: AgentLaunchSettings) => void;
  setGridCols: (cols: number) => void;
  setVoiceEnabled: (isEnabled: boolean) => void;
  setVoiceLang: (lang: VoiceLanguage) => void;
  setVoiceModel: (model: string | null) => void;
  setVoiceInputDevice: (device: string | null) => void;
};

export const usePreferencesStore = create<PreferencesState>((set) => ({
  defaultAgent: storageGet("defaultAgent"),
  hotkeys: loadHotkeys(),
  isSidebarCollapsed: storageGet("sidebarCollapsed") === "1",
  fontSize: loadFontSize(),
  terminalFontFamily: storageGet("termFontFamily")?.trim() ?? "",
  defaultShell: storageGet("defaultShell") ?? "",
  shouldReduceMotion: storageGet("reduceMotion") === "1",
  shouldAutoResume: storageGet("autoResume") === "1",
  isSystemNotificationsEnabled: storageGet("systemNotifications") !== "0",
  shouldSendVoiceToOrchestrator: storageGet("voiceToOrchestrator") !== "0",
  shouldAutoNameAgents: storageGet("agentAutoNames") === "1",
  agentNameSet: loadNameSet(),
  agentNameList: nameListFor(loadNameSet()),
  shouldAvoidSimilarNames: storageGet("avoidSimilarNames") !== "0",
  namesExhausted: storageGet("namesExhausted") === "repeat" ? "repeat" : "type-number",
  agentNames: loadAgentNames(),
  agentLaunch: loadAgentLaunch(),
  gridCols: loadGridCols(),
  isVoiceEnabled: storageGet("voiceEnabled") === "1",
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

  setSidebarCollapsed: (isSidebarCollapsed) => {
    storageSet("sidebarCollapsed", isSidebarCollapsed ? "1" : "0");
    set({ isSidebarCollapsed });
  },

  toggleSidebar: () =>
    set((state) => {
      const isSidebarCollapsed = !state.isSidebarCollapsed;
      storageSet("sidebarCollapsed", isSidebarCollapsed ? "1" : "0");
      return { isSidebarCollapsed };
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

  setAgentAutoNames: (shouldAutoNameAgents) => {
    storageSet("agentAutoNames", shouldAutoNameAgents ? "1" : "0");
    set({ shouldAutoNameAgents });
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

  setAvoidSimilarNames: (shouldAvoidSimilarNames) => {
    storageSet("avoidSimilarNames", shouldAvoidSimilarNames ? "1" : "0");
    set({ shouldAvoidSimilarNames });
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

  setAutoResume: (shouldAutoResume) => {
    storageSet("autoResume", shouldAutoResume ? "1" : "0");
    set({ shouldAutoResume });
  },

  setSystemNotifications: (isSystemNotificationsEnabled) => {
    storageSet("systemNotifications", isSystemNotificationsEnabled ? "1" : "0");
    set({ isSystemNotificationsEnabled });
  },

  setVoiceToOrchestrator: (shouldSendVoiceToOrchestrator) => {
    storageSet("voiceToOrchestrator", shouldSendVoiceToOrchestrator ? "1" : "0");
    set({ shouldSendVoiceToOrchestrator });
  },

  setReduceMotion: (shouldReduceMotion) => {
    storageSet("reduceMotion", shouldReduceMotion ? "1" : "0");
    set({ shouldReduceMotion });
  },

  setGridCols: (gridCols) => {
    if (!GRID_COL_OPTIONS.includes(gridCols)) return;
    storageSet("gridCols", String(gridCols));
    set({ gridCols });
  },

  setVoiceEnabled: (isVoiceEnabled) => {
    storageSet("voiceEnabled", isVoiceEnabled ? "1" : "0");
    set({ isVoiceEnabled });
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
