import { describe, expect, it } from "vitest";
import { taskNumber } from "./taskNumber";

describe("taskNumber", () => {
  it("given a T- id in any case, returns its number", () => {
    expect(taskNumber("T-12")).toBe(12);
    expect(taskNumber("t-3")).toBe(3);
  });

  it("given an id without a number, sorts it last", () => {
    expect(taskNumber("draft")).toBe(Number.MAX_SAFE_INTEGER);
  });
});
