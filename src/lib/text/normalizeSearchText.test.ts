import { describe, expect, it } from "vitest";
import { normalizeSearchText } from "./normalizeSearchText";

describe("normalizeSearchText", () => {
  it("Given accented mixed-case text, when normalizing it, then it is folded to plain lower case", () => {
    expect(normalizeSearchText("AÇÃO Rápida")).toBe("acao rapida");
  });

  it("Given surrounding whitespace, when normalizing it, then it is trimmed and inner spaces are kept", () => {
    expect(normalizeSearchText("  Núcleo  de  dados ")).toBe("nucleo  de  dados");
  });

  it("Given an empty string, when normalizing it, then an empty string is returned", () => {
    expect(normalizeSearchText("")).toBe("");
  });
});
