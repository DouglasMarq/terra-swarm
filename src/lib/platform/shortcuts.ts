export type ShortcutPlatform = "mac" | "other";

export interface ShortcutDefinition {
  key: string;
  hasMeta: boolean;
  hasShift: boolean;
  hasCtrl: boolean;
  hasAlt: boolean;
}

export const COMMAND_PALETTE_SHORTCUT: ShortcutDefinition = { key: "k", hasMeta: true, hasShift: false, hasCtrl: false, hasAlt: false };

export interface PlatformSignals {
  platform?: string;
  userAgent?: string;
}

export function detectShortcutPlatform(source?: PlatformSignals): ShortcutPlatform {
  const signals = source ?? (typeof navigator === "undefined" ? undefined : navigator);
  const value = `${signals?.platform ?? ""} ${signals?.userAgent ?? ""}`;
  return /mac|iphone|ipad|ipod/i.test(value) ? "mac" : "other";
}

function keyLabel(key: string): string {
  if (key === " ") return "Space";
  return key.length === 1 ? key.toUpperCase() : key;
}

export function formatShortcut(
  hotkey: ShortcutDefinition,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): string {
  const key = keyLabel(hotkey.key);

  if (platform === "mac") {
    let value = "";
    if (hotkey.hasCtrl) value += "⌃";
    if (hotkey.hasAlt) value += "⌥";
    if (hotkey.hasShift) value += "⇧";
    if (hotkey.hasMeta) value += "⌘";
    return `${value}${key}`;
  }

  const modifiers: string[] = [];
  if (hotkey.hasCtrl || hotkey.hasMeta) modifiers.push("Ctrl");
  if (hotkey.hasAlt) modifiers.push("Alt");
  if (hotkey.hasShift) modifiers.push("Shift");
  return [...modifiers, key].join("+");
}
