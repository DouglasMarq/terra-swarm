import { HOURS_PER_DAY, MINUTES_PER_HOUR, MS_PER_SECOND, SECONDS_PER_MINUTE } from "../lib/time/durations";

export const JUST_NOW_SECONDS = 45;

export type ElapsedTime =
  | { unit: "now" }
  | { unit: "minutes" | "hours" | "days"; count: number };

export function elapsedTime(timestampMs: number, nowMs: number): ElapsedTime {
  const seconds = Math.max(0, Math.floor((nowMs - timestampMs) / MS_PER_SECOND));
  if (seconds < JUST_NOW_SECONDS) return { unit: "now" };
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) return { unit: "minutes", count: minutes };
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  if (hours < HOURS_PER_DAY) return { unit: "hours", count: hours };
  return { unit: "days", count: Math.floor(hours / HOURS_PER_DAY) };
}
