import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_HOTKEYS,
  formatHotkey,
  matchHotkey,
  normalizeHotkeyForPlatform,
  usePreferencesStore,
} from "./preferencesStore";

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
