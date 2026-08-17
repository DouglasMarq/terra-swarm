export type ShortcutPlatform = "mac" | "other";

export interface ShortcutDefinition {
  key: string;
  meta: boolean;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

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

/** Formats a persisted hotkey without making platform assumptions in views. */
export function formatShortcut(
  hotkey: ShortcutDefinition,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): string {
  const key = keyLabel(hotkey.key);

  if (platform === "mac") {
    let value = "";
    if (hotkey.ctrl) value += "⌃";
    if (hotkey.alt) value += "⌥";
    if (hotkey.shift) value += "⇧";
    if (hotkey.meta) value += "⌘";
    return `${value}${key}`;
  }

  const modifiers: string[] = [];
  // Non-macOS defaults use Ctrl. Treat a persisted Meta binding as Ctrl in
  // the human-facing label too: the application handlers accept either.
  if (hotkey.ctrl || hotkey.meta) modifiers.push("Ctrl");
  if (hotkey.alt) modifiers.push("Alt");
  if (hotkey.shift) modifiers.push("Shift");
  return [...modifiers, key].join("+");
}
