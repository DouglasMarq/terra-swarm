/** Terminal font choice: the CSS stack for xterm and the font picker filter. */
import { normalizeSearchText } from "./text/normalizeSearchText";

export interface SystemFont {
  name: string;
  monospace: boolean;
}

/** Used when no font is chosen, and as the fallback after a chosen one. */
export const DEFAULT_TERMINAL_FONT_STACK = "'SF Mono', Menlo, Monaco, 'Courier New', monospace";

/** A font family name quoted for CSS, without characters that could break out of the quotes. */
export function quoteFontFamily(name: string): string {
  return `'${name.replace(/['"\\]/g, "")}'`;
}

/** CSS font-family for xterm: the chosen font first, then the default stack. */
export function terminalFontStack(name: string | null | undefined): string {
  const trimmed = name?.trim();
  return trimmed ? `${quoteFontFamily(trimmed)}, ${DEFAULT_TERMINAL_FONT_STACK}` : DEFAULT_TERMINAL_FONT_STACK;
}

/** Case- and accent-insensitive substring filter, optionally monospace only. */
export function filterFonts(fonts: readonly SystemFont[], query: string, monospaceOnly: boolean): SystemFont[] {
  const needle = normalizeSearchText(query);
  return fonts.filter((font) => (!monospaceOnly || font.monospace) && (!needle || normalizeSearchText(font.name).includes(needle)));
}
