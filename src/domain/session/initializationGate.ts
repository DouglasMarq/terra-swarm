/**
 * Coalesces one asynchronous application initialization attempt at a time.
 * A rejected attempt is cleared so a later user-triggered retry can run.
 */
export interface InitializationGate {
  isRunning: () => boolean;
  run: (task: () => void | Promise<void>) => Promise<void>;
}

export function createInitializationGate(): InitializationGate {
  let inFlight: Promise<void> | null = null;

  return {
    isRunning: () => inFlight !== null,
    run: (task) => {
      if (inFlight) return inFlight;
      let resolveAttempt!: () => void;
      let rejectAttempt!: (error: unknown) => void;
      // Install the in-flight promise before invoking the task so a
      // synchronous/re-entrant caller still observes the same attempt.
      const attempt = new Promise<void>((resolve, reject) => {
        resolveAttempt = resolve;
        rejectAttempt = reject;
      });
      inFlight = attempt;
      const clear = () => {
        if (inFlight === attempt) inFlight = null;
      };
      void attempt.then(clear, clear);
      try {
        Promise.resolve(task()).then(resolveAttempt, rejectAttempt);
      } catch (error) {
        rejectAttempt(error);
      }
      return attempt;
    },
  };
}
