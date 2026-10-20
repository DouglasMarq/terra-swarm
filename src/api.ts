import { mcpApi } from "./lib/tauri/mcp";
import { previewApi } from "./lib/tauri/preview";
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
  ...mcpApi,
  ...previewApi,
};

export type Api = typeof api;
