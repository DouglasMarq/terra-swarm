import { api } from "../api";
import { quoteFontFamily, type SystemFont } from "../lib/terminalFonts";

const PROBE_FONT_SIZE = "72px";

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
    context.font = `${PROBE_FONT_SIZE} ${fallback}`;
    const base = context.measureText(sample).width;
    context.font = `${PROBE_FONT_SIZE} ${quoteFontFamily(name)}, ${fallback}`;
    return context.measureText(sample).width !== base;
  });
}

function installedTerminalFonts(candidates: readonly string[] = KNOWN_TERMINAL_FONTS): string[] {
  return candidates.filter(isFontInstalled);
}

let cached: Promise<SystemFont[]> | null = null;

export function loadSystemFonts(): Promise<SystemFont[]> {
  cached ??= api
    .listSystemFonts()
    .then((fonts) => {
      if (!Array.isArray(fonts) || fonts.length === 0) throw new Error("no fonts");
      return fonts;
    })
    .catch((error) => {
      console.warn("listing system fonts failed, falling back to the known terminal fonts:", error);
      return installedTerminalFonts().map((name) => ({ name, isMonospace: true }));
    })
    .then((fonts) => [...fonts].sort((left, right) => left.name.localeCompare(right.name)));
  return cached;
}
