// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NAME_SETS } from "../domain/agentNames";
import { DEFAULT_HOTKEYS, normalizeHotkeyForPlatform, usePreferencesStore, type PreferencesState } from "./preferencesStore";

let initial: PreferencesState;

const store = () => usePreferencesStore.getState();

describe("preference actions", () => {
  beforeEach(() => {
    initial = store();
    localStorage.clear();
  });

  afterEach(() => {
    usePreferencesStore.setState(initial, true);
    localStorage.clear();
  });

  it("Given a default agent, when setting and then clearing it, then storage follows", () => {
    store().setDefaultAgent("codex");
    expect(localStorage.getItem("defaultAgent")).toBe("codex");
    expect(store().defaultAgent).toBe("codex");

    store().setDefaultAgent(null);
    expect(localStorage.getItem("defaultAgent")).toBeNull();
    expect(store().defaultAgent).toBeNull();
  });

  it("Given custom shortcuts, when resetting them, then the defaults return and storage is cleared", () => {
    const custom = { ...DEFAULT_HOTKEYS, newTerminal: { key: "y", hasMeta: false, hasShift: false, hasCtrl: true, hasAlt: false } };

    store().setHotkeys(custom);
    expect(JSON.parse(localStorage.getItem("hotkeys") ?? "{}").newTerminal.key).toBe("y");

    store().resetHotkeys();
    expect(store().hotkeys).toEqual(DEFAULT_HOTKEYS);
    expect(localStorage.getItem("hotkeys")).toBeNull();
  });

  it("Given the sidebar, when collapsing it and toggling twice, then state and storage follow each change", () => {
    store().setSidebarCollapsed(true);
    expect(localStorage.getItem("sidebarCollapsed")).toBe("1");

    store().toggleSidebar();
    expect(store().isSidebarCollapsed).toBe(false);
    expect(localStorage.getItem("sidebarCollapsed")).toBe("0");

    store().toggleSidebar();
    expect(store().isSidebarCollapsed).toBe(true);

    store().setSidebarCollapsed(false);
    expect(localStorage.getItem("sidebarCollapsed")).toBe("0");
  });

  it("Given font size changes, when stepping, setting the default and resetting, then storage tracks only non-default sizes", () => {
    store().setFontSize(13);
    expect(localStorage.getItem("termFontSize")).toBeNull();

    store().changeFontSize(2);
    expect(store().fontSize).toBe(15);
    expect(localStorage.getItem("termFontSize")).toBe("15");

    store().changeFontSize(100);
    expect(store().fontSize).toBe(32);

    store().resetFontSize();
    expect(store().fontSize).toBe(13);
    expect(localStorage.getItem("termFontSize")).toBeNull();
  });

  it("Given a font family with spaces or blank, when setting it, then it is trimmed and blank clears storage", () => {
    store().setTerminalFontFamily("  Fira Code ");
    expect(store().terminalFontFamily).toBe("Fira Code");
    expect(localStorage.getItem("termFontFamily")).toBe("Fira Code");

    store().setTerminalFontFamily("   ");
    expect(store().terminalFontFamily).toBe("");
    expect(localStorage.getItem("termFontFamily")).toBeNull();
  });

  it("Given a default shell, when setting and clearing it, then storage follows", () => {
    store().setDefaultShell("/bin/fish");
    expect(localStorage.getItem("defaultShell")).toBe("/bin/fish");

    store().setDefaultShell("");
    expect(store().defaultShell).toBe("");
    expect(localStorage.getItem("defaultShell")).toBeNull();
  });

  it.each([
    ["setAgentAutoNames", "agentAutoNames", "shouldAutoNameAgents"],
    ["setAvoidSimilarNames", "avoidSimilarNames", "shouldAvoidSimilarNames"],
    ["setAutoResume", "autoResume", "shouldAutoResume"],
    ["setSystemNotifications", "systemNotifications", "isSystemNotificationsEnabled"],
    ["setVoiceToOrchestrator", "voiceToOrchestrator", "shouldSendVoiceToOrchestrator"],
    ["setReduceMotion", "reduceMotion", "shouldReduceMotion"],
    ["setVoiceEnabled", "voiceEnabled", "isVoiceEnabled"],
  ] as const)("Given the %s toggle, when switching it on and off, then state and storage follow", (action, storageKey, field) => {
    store()[action](true);
    expect(store()[field]).toBe(true);
    expect(localStorage.getItem(storageKey)).toBe("1");

    store()[action](false);
    expect(store()[field]).toBe(false);
    expect(localStorage.getItem(storageKey)).toBe("0");
  });

  it("Given a name set, when choosing rivers, then its names become the list", () => {
    store().setAgentNameSet("rivers");

    expect(store().agentNameList).toEqual([...NAME_SETS.rivers]);
    expect(localStorage.getItem("agentNameSet")).toBe("rivers");
  });

  it("Given a custom list with duplicates and blanks, when setting it, then it is cleaned and the custom set is selected", () => {
    store().setAgentNameList([" Ada ", "Ada", "", "Grace"]);

    expect(store().agentNameList).toEqual(["Ada", "Grace"]);
    expect(store().agentNameSet).toBe("custom");
    expect(JSON.parse(localStorage.getItem("agentNameListCustom") ?? "[]")).toEqual(["Ada", "Grace"]);
  });

  it("Given the exhausted-names strategy, when changing it, then it is stored", () => {
    store().setNamesExhausted("repeat");

    expect(store().namesExhausted).toBe("repeat");
    expect(localStorage.getItem("namesExhausted")).toBe("repeat");
  });

  it("Given agent names, when naming, renaming blank and clearing, then only trimmed names remain", () => {
    store().setAgentName("pty-1", "  Vega ");
    expect(store().agentNames["pty-1"]).toBe("Vega");

    store().setAgentName("pty-1", "  ");
    expect(store().agentNames).not.toHaveProperty("pty-1");

    store().setAgentName("pty-2", "Lyra");
    store().setAgentName("pty-2", null);
    expect(JSON.parse(localStorage.getItem("agentNames") ?? "{}")).toEqual({});
  });

  it("Given grid widths, when setting an allowed and a disallowed one, then only the allowed one sticks", () => {
    store().setGridCols(4);
    expect(store().gridCols).toBe(4);
    expect(localStorage.getItem("gridCols")).toBe("4");

    store().setGridCols(42);
    expect(store().gridCols).toBe(4);
  });

  it("Given voice choices, when setting and clearing them, then state and storage follow", () => {
    store().setVoiceLang("en");
    store().setVoiceModel("small");
    store().setVoiceInputDevice("USB Mic");
    expect(localStorage.getItem("voiceLanguage")).toBe("en");
    expect(localStorage.getItem("voiceModel")).toBe("small");
    expect(localStorage.getItem("voiceInputDevice")).toBe("USB Mic");

    store().setVoiceModel(null);
    store().setVoiceInputDevice(null);
    expect(store().voiceModel).toBeNull();
    expect(store().voiceInputDevice).toBeNull();
    expect(localStorage.getItem("voiceModel")).toBeNull();
    expect(localStorage.getItem("voiceInputDevice")).toBeNull();
  });
});

describe("normalizeHotkeyForPlatform on macOS", () => {
  it("Given a Ctrl shortcut, when normalizing for macOS, then Ctrl becomes Cmd", () => {
    const hotkey = { key: "k", hasMeta: false, hasShift: false, hasCtrl: true, hasAlt: false };

    expect(normalizeHotkeyForPlatform(hotkey, "mac")).toEqual({ ...hotkey, hasCtrl: false, hasMeta: true });
  });

  it("Given a shortcut using both Ctrl and Cmd, when normalizing for macOS, then it is kept as is", () => {
    const hotkey = { key: "k", hasMeta: true, hasShift: false, hasCtrl: true, hasAlt: false };

    expect(normalizeHotkeyForPlatform(hotkey, "mac")).toEqual(hotkey);
  });
});
