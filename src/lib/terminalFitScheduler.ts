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
  let isDisposed = false;

  return {
    schedule() {
      if (isDisposed || frame !== null) return;
      frame = requestFrame(() => {
        frame = null;
        if (!isDisposed) fit();
      });
    },
    dispose() {
      if (isDisposed) return;
      isDisposed = true;
      if (frame !== null) cancelFrame(frame);
      frame = null;
    },
  };
}

const MIN_TERMINAL_CELLS = 1;

export function hasVisibleBox(element: Element): boolean {
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
}

export function isUsableDimensions(dimensions: TerminalDimensions | undefined): dimensions is TerminalDimensions {
  if (!dimensions) return false;
  return (
    Number.isFinite(dimensions.cols) &&
    Number.isFinite(dimensions.rows) &&
    dimensions.cols >= MIN_TERMINAL_CELLS &&
    dimensions.rows >= MIN_TERMINAL_CELLS
  );
}

function sameDimensions(previous: TerminalDimensions | null, next: TerminalDimensions): boolean {
  return previous?.cols === next.cols && previous.rows === next.rows;
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
  let isDisposed = false;
  let lastSent: TerminalDimensions | null = null;
  let queued: TerminalDimensions | null = null;
  let inFlight: TerminalDimensions | null = null;
  let inFlightGeneration = 0;
  let generation = 0;

  const pump = () => {
    if (isDisposed || inFlight || !queued) return;
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
        if (!isDisposed && requestGeneration === generation) lastSent = next;
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
      if (isDisposed || dimensions.cols < 1 || dimensions.rows < 1) return;
      if (sameDimensions(lastSent, dimensions)) return;
      if (sameDimensions(inFlight, dimensions) && inFlightGeneration === generation) return;
      if (queued && sameDimensions(queued, dimensions)) return;
      queued = dimensions;
      pump();
    },
    reset() {
      if (isDisposed) return;
      generation += 1;
      lastSent = null;
      queued = null;
    },
    dispose() {
      isDisposed = true;
      queued = null;
    },
  };
}
