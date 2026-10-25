import { describe, expect, it } from "vitest";
import { indentFor, messageIndentFor } from "./indent";

describe("navigator indent", () => {
  it("Given a tree depth, when indenting a row, then it adds 16px per level after an 8px inset", () => {
    expect(indentFor(0)).toBe("8px");
    expect(indentFor(2)).toBe("40px");
  });

  it("Given a tree depth, when indenting a message, then it sits 4px further in than a row", () => {
    expect(messageIndentFor(1)).toBe("28px");
  });
});
