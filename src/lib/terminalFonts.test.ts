import { describe, expect, it } from "vitest";
import { BUNDLED_TERMINAL_FONT, DEFAULT_TERMINAL_FONT_STACK, filterFonts, quoteFontFamily, terminalFontStack } from "./terminalFonts";

describe("terminalFontStack", () => {
  it("Given no chosen font, when building the font stack, then the default stack is used", () => {
    expect(terminalFontStack("")).toBe(DEFAULT_TERMINAL_FONT_STACK);
    expect(terminalFontStack("  ")).toBe(DEFAULT_TERMINAL_FONT_STACK);
    expect(terminalFontStack(null)).toBe(DEFAULT_TERMINAL_FONT_STACK);
  });

  it("Given no chosen font, when building the font stack, then the bundled JetBrains Mono comes first", () => {
    expect(terminalFontStack(null).startsWith(`'${BUNDLED_TERMINAL_FONT}',`)).toBe(true);
  });

  it("Given a chosen font, when building the font stack, then it comes first and the fallbacks are kept", () => {
    expect(terminalFontStack("JetBrains Mono")).toBe(`'JetBrains Mono', ${DEFAULT_TERMINAL_FONT_STACK}`);
  });

  it("Given a typed name with quotes, when building the font stack, then the quotes are stripped so it cannot break the CSS", () => {
    expect(terminalFontStack("Fira' Code")).toBe(`'Fira Code', ${DEFAULT_TERMINAL_FONT_STACK}`);
  });
});

describe("filterFonts", () => {
  const fonts = [
    { name: "Helvetica", isMonospace: false },
    { name: "JetBrains Mono", isMonospace: true },
    { name: "Tapajós Sans", isMonospace: false },
  ];

  it("Given an empty filter, when filtering fonts, then everything is shown", () => {
    expect(filterFonts(fonts, "", false)).toHaveLength(3);
  });

  it("Given a substring, when filtering fonts, then it matches ignoring case and accents", () => {
    expect(filterFonts(fonts, "brains", false).map((font) => font.name)).toEqual(["JetBrains Mono"]);
    expect(filterFonts(fonts, "tapajos", false).map((font) => font.name)).toEqual(["Tapajós Sans"]);
  });

  it("Given the monospace-only option, when filtering fonts, then only monospace fonts are kept", () => {
    expect(filterFonts(fonts, "", true).map((font) => font.name)).toEqual(["JetBrains Mono"]);
  });
});

describe("quoteFontFamily", () => {
  it("Given a plain family name, when quoting it, then it is wrapped in single quotes", () => {
    expect(quoteFontFamily("Fira Code")).toBe("'Fira Code'");
  });

  it("Given quotes or backslashes in the name, when quoting it, then they are dropped", () => {
    expect(quoteFontFamily("Fi'r\"a\\ Code")).toBe("'Fira Code'");
  });
});
