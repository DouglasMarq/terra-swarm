import { describe, expect, it } from "vitest";
import { clamp } from "./clamp";

describe("clamp", () => {
  it("Given a value inside the range, when clamping, then it keeps the value", () => {
    expect(clamp(42, 0, 100)).toBe(42);
  });

  it("Given a value outside the range, when clamping, then it returns the nearest bound", () => {
    expect(clamp(-5, 0, 100)).toBe(0);
    expect(clamp(140, 0, 100)).toBe(100);
  });
});
