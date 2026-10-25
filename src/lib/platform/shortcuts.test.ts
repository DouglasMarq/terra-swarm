import { describe, expect, it } from "vitest";
import { detectShortcutPlatform, formatShortcut } from "./shortcuts";

describe("platform shortcut labels", () => {
  it("Given Linux or Windows, when formatting shortcut labels, then readable Ctrl labels are used", () => {
    expect(formatShortcut({ key: "n", meta: false, shift: true, ctrl: true, alt: false }, "other")).toBe("Ctrl+Shift+N");
    expect(formatShortcut({ key: "t", meta: false, shift: true, ctrl: true, alt: false }, "other")).toBe("Ctrl+Shift+T");
    expect(formatShortcut({ key: " ", meta: false, shift: true, ctrl: true, alt: false }, "other")).toBe("Ctrl+Shift+Space");
    expect(formatShortcut({ key: "k", meta: true, shift: false, ctrl: false, alt: false }, "other")).toBe("Ctrl+K");
  });

  it("Given macOS, when formatting shortcut labels, then compact symbols are kept", () => {
    expect(formatShortcut({ key: "n", meta: true, shift: true, ctrl: false, alt: false }, "mac")).toBe("⇧⌘N");
    expect(formatShortcut({ key: " ", meta: true, shift: true, ctrl: false, alt: false }, "mac")).toBe("⇧⌘Space");
  });

  it("Given platform signals, when detecting the platform, then Apple platforms are recognised", () => {
    expect(detectShortcutPlatform({ platform: "MacIntel" })).toBe("mac");
    expect(detectShortcutPlatform({ userAgent: "Mozilla/5.0 (iPhone)" })).toBe("mac");
    expect(detectShortcutPlatform({ platform: "Linux x86_64" })).toBe("other");
    expect(detectShortcutPlatform({ platform: "Win32" })).toBe("other");
  });
});
