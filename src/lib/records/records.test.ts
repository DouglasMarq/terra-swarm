import { describe, expect, it } from "vitest";
import { asRecord, isRecord } from "./records";

describe("records", () => {
  it("Given a plain object, when checking and reading it, then it is a record read as itself", () => {
    const value = { id: "terra" };
    expect(isRecord(value)).toBe(true);
    expect(asRecord(value)).toBe(value);
  });

  it("Given an array, when checking and reading it, then it is not a record but is still read as an object", () => {
    const value = ["terra"];
    expect(isRecord(value)).toBe(false);
    expect(asRecord(value)).toBe(value);
  });

  it("Given null or a primitive, when checking and reading it, then it is not a record and reads as empty", () => {
    for (const value of [null, undefined, "terra", 3]) {
      expect(isRecord(value)).toBe(false);
      expect(asRecord(value)).toEqual({});
    }
  });
});
