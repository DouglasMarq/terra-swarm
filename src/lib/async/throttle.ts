export function throttle<Args extends unknown[]>(
  task: (...args: Args) => void,
  intervalMs: number,
): (...args: Args) => void {
  let lastRunAt = 0;
  return (...args) => {
    const now = Date.now();
    if (now - lastRunAt < intervalMs) return;
    lastRunAt = now;
    task(...args);
  };
}
