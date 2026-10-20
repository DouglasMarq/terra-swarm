import { describe, expect, it } from "vitest";
import { DEFAULT_TERMINAL_FONT_STACK, filterFonts, quoteFontFamily, terminalFontStack } from "./terminalFonts";

describe("terminalFontStack", () => {
  it("uses the default stack when no font is chosen", () => {
    expect(terminalFontStack("")).toBe(DEFAULT_TERMINAL_FONT_STACK);
    expect(terminalFontStack("  ")).toBe(DEFAULT_TERMINAL_FONT_STACK);
    expect(terminalFontStack(null)).toBe(DEFAULT_TERMINAL_FONT_STACK);
  });

  it("puts the chosen font first and keeps the fallbacks", () => {
    expect(terminalFontStack("JetBrains Mono")).toBe(`'JetBrains Mono', ${DEFAULT_TERMINAL_FONT_STACK}`);
  });

  it("strips quotes so a typed name cannot break the CSS", () => {
    expect(terminalFontStack("Fira' Code")).toBe(`'Fira Code', ${DEFAULT_TERMINAL_FONT_STACK}`);
  });
});

describe("filterFonts", () => {
  const fonts = [
    { name: "Helvetica", monospace: false },
    { name: "JetBrains Mono", monospace: true },
    { name: "Tapajós Sans", monospace: false },
  ];

  it("shows everything with an empty filter", () => {
    expect(filterFonts(fonts, "", false)).toHaveLength(3);
  });

  it("matches a substring ignoring case and accents", () => {
    expect(filterFonts(fonts, "brains", false).map((f) => f.name)).toEqual(["JetBrains Mono"]);
    expect(filterFonts(fonts, "tapajos", false).map((f) => f.name)).toEqual(["Tapajós Sans"]);
  });

  it("can keep only monospace fonts", () => {
    expect(filterFonts(fonts, "", true).map((f) => f.name)).toEqual(["JetBrains Mono"]);
  });
});

describe("quoteFontFamily", () => {
  it("given a plain family name, wraps it in single quotes", () => {
    expect(quoteFontFamily("Fira Code")).toBe("'Fira Code'");
  });

  it("given quotes or backslashes in the name, drops them", () => {
    expect(quoteFontFamily("Fi'r\"a\\ Code")).toBe("'Fira Code'");
  });
});
