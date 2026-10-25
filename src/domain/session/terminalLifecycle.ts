import type { RunningTerminal } from "../terminal.model";

export function isCurrentSpawnedTerminalRunning(
  id: string,
  seq: number,
  running: readonly RunningTerminal[],
): boolean {
  return running.some((terminal) => terminal.id === id && terminal.seq === seq);
}
