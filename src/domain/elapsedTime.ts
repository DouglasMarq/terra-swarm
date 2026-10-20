/** Elapsed time under which a moment still reads as "now", in seconds. */
export const JUST_NOW_SECONDS = 45;

export type ElapsedTime =
  | { unit: "now" }
  | { unit: "minutes" | "hours" | "days"; count: number };

/** How long before `nowMs` the moment `timestampMs` was, in its largest whole unit. */
export function elapsedTime(timestampMs: number, nowMs: number): ElapsedTime {
  const seconds = Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
  if (seconds < JUST_NOW_SECONDS) return { unit: "now" };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { unit: "minutes", count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: "hours", count: hours };
  return { unit: "days", count: Math.floor(hours / 24) };
}
