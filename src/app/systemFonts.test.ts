import { describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ listSystemFonts: vi.fn() }));
vi.mock("../api", () => ({ api }));

import { loadSystemFonts } from "./systemFonts";

describe("loadSystemFonts", () => {
  it("given the backend can't list fonts, warns and falls back to the detected terminal fonts", async () => {
    api.listSystemFonts.mockRejectedValue(new Error("no font listing"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(loadSystemFonts()).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("listing system fonts failed"), expect.any(Error));
    warn.mockRestore();
  });
});
