import { describe, expect, it } from "vitest";
import { elapsedTime, JUST_NOW_SECONDS } from "./elapsedTime";

const NOW = Date.UTC(2026, 0, 2, 12, 0, 0);
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

describe("elapsedTime", () => {
  it("given less than the just-now window, reads as now", () => {
    expect(elapsedTime(NOW - (JUST_NOW_SECONDS - 1) * SECOND_MS, NOW)).toEqual({ unit: "now" });
  });

  it("given a timestamp in the future, reads as now", () => {
    expect(elapsedTime(NOW + MINUTE_MS, NOW)).toEqual({ unit: "now" });
  });

  it("given the just-now window has passed, counts whole minutes", () => {
    expect(elapsedTime(NOW - JUST_NOW_SECONDS * SECOND_MS, NOW)).toEqual({ unit: "minutes", count: 0 });
    expect(elapsedTime(NOW - 59 * MINUTE_MS, NOW)).toEqual({ unit: "minutes", count: 59 });
  });

  it("given an hour or more, counts whole hours", () => {
    expect(elapsedTime(NOW - 61 * MINUTE_MS, NOW)).toEqual({ unit: "hours", count: 1 });
  });

  it("given a day or more, counts whole days", () => {
    expect(elapsedTime(NOW - 49 * HOUR_MS, NOW)).toEqual({ unit: "days", count: 2 });
  });
});
