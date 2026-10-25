import type { RunningTerminal } from "../terminal.model";

/**
 * A spawn response is not, by itself, proof that the child is still alive:
 * short commands can be reaped before the response reaches the frontend.
 * Match both id and generation so an old process cannot mask a new one.
 */
export function isCurrentSpawnedTerminalRunning(
  id: string,
  seq: number,
  running: readonly RunningTerminal[],
): boolean {
  return running.some((terminal) => terminal.id === id && terminal.seq === seq);
}
