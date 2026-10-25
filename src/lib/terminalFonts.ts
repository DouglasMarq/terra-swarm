import { normalizeSearchText } from "./text/normalizeSearchText";

export interface SystemFont {
  name: string;
  monospace: boolean;
}

export const BUNDLED_TERMINAL_FONT = "JetBrains Mono Variable";

export const DEFAULT_TERMINAL_FONT_STACK = `'${BUNDLED_TERMINAL_FONT}', 'SF Mono', Menlo, Monaco, Consolas, 'DejaVu Sans Mono', 'Courier New', monospace`;

export function quoteFontFamily(name: string): string {
  return `'${name.replace(/['"\\]/g, "")}'`;
}

export function terminalFontStack(name: string | null | undefined): string {
  const trimmed = name?.trim();
  return trimmed ? `${quoteFontFamily(trimmed)}, ${DEFAULT_TERMINAL_FONT_STACK}` : DEFAULT_TERMINAL_FONT_STACK;
}

export function filterFonts(fonts: readonly SystemFont[], query: string, isMonospaceOnly: boolean): SystemFont[] {
  const needle = normalizeSearchText(query);
  return fonts.filter((font) => (!isMonospaceOnly || font.monospace) && (!needle || normalizeSearchText(font.name).includes(needle)));
}
