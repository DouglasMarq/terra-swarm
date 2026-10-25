/**
 * Installed font families for the terminal font picker. The backend lists
 * every installed family (the webview has no font listing API); when it
 * can't (browser preview), the well-known monospace fonts are detected by
 * measuring text instead.
 */
import { api } from "../api";
import { quoteFontFamily, type SystemFont } from "../lib/terminalFonts";

const KNOWN_TERMINAL_FONTS: readonly string[] = [
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

let probe: CanvasRenderingContext2D | null | undefined;

/**
 * True when `name` renders differently from both generic fallbacks, i.e. the
 * font exists. Wide and narrow glyphs make most fonts measurably distinct.
 */
function isFontInstalled(name: string): boolean {
  if (typeof document === "undefined") return false;
  if (probe === undefined) {
    try {
      probe = document.createElement("canvas").getContext("2d");
    } catch {
      probe = null;
    }
  }
  const context = probe;
  if (!context) return false;
  const sample = "mmmmmmmmmmlli10OWw@#{}";
  return ["monospace", "serif"].some((fallback) => {
    context.font = `72px ${fallback}`;
    const base = context.measureText(sample).width;
    context.font = `72px ${quoteFontFamily(name)}, ${fallback}`;
    return context.measureText(sample).width !== base;
  });
}

function installedTerminalFonts(candidates: readonly string[] = KNOWN_TERMINAL_FONTS): string[] {
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
    .catch((error) => {
      console.warn("listing system fonts failed, falling back to the known terminal fonts:", error);
      return installedTerminalFonts().map((name) => ({ name, monospace: true }));
    })
    .then((fonts) => [...fonts].sort((a, b) => a.name.localeCompare(b.name)));
  return cached;
}
