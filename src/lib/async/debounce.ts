export interface DebouncedTask {
  schedule: () => void;
  cancel: () => void;
}

export function createDebouncedTask(task: () => void, delayMs: number): DebouncedTask {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    schedule: () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        task();
      }, Math.max(0, delayMs));
    },
    cancel: () => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
    },
  };
}
