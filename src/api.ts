import { invoke } from "@tauri-apps/api/core";
import type {
  AgentInfo,
  BacklogSnapshot,
  RunningTerminal,
  SpawnedTerminal,
  Workspace,
} from "./types";

export const api = {
  listWorkspaces: () => invoke<Workspace[]>("list_workspaces"),
  createWorkspace: (name: string, cwd: string) =>
    invoke<Workspace>("create_workspace", { name, cwd }),
  closeWorkspace: (id: string) => invoke<void>("close_workspace", { id }),
  renameWorkspace: (id: string, name: string) =>
    invoke<void>("rename_workspace", { id, name }),
  spawnTerminal: (
    workspaceId: string,
    command: string,
    terminalId?: string,
    cols = 80,
    rows = 24,
  ) =>
    invoke<SpawnedTerminal>("spawn_terminal", {
      workspaceId,
      command,
      cols,
      rows,
      terminalId: terminalId ?? null,
    }),
  writeTerminal: (id: string, data: string) =>
    invoke<void>("write_terminal", { id, data }),
  resizeTerminal: (id: string, cols: number, rows: number) =>
    invoke<void>("resize_terminal", { id, cols, rows }),
  killTerminal: (id: string) => invoke<void>("kill_terminal", { id }),
  stopTerminal: (id: string) => invoke<void>("stop_terminal", { id }),
  terminalBacklog: (id: string) =>
    invoke<BacklogSnapshot>("terminal_backlog", { id }),
  runningTerminals: () => invoke<RunningTerminal[]>("running_terminals"),
  reorderTerminals: (wsId: string, order: string[]) =>
    invoke<void>("reorder_terminals", { wsId, order }),
  setTerminalWidth: (wsId: string, terminalId: string, width: number) =>
    invoke<void>("set_terminal_width", { wsId, terminalId, width }),
  detectAgents: () => invoke<AgentInfo[]>("detect_agents"),
  gitBranch: (cwd: string) => invoke<string | null>("git_branch", { cwd }),
};
