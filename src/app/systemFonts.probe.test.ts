// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ listSystemFonts: vi.fn() }));
vi.mock("../api", () => ({ api }));

const NARROW = 1;
const WIDE = 2;

function probeContext(installed: readonly string[]) {
  const context: Pick<CanvasRenderingContext2D, "font" | "measureText"> = {
    font: "",
    measureText: () => {
      const metrics: Pick<TextMetrics, "width"> = { width: installed.some((name) => context.font.includes(name)) ? WIDE : NARROW };
      // Only width is read by the font probe; the other metrics need a real canvas.
      return metrics as TextMetrics;
    },
  };
  // Only font and measureText are used by the font probe; jsdom has no canvas implementation.
  return context as CanvasRenderingContext2D;
}

async function loadFonts() {
  vi.resetModules();
  const module = await import("./systemFonts");
  return module.loadSystemFonts();
}

describe("loadSystemFonts in a browser", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    api.listSystemFonts.mockReset();
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    vi.restoreAllMocks();
  });

  it("Given the backend lists fonts, when loading, then they come back sorted by name and are cached", async () => {
    api.listSystemFonts.mockResolvedValue([{ name: "Menlo", isMonospace: true }, { name: "Arial", isMonospace: false }]);
    vi.resetModules();
    const { loadSystemFonts } = await import("./systemFonts");

    const fonts = await loadSystemFonts();
    await loadSystemFonts();

    expect(fonts.map((font) => font.name)).toEqual(["Arial", "Menlo"]);
    expect(api.listSystemFonts).toHaveBeenCalledTimes(1);
  });

  it("Given the backend returns no fonts, when loading, then the installed known terminal fonts are detected", async () => {
    api.listSystemFonts.mockResolvedValue([]);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(probeContext(["Menlo", "Fira Code"]));

    const fonts = await loadFonts();

    expect(fonts).toEqual([{ name: "Fira Code", isMonospace: true }, { name: "Menlo", isMonospace: true }]);
  });

  it("Given no canvas context, when falling back, then no fonts are detected", async () => {
    api.listSystemFonts.mockResolvedValue(null);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

    expect(await loadFonts()).toEqual([]);
  });

  it("Given the canvas throws, when falling back, then no fonts are detected", async () => {
    api.listSystemFonts.mockRejectedValue(new Error("no listing"));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
      throw new Error("canvas blocked");
    });

    expect(await loadFonts()).toEqual([]);
  });
});
