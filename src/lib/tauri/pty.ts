import type {
  BacklogSnapshot,
  RunningTerminal,
  SpawnedTerminal,
  TerminalRuntimeInfo,
} from "../../types";
import { invokeCommand } from "./commands";

export function spawnTerminal(
  workspaceId: string,
  command: string,
  terminalId?: string,
  cols = 80,
  rows = 24,
  shell?: string,
): Promise<SpawnedTerminal> {
  return invokeCommand("spawnTerminal", {
    workspaceId,
    command,
    cols,
    rows,
    terminalId: terminalId ?? null,
    shell: shell ?? null,
  });
}

export function writeTerminal(id: string, data: string): Promise<void> {
  return invokeCommand("writeTerminal", { id, data });
}

export function resizeTerminal(
  id: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invokeCommand("resizeTerminal", { id, cols, rows });
}

export function killTerminal(id: string): Promise<void> {
  return invokeCommand("killTerminal", { id });
}

export function stopTerminal(id: string): Promise<void> {
  return invokeCommand("stopTerminal", { id });
}

export function terminalBacklog(id: string): Promise<BacklogSnapshot> {
  return invokeCommand("terminalBacklog", { id });
}

export function setDurableScrollbackEnabled(enabled: boolean): Promise<void> {
  return invokeCommand("setDurableScrollbackEnabled", { enabled });
}

export function runningTerminals(): Promise<RunningTerminal[]> {
  return invokeCommand("runningTerminals");
}

export function terminalRuntimeInfo(id: string): Promise<TerminalRuntimeInfo | null> {
  return invokeCommand("terminalRuntimeInfo", { id });
}

export const ptyApi = {
  spawnTerminal,
  writeTerminal,
  resizeTerminal,
  killTerminal,
  stopTerminal,
  terminalBacklog,
  setDurableScrollbackEnabled,
  runningTerminals,
  terminalRuntimeInfo,
} as const;
