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
  it("Given a numbered action, when labelling it, then it is named with its number", () => {
    expect(hotkeyActionLabel("selectWorkspace3")).toBe("Ir para o workspace 3");
    expect(hotkeyActionLabel("selectTerminal9")).toBe("Focar o agente 9");
  });

  it("Given a plain action, when labelling it, then it uses its own label", () => {
    expect(hotkeyActionLabel("newTerminal")).toBe("Novo agente");
  });
});

describe("preferences store", () => {
  afterEach(() => {
    usePreferencesStore.setState({
      fontSize: 13,
      isVoiceEnabled: false,
      voiceLang: "auto",
      voiceModel: null,
      voiceInputDevice: null,
      hotkeys: { ...DEFAULT_HOTKEYS },
    });
  });

  it("Given a terminal font size out of range, when setting it through the store action, then it is clamped", () => {
    usePreferencesStore.getState().setFontSize(999);
    expect(usePreferencesStore.getState().fontSize).toBe(32);

    usePreferencesStore.getState().setFontSize(1);
    expect(usePreferencesStore.getState().fontSize).toBe(8);
  });

  it("Given shortcuts, when formatting them, then it works independently from App rendering", () => {
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

  it("Given a macOS preference, when executing it on Linux, then it is normalized first", () => {
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
  it("Given per-agent launch settings, when storing them, then they are kept per agent and empty ones are dropped", () => {
    const store = usePreferencesStore.getState();
    store.setAgentLaunch("claude", { args: "--model opus", env: "FOO=1" });
    expect(usePreferencesStore.getState().agentLaunch.claude).toEqual({ args: "--model opus", env: "FOO=1" });
    store.setAgentLaunch("claude", { args: " ", env: "" });
    expect(usePreferencesStore.getState().agentLaunch.claude).toBeUndefined();
  });
});
