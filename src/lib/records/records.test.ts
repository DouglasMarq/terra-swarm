import { describe, expect, it } from "vitest";
import { asRecord, isRecord, omitKey } from "./records";

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

describe("omitKey", () => {
  it("Given a record, when omitting one key, then a copy without it is returned and the original is unchanged", () => {
    const original = { kept: 1, dropped: 2 };

    expect(omitKey(original, "dropped")).toEqual({ kept: 1 });
    expect(original).toEqual({ kept: 1, dropped: 2 });
  });
});
