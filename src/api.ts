import { ptyApi } from "./lib/tauri/pty";
import { systemApi } from "./lib/tauri/system";
import { voiceApi } from "./lib/tauri/voice";
import { workspaceApi } from "./lib/tauri/workspace";
import { worktreeApi } from "./lib/tauri/worktree";

export const api = {
  ...workspaceApi,
  ...ptyApi,
  ...systemApi,
  ...voiceApi,
  ...worktreeApi,
};

export type Api = typeof api;
