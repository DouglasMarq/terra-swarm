import { describe, expect, it } from "vitest";
import { formatTokens } from "./formatTokens";

describe("formatTokens", () => {
  it("Given large token counts, when formatting them, then they are abbreviated", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_345)).toBe("12.3k");
    expect(formatTokens(4_000_000)).toBe("4M");
    expect(formatTokens(294_718_962)).toBe("295M");
    expect(formatTokens(-3)).toBe("0");
  });
});
