// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

async function loadStore() {
  vi.resetModules();
  return import("./preferencesStore");
}

async function loadStoreWithNames() {
  const store = await loadStore();
  const names = await import("../domain/agentNames");
  return { ...store, NAME_SETS: names.NAME_SETS, DEFAULT_NAME_LIST: names.DEFAULT_NAME_LIST };
}

afterEach(() => {
  localStorage.clear();
});

describe("preferences loaded from storage", () => {
  it("Given a shortcut saved with the old modifier names, when the store loads, then its modifiers survive under the new names", async () => {
    localStorage.setItem("hotkeys", JSON.stringify({
      newWorkspace: { key: "y", meta: false, shift: true, ctrl: true, alt: false },
    }));

    const { usePreferencesStore } = await loadStore();

    expect(usePreferencesStore.getState().hotkeys.newWorkspace).toEqual({
      key: "y",
      hasMeta: false,
      hasShift: true,
      hasCtrl: true,
      hasAlt: false,
    });
  });

  it("Given a stored shortcut and a malformed one, when the store loads, then the valid one is kept and the other falls back to the default", async () => {
    const custom = { key: "y", hasMeta: false, hasShift: true, hasCtrl: true, hasAlt: false };
    localStorage.setItem("hotkeys", JSON.stringify({ newWorkspace: custom, newTerminal: { key: "", hasMeta: true } }));

    const { usePreferencesStore, DEFAULT_HOTKEYS } = await loadStore();

    expect(usePreferencesStore.getState().hotkeys.newWorkspace).toEqual(custom);
    expect(usePreferencesStore.getState().hotkeys.newTerminal).toEqual(DEFAULT_HOTKEYS.newTerminal);
  });

  it("Given corrupted shortcut storage, when the store loads, then every shortcut is the default", async () => {
    localStorage.setItem("hotkeys", "{not json");

    const { usePreferencesStore, DEFAULT_HOTKEYS } = await loadStore();

    expect(usePreferencesStore.getState().hotkeys).toEqual(DEFAULT_HOTKEYS);
  });

  it("Given shortcut storage that is not an object, when the store loads, then every shortcut is the default", async () => {
    localStorage.setItem("hotkeys", "42");

    const { usePreferencesStore, DEFAULT_HOTKEYS } = await loadStore();

    expect(usePreferencesStore.getState().hotkeys).toEqual(DEFAULT_HOTKEYS);
  });

  it("Given a stored grid width inside and outside the allowed range, when the store loads, then only the allowed one is used", async () => {
    localStorage.setItem("gridCols", "5");
    const allowed = await loadStore();
    expect(allowed.usePreferencesStore.getState().gridCols).toBe(5);
    expect(allowed.GRID_COL_OPTIONS).toEqual([2, 3, 4, 5, 6, 7, 8]);

    localStorage.setItem("gridCols", "12");
    const rejected = await loadStore();
    expect(rejected.usePreferencesStore.getState().gridCols).toBe(2);
  });

  it("Given a stored font size outside the allowed range, when the store loads, then the default size is used", async () => {
    localStorage.setItem("termFontSize", "99");

    const { usePreferencesStore } = await loadStore();

    expect(usePreferencesStore.getState().fontSize).toBe(13);
  });

  it("Given every flag and choice saved, when the store loads, then each one is restored", async () => {
    const saved: Record<string, string> = {
      defaultAgent: "codex",
      sidebarCollapsed: "1",
      termFontSize: "16",
      termFontFamily: "  JetBrains Mono  ",
      defaultShell: "/bin/zsh",
      reduceMotion: "1",
      autoResume: "1",
      systemNotifications: "0",
      voiceToOrchestrator: "0",
      agentAutoNames: "1",
      avoidSimilarNames: "0",
      namesExhausted: "repeat",
      voiceEnabled: "1",
      voiceLanguage: "pt",
      voiceModel: "base",
      voiceInputDevice: "USB Mic",
    };
    for (const [key, value] of Object.entries(saved)) localStorage.setItem(key, value);

    const { usePreferencesStore } = await loadStore();

    expect(usePreferencesStore.getState()).toMatchObject({
      defaultAgent: "codex",
      isSidebarCollapsed: true,
      fontSize: 16,
      terminalFontFamily: "JetBrains Mono",
      defaultShell: "/bin/zsh",
      shouldReduceMotion: true,
      shouldAutoResume: true,
      isSystemNotificationsEnabled: false,
      shouldSendVoiceToOrchestrator: false,
      shouldAutoNameAgents: true,
      shouldAvoidSimilarNames: false,
      namesExhausted: "repeat",
      isVoiceEnabled: true,
      voiceLang: "pt",
      voiceModel: "base",
      voiceInputDevice: "USB Mic",
    });
  });

  it("Given an unknown voice language and name set, when the store loads, then the defaults are used", async () => {
    localStorage.setItem("voiceLanguage", "klingon");
    localStorage.setItem("agentNameSet", "planets");

    const { usePreferencesStore, NAME_SETS } = await loadStoreWithNames();

    expect(usePreferencesStore.getState().voiceLang).toBe("auto");
    expect(usePreferencesStore.getState().agentNameSet).toBe("stars");
    expect(usePreferencesStore.getState().agentNameList).toEqual([...NAME_SETS.stars]);
  });

  it("Given the rivers name set, when the store loads, then the river names are listed", async () => {
    localStorage.setItem("agentNameSet", "rivers");

    const { usePreferencesStore, NAME_SETS } = await loadStoreWithNames();

    expect(usePreferencesStore.getState().agentNameList).toEqual([...NAME_SETS.rivers]);
  });

  it("Given a custom name list with blanks and non-strings, when the store loads, then only real names are kept", async () => {
    localStorage.setItem("agentNameSet", "custom");
    localStorage.setItem("agentNameListCustom", JSON.stringify(["Ada", " ", 7, "Grace"]));

    const { usePreferencesStore } = await loadStore();

    expect(usePreferencesStore.getState().agentNameList).toEqual(["Ada", "Grace"]);
  });

  it("Given a custom name set saved only under the legacy key, when the store loads, then the legacy list is used", async () => {
    localStorage.setItem("agentNameSet", "custom");
    localStorage.setItem("agentNameList", JSON.stringify(["Linus"]));

    const { usePreferencesStore } = await loadStore();

    expect(usePreferencesStore.getState().agentNameList).toEqual(["Linus"]);
  });

  it("Given a custom name list that is corrupted or not a list, when the store loads, then the default names are used", async () => {
    localStorage.setItem("agentNameSet", "custom");
    localStorage.setItem("agentNameListCustom", "{broken");
    const corrupted = await loadStoreWithNames();
    expect(corrupted.usePreferencesStore.getState().agentNameList).toEqual([...corrupted.DEFAULT_NAME_LIST]);

    localStorage.setItem("agentNameListCustom", JSON.stringify({ name: "Ada" }));
    const notAList = await loadStoreWithNames();
    expect(notAList.usePreferencesStore.getState().agentNameList).toEqual([...notAList.DEFAULT_NAME_LIST]);
  });

  it("Given launch settings with malformed entries, when the store loads, then only object entries survive with string fields", async () => {
    localStorage.setItem("agentLaunch", JSON.stringify({ claude: { args: "--fast", env: 3 }, codex: "nope", kimi: null }));

    const { usePreferencesStore } = await loadStore();

    expect(usePreferencesStore.getState().agentLaunch).toEqual({ claude: { args: "--fast", env: "" } });
  });

  it("Given launch settings that are not an object or are corrupted, when the store loads, then none are used", async () => {
    localStorage.setItem("agentLaunch", "5");
    expect((await loadStore()).usePreferencesStore.getState().agentLaunch).toEqual({});

    localStorage.setItem("agentLaunch", "{broken");
    expect((await loadStore()).usePreferencesStore.getState().agentLaunch).toEqual({});
  });

  it("Given saved agent names with non-string values, when the store loads, then only string names are kept", async () => {
    localStorage.setItem("agentNames", JSON.stringify({ "pty-1": "Vega", "pty-2": 4 }));

    const { usePreferencesStore } = await loadStore();

    expect(usePreferencesStore.getState().agentNames).toEqual({ "pty-1": "Vega" });
  });

  it("Given corrupted or non-object agent names, when the store loads, then no names are used", async () => {
    localStorage.setItem("agentNames", "{broken");
    expect((await loadStore()).usePreferencesStore.getState().agentNames).toEqual({});

    localStorage.setItem("agentNames", "null");
    expect((await loadStore()).usePreferencesStore.getState().agentNames).toEqual({});
  });

  it("Given a stored shortcut missing a modifier, when the store loads, then that shortcut falls back to the default", async () => {
    localStorage.setItem("hotkeys", JSON.stringify({ newWorkspace: { key: "y", hasMeta: false, hasShift: true, hasCtrl: true } }));

    const { usePreferencesStore, DEFAULT_HOTKEYS } = await loadStore();

    expect(usePreferencesStore.getState().hotkeys.newWorkspace).toEqual(DEFAULT_HOTKEYS.newWorkspace);
  });
});
