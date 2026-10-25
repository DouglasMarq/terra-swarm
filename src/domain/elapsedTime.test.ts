import { describe, expect, it } from "vitest";
import { elapsedTime, JUST_NOW_SECONDS } from "./elapsedTime";

const NOW = Date.UTC(2026, 0, 2, 12, 0, 0);
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

describe("elapsedTime", () => {
  it("Given less than the just-now window, when computing elapsed time, then it reads as now", () => {
    expect(elapsedTime(NOW - (JUST_NOW_SECONDS - 1) * SECOND_MS, NOW)).toEqual({ unit: "now" });
  });

  it("Given a timestamp in the future, when computing elapsed time, then it reads as now", () => {
    expect(elapsedTime(NOW + MINUTE_MS, NOW)).toEqual({ unit: "now" });
  });

  it("Given the just-now window has passed, when computing elapsed time, then it counts whole minutes", () => {
    expect(elapsedTime(NOW - JUST_NOW_SECONDS * SECOND_MS, NOW)).toEqual({ unit: "minutes", count: 0 });
    expect(elapsedTime(NOW - 59 * MINUTE_MS, NOW)).toEqual({ unit: "minutes", count: 59 });
  });

  it("Given an hour or more, when computing elapsed time, then it counts whole hours", () => {
    expect(elapsedTime(NOW - 61 * MINUTE_MS, NOW)).toEqual({ unit: "hours", count: 1 });
  });

  it("Given a day or more, when computing elapsed time, then it counts whole days", () => {
    expect(elapsedTime(NOW - 49 * HOUR_MS, NOW)).toEqual({ unit: "days", count: 2 });
  });
});
