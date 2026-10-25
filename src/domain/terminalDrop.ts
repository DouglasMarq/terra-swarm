/** Files dropped on a terminal: how their paths are typed and where the drop landed. */
import { detectShortcutPlatform, type PlatformSignals } from "../lib/platform/shortcuts";

export type DropPlatform = "mac" | "linux" | "windows";

export function detectDropPlatform(source?: PlatformSignals): DropPlatform {
  if (detectShortcutPlatform(source) === "mac") return "mac";
  const signals = source ?? (typeof navigator === "undefined" ? undefined : navigator);
  const value = `${signals?.platform ?? ""} ${signals?.userAgent ?? ""}`.toLowerCase();
  return value.includes("win32") || value.includes("win64") || value.includes("windows") ? "windows" : "linux";
}

/** Characters a POSIX shell reads as plain text inside a word; others are backslash-escaped. */
const POSIX_PLAIN_PUNCTUATION = new Set("_./:@%+=,~-");
/** Characters that make `cmd` or PowerShell split or interpret a path. */
const WINDOWS_SPECIAL = new Set(" \t&()[]{}^=;!'+,`~%$@#");
const FIRST_NON_ASCII_CODE = 0x80;
const LAST_CONTROL_CODE = 0x1f;
const DELETE_CODE = 0x7f;

/** A control character would act as a keystroke (Enter, Ctrl-C) instead of text. */
function hasControlCharacter(path: string): boolean {
  return [...path].some((character) => {
    const code = character.charCodeAt(0);
    return code <= LAST_CONTROL_CODE || code === DELETE_CODE;
  });
}

function isPosixPlain(character: string): boolean {
  const code = character.charCodeAt(0);
  if (code >= FIRST_NON_ASCII_CODE) return true;
  const lower = character.toLowerCase();
  const isLetter = lower >= "a" && lower <= "z";
  const isDigit = character >= "0" && character <= "9";
  return isLetter || isDigit || POSIX_PLAIN_PUNCTUATION.has(character);
}

function quotePath(path: string, platform: DropPlatform): string {
  if (platform === "windows") return [...path].some((character) => WINDOWS_SPECIAL.has(character)) ? `"${path}"` : path;
  return [...path].map((character) => (isPosixPlain(character) ? character : `\\${character}`)).join("");
}

/**
 * The text a native terminal pastes for dropped files: each path quoted for
 * the platform (Terminal.app and iTerm2 backslash-escape, Windows Terminal
 * wraps in double quotes), separated and followed by a space. Paths holding
 * control characters are left out; an empty result means nothing to paste.
 */
export function formatDroppedPaths(paths: readonly string[], platform: DropPlatform): string {
  const quoted = paths.filter((path) => path && !hasControlCharacter(path)).map((path) => quotePath(path, platform));
  return quoted.length ? `${quoted.join(" ")} ` : "";
}

/**
 * Tauri reports the drop position as "physical", but only WebView2 (Windows)
 * really sends device pixels; WKWebView and WebKitGTK send CSS pixels.
 */
export function dropPointToClient(
  position: { x: number; y: number },
  platform: DropPlatform,
  devicePixelRatio: number,
): { x: number; y: number } {
  const scale = platform === "windows" && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return { x: position.x / scale, y: position.y / scale };
}
