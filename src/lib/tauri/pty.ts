import type { NotificationPayload } from "../../domain/notification.model";
import type { BacklogSnapshot, ContextPayload, ExitPayload, OutputChunk, RunningTerminal, SpawnedTerminal, TerminalRuntimeInfo, TerminalSpawn, TitlePayload } from "../../domain/terminal.model";
import { invokeCommand } from "./commands";
import { listenPayload, type UnlistenFn } from "./events";

const DEFAULT_TERMINAL_COLUMNS = 80;
const DEFAULT_TERMINAL_ROWS = 24;

export function spawnTerminal(spawn: TerminalSpawn): Promise<SpawnedTerminal> {
  return invokeCommand("spawnTerminal", {
    request: {
      workspaceId: spawn.workspaceId,
      command: spawn.command,
      cols: spawn.cols ?? DEFAULT_TERMINAL_COLUMNS,
      rows: spawn.rows ?? DEFAULT_TERMINAL_ROWS,
      terminalId: spawn.terminalId ?? null,
      shell: spawn.shell ?? null,
      launch: spawn.launch ?? null,
    },
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
  return invokeCommand("resizeTerminal", { request: { id, cols, rows } });
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

export function setDurableScrollbackEnabled(isEnabled: boolean): Promise<void> {
  return invokeCommand("setDurableScrollbackEnabled", { isEnabled });
}

export function runningTerminals(): Promise<RunningTerminal[]> {
  return invokeCommand("runningTerminals");
}

export function terminalRuntimeInfo(id: string): Promise<TerminalRuntimeInfo | null> {
  return invokeCommand("terminalRuntimeInfo", { id });
}

export interface AgentAttentionPayload {
  terminal_id: string;
  workspace_id: string;
  workspace_name?: string | null;
  message?: string;
}

export function onPtyOutput(id: string, handler: (chunk: OutputChunk) => void): Promise<UnlistenFn> {
  return listenPayload(`pty-output-${id}`, handler);
}

export function onTerminalExit(handler: (payload: ExitPayload) => void): Promise<UnlistenFn> {
  return listenPayload("terminal-exit", handler);
}

export function onTerminalNotification(handler: (payload: NotificationPayload) => void): Promise<UnlistenFn> {
  return listenPayload("terminal-notification", handler);
}

export function onTerminalContext(handler: (payload: ContextPayload) => void): Promise<UnlistenFn> {
  return listenPayload("terminal-context", handler);
}

export function onTerminalTitle(handler: (payload: TitlePayload) => void): Promise<UnlistenFn> {
  return listenPayload("terminal-title", handler);
}

export function onAgentAttention(handler: (payload: AgentAttentionPayload) => void): Promise<UnlistenFn> {
  return listenPayload("agent-attention", handler);
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
