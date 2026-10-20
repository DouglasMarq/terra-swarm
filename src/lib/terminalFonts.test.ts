import { describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ listSystemFonts: vi.fn() }));
vi.mock("../api", () => ({ api }));

import { DEFAULT_TERMINAL_FONT_STACK, filterFonts, loadSystemFonts, terminalFontStack } from "./terminalFonts";

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

describe("loadSystemFonts", () => {
  it("given the backend can't list fonts, warns and falls back to the detected terminal fonts", async () => {
    api.listSystemFonts.mockRejectedValue(new Error("no font listing"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(loadSystemFonts()).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("listing system fonts failed"), expect.any(Error));
    warn.mockRestore();
  });
});
