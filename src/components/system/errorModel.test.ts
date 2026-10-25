import { describe, expect, it } from "vitest";

import { translateNow } from "../../i18n";
import { getSafeErrorDetails, haveResetKeysChanged } from "./errorModel";

describe("error model", () => {
  it("bounds and redacts report content before it can be copied", () => {
    const details = getSafeErrorDetails(
      new Error("falha em /home/dev/workspace/.env usando ghp_12345678901234567890"),
      { componentStack: "\n at App (/Users/dev/terra/src/App.tsx:1:1)" },
      translateNow,
    );

    expect(details.text).toContain("[path]");
    expect(details.text).toContain("[redacted-token]");
    expect(details.text).not.toContain("/home/dev");
    expect(details.text).not.toContain("ghp_12345678901234567890");
  });

  it("falls back to a safe generic message for unknown thrown values", () => {
    const details = getSafeErrorDetails({ surprise: true }, undefined, translateNow);
    expect(details.name).toBe("UnknownError");
    expect(details.message).toContain("erro inesperado");
  });

  it("detects reset key changes by shallow identity", () => {
    expect(haveResetKeysChanged(["a", 1], ["a", 1])).toBe(false);
    expect(haveResetKeysChanged(["a"], ["b"])).toBe(true);
    expect(haveResetKeysChanged(undefined, [])).toBe(true);
    expect(haveResetKeysChanged([], undefined)).toBe(true);
  });
});
