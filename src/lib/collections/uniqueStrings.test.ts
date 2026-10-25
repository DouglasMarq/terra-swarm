import { describe, expect, it } from "vitest";
import { uniqueStrings } from "./uniqueStrings";

describe("uniqueStrings", () => {
  it("Given repeated and empty values, when deduplicating, then it keeps each non-empty value once in first-seen order", () => {
    expect(uniqueStrings(["b", "", "a", "b", "c", "a"])).toEqual(["b", "a", "c"]);
  });
});
