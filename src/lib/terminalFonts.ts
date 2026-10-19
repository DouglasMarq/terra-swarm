/**
 * Terminal font choice. The backend lists every installed family (the
 * webview has no font listing API); when it can't (browser preview), the
 * well-known monospace fonts are detected by measuring text instead.
 */
import { api } from "../api";

export interface SystemFont {
  name: string;
  monospace: boolean;
}

/** Used when no font is chosen, and as the fallback after a chosen one. */
export const DEFAULT_TERMINAL_FONT_STACK = "'SF Mono', Menlo, Monaco, 'Courier New', monospace";

export const KNOWN_TERMINAL_FONTS: readonly string[] = [
  "SF Mono",
  "Menlo",
  "Monaco",
  "JetBrains Mono",
  "Fira Code",
  "Cascadia Code",
  "Cascadia Mono",
  "Source Code Pro",
  "IBM Plex Mono",
  "Geist Mono",
  "Hack",
  "Iosevka",
  "Victor Mono",
  "Berkeley Mono",
  "MesloLGS NF",
  "Hasklig",
  "Inconsolata",
  "Roboto Mono",
  "Ubuntu Mono",
  "DejaVu Sans Mono",
  "Consolas",
  "Courier New",
];

function quote(name: string): string {
  return `'${name.replace(/['"\\]/g, "")}'`;
}

/** CSS font-family for xterm: the chosen font first, then the default stack. */
export function terminalFontStack(name: string | null | undefined): string {
  const trimmed = name?.trim();
  return trimmed ? `${quote(trimmed)}, ${DEFAULT_TERMINAL_FONT_STACK}` : DEFAULT_TERMINAL_FONT_STACK;
}

let probe: CanvasRenderingContext2D | null | undefined;

/**
 * True when `name` renders differently from both generic fallbacks, i.e. the
 * font exists. Wide and narrow glyphs make most fonts measurably distinct.
 */
export function isFontInstalled(name: string): boolean {
  if (typeof document === "undefined") return false;
  if (probe === undefined) {
    try {
      probe = document.createElement("canvas").getContext("2d");
    } catch {
      probe = null;
    }
  }
  if (!probe) return false;
  const sample = "mmmmmmmmmmlli10OWw@#{}";
  return ["monospace", "serif"].some((fallback) => {
    probe!.font = `72px ${fallback}`;
    const base = probe!.measureText(sample).width;
    probe!.font = `72px ${quote(name)}, ${fallback}`;
    return probe!.measureText(sample).width !== base;
  });
}

export function installedTerminalFonts(candidates: readonly string[] = KNOWN_TERMINAL_FONTS): string[] {
  return candidates.filter(isFontInstalled);
}

let cached: Promise<SystemFont[]> | null = null;

/** Installed font families, alphabetical. Loaded once per session. */
export function loadSystemFonts(): Promise<SystemFont[]> {
  cached ??= api
    .listSystemFonts()
    .then((fonts) => {
      if (!Array.isArray(fonts) || fonts.length === 0) throw new Error("no fonts");
      return fonts;
    })
    .catch(() => installedTerminalFonts().map((name) => ({ name, monospace: true })))
    .then((fonts) => [...fonts].sort((a, b) => a.name.localeCompare(b.name)));
  return cached;
}

/** Case- and accent-insensitive substring filter, optionally monospace only. */
export function filterFonts(fonts: readonly SystemFont[], query: string, monospaceOnly: boolean): SystemFont[] {
  const fold = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const needle = fold(query.trim());
  return fonts.filter((font) => (!monospaceOnly || font.monospace) && (!needle || fold(font.name).includes(needle)));
}
