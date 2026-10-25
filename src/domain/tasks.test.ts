import { describe, expect, it } from "vitest";
import { taskNumber } from "./tasks";

describe("taskNumber", () => {
  it("Given a T- id in any case, when reading its number, then the number is returned", () => {
    expect(taskNumber("T-12")).toBe(12);
    expect(taskNumber("t-3")).toBe(3);
  });

  it("Given an id without a number, when reading its number, then it sorts last", () => {
    expect(taskNumber("draft")).toBe(Number.MAX_SAFE_INTEGER);
  });
});
