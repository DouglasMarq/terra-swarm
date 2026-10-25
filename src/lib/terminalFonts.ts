/** Terminal font choice: the CSS stack for xterm and the font picker filter. */
import { normalizeSearchText } from "./text/normalizeSearchText";

export interface SystemFont {
  name: string;
  monospace: boolean;
}

/** Ships with the app (@fontsource-variable/jetbrains-mono), the same on every platform. */
export const BUNDLED_TERMINAL_FONT = "JetBrains Mono Variable";

/**
 * Used when no font is chosen, and as the fallback after a chosen one. The
 * bundled subsets have no box-drawing characters, so those come from the
 * platform monospace fonts that follow it.
 */
export const DEFAULT_TERMINAL_FONT_STACK = `'${BUNDLED_TERMINAL_FONT}', 'SF Mono', Menlo, Monaco, Consolas, 'DejaVu Sans Mono', 'Courier New', monospace`;

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
