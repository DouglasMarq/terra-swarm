export interface TerminalDimensions {
  cols: number;
  rows: number;
}

export interface FitSchedulerOptions {
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
}

const requestAnimationFrameSafe = (callback: () => void): number => {
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    return 0;
  }
  return window.requestAnimationFrame(callback);
};

const cancelAnimationFrameSafe = (handle: number): void => {
  if (handle && typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
    window.cancelAnimationFrame(handle);
  }
};

/** Coalesces every geometry signal that arrives during one animation frame. */
export function createFitScheduler(
  fit: () => void,
  options: FitSchedulerOptions = {},
): { schedule: () => void; dispose: () => void } {
  const requestFrame = options.requestFrame ?? requestAnimationFrameSafe;
  const cancelFrame = options.cancelFrame ?? cancelAnimationFrameSafe;
  let frame: number | null = null;
  let disposed = false;

  return {
    schedule() {
      if (disposed || frame !== null) return;
      frame = requestFrame(() => {
        frame = null;
        if (!disposed) fit();
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frame !== null) cancelFrame(frame);
      frame = null;
    },
  };
}

function sameDimensions(a: TerminalDimensions | null, b: TerminalDimensions): boolean {
  return a?.cols === b.cols && a.rows === b.rows;
}

/**
 * Sends PTY dimensions in order while collapsing intermediate layout states.
 * A resize observer can produce several values in one drag/fullscreen change;
 * only the latest value is relevant once the current IPC call completes.
 */
export function createTerminalResizeQueue(
  send: (dimensions: TerminalDimensions) => Promise<void>,
): {
  request: (dimensions: TerminalDimensions) => void;
  /** Forget the last PTY geometry after a lifecycle restart. */
  reset: () => void;
  dispose: () => void;
} {
  let disposed = false;
  let lastSent: TerminalDimensions | null = null;
  let queued: TerminalDimensions | null = null;
  let inFlight: TerminalDimensions | null = null;
  let inFlightGeneration = 0;
  let generation = 0;

  const pump = () => {
    if (disposed || inFlight || !queued) return;
    const next = queued;
    queued = null;
    if (sameDimensions(lastSent, next)) {
      pump();
      return;
    }
    inFlight = next;
    const requestGeneration = generation;
    inFlightGeneration = requestGeneration;
    Promise.resolve(send(next)).then(
      () => {
        if (!disposed && requestGeneration === generation) lastSent = next;
      },
      () => {
        // A later observer/focus signal may retry the same dimensions. Do not
        // manufacture a timer here: resize events are the source of truth.
      },
    ).finally(() => {
      inFlight = null;
      pump();
    });
  };

  return {
    request(dimensions) {
      if (disposed || dimensions.cols < 1 || dimensions.rows < 1) return;
      if (sameDimensions(lastSent, dimensions)) return;
      if (sameDimensions(inFlight, dimensions) && inFlightGeneration === generation) return;
      if (queued && sameDimensions(queued, dimensions)) return;
      queued = dimensions;
      pump();
    },
    reset() {
      if (disposed) return;
      generation += 1;
      lastSent = null;
      queued = null;
    },
    dispose() {
      disposed = true;
      queued = null;
    },
  };
}
