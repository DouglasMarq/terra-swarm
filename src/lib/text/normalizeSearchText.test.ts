import { describe, expect, it } from "vitest";
import { normalizeSearchText } from "./normalizeSearchText";

describe("normalizeSearchText", () => {
  it("given accented mixed-case text, returns it folded to plain lower case", () => {
    expect(normalizeSearchText("AÇÃO Rápida")).toBe("acao rapida");
  });

  it("given surrounding whitespace, trims it and keeps inner spaces", () => {
    expect(normalizeSearchText("  Núcleo  de  dados ")).toBe("nucleo  de  dados");
  });

  it("given an empty string, returns an empty string", () => {
    expect(normalizeSearchText("")).toBe("");
  });
});
