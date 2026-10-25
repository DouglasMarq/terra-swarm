import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_HOTKEYS,
  formatHotkey,
  hotkeyActionLabel,
  matchHotkey,
  normalizeHotkeyForPlatform,
  usePreferencesStore,
} from "./preferencesStore";

describe("hotkeyActionLabel", () => {
  it("given a numbered action, names it with its number", () => {
    expect(hotkeyActionLabel("selectWorkspace3")).toBe("Ir para o workspace 3");
    expect(hotkeyActionLabel("selectTerminal9")).toBe("Focar o agente 9");
  });

  it("given a plain action, uses its own label", () => {
    expect(hotkeyActionLabel("newTerminal")).toBe("Novo agente");
  });
});

describe("preferences store", () => {
  afterEach(() => {
    usePreferencesStore.setState({
      fontSize: 13,
      voiceEnabled: false,
      voiceLang: "auto",
      voiceModel: null,
      voiceInputDevice: null,
      hotkeys: { ...DEFAULT_HOTKEYS },
    });
  });

  it("clamps terminal font size through the store action", () => {
    usePreferencesStore.getState().setFontSize(999);
    expect(usePreferencesStore.getState().fontSize).toBe(32);

    usePreferencesStore.getState().setFontSize(1);
    expect(usePreferencesStore.getState().fontSize).toBe(8);
  });

  it("formats shortcuts independently from App rendering", () => {
    const hotkey = {
      key: "k",
      meta: true,
      shift: true,
      ctrl: false,
      alt: false,
    };

    expect(formatHotkey(hotkey, "mac")).toBe("⇧⌘K");
    expect(formatHotkey(hotkey, "other")).toBe("Ctrl+Shift+K");
  });

  it("normalizes a macOS preference before executing it on Linux", () => {
    const linuxHotkey = normalizeHotkeyForPlatform(
      { key: "n", meta: true, shift: true, ctrl: false, alt: false },
      "other",
    );

    expect(linuxHotkey).toEqual({ key: "n", meta: false, shift: true, ctrl: true, alt: false });
    expect(matchHotkey({
      key: "n",
      metaKey: false,
      shiftKey: true,
      ctrlKey: true,
      altKey: false,
    } as KeyboardEvent, linuxHotkey)).toBe(true);
  });
});

describe("per-agent launch settings", () => {
  it("stores settings per agent and drops empty ones", () => {
    const store = usePreferencesStore.getState();
    store.setAgentLaunch("claude", { args: "--model opus", env: "FOO=1" });
    expect(usePreferencesStore.getState().agentLaunch.claude).toEqual({ args: "--model opus", env: "FOO=1" });
    store.setAgentLaunch("claude", { args: " ", env: "" });
    expect(usePreferencesStore.getState().agentLaunch.claude).toBeUndefined();
  });
});
