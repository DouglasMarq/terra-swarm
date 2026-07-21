import { invoke } from "@tauri-apps/api/core";
import type {
  AgentInfo,
  BacklogSnapshot,
  RunningTerminal,
  SpawnedTerminal,
  VoiceModelInfo,
  Workspace,
} from "./types";

export const api = {
  listWorkspaces: () => invoke<Workspace[]>("list_workspaces"),
  storeSavedAt: () => invoke<number | null>("store_saved_at"),
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
    shell?: string,
  ) =>
    invoke<SpawnedTerminal>("spawn_terminal", {
      workspaceId,
      command,
      cols,
      rows,
      terminalId: terminalId ?? null,
      shell: shell ?? null,
    }),
  listShells: () => invoke<string[]>("list_available_shells"),
  writeTerminal: (id: string, data: string) =>
    invoke<void>("write_terminal", { id, data }),
  resizeTerminal: (id: string, cols: number, rows: number) =>
    invoke<void>("resize_terminal", { id, cols, rows }),
  killTerminal: (id: string) => invoke<void>("kill_terminal", { id }),
  stopTerminal: (id: string) => invoke<void>("stop_terminal", { id }),
  terminalBacklog: (id: string) =>
    invoke<BacklogSnapshot>("terminal_backlog", { id }),
  runningTerminals: () => invoke<RunningTerminal[]>("running_terminals"),
  reorderWorkspaces: (order: string[]) =>
    invoke<void>("reorder_workspaces", { order }),
  setTerminalWidth: (wsId: string, terminalId: string, width: number) =>
    invoke<void>("set_terminal_width", { wsId, terminalId, width }),
  detectAgents: () => invoke<AgentInfo[]>("detect_agents"),
  gitBranch: (cwd: string) => invoke<string | null>("git_branch", { cwd }),
  voiceToggleRecording: () => invoke<void>("voice_toggle_recording"),
  voiceSetLanguage: (language: string) =>
    invoke<void>("voice_set_language", { language }),
  voiceMicAvailable: () => invoke<boolean>("voice_mic_available"),
  voiceListModels: () => invoke<VoiceModelInfo[]>("voice_list_models"),
  voiceSetModel: (modelId: string) =>
    invoke<void>("voice_set_model", { modelId }),
  voiceDownloadModel: (modelId: string) =>
    invoke<void>("voice_download_model", { modelId }),
};
