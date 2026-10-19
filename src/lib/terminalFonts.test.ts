import { describe, expect, it } from "vitest";
import { DEFAULT_TERMINAL_FONT_STACK, terminalFontStack } from "./terminalFonts";

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
