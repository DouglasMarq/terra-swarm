import { open, save, type OpenDialogOptions, type SaveDialogOptions } from "@tauri-apps/plugin-dialog";
import type { AgentInfo, WorkspaceGitStatus } from "../../types";
import { invokeCommand } from "./commands";

export function openDialog(options: OpenDialogOptions) {
  return open(options);
}

export function saveDialog(options: SaveDialogOptions) {
  return save(options);
}

/** Last persistence timestamp used by the session-resume flow. */
export function storeSavedAt(): Promise<number | null> {
  return invokeCommand("storeSavedAt");
}

/** Discover shells and locally installed coding agents. */
export function listShells(): Promise<string[]> {
  return invokeCommand("listShells");
}

/** Every font family installed on the system, flagged when monospaced. */
export function listSystemFonts(): Promise<{ name: string; monospace: boolean }[]> {
  return invokeCommand("listSystemFonts");
}

export function detectAgents(): Promise<AgentInfo[]> {
  return invokeCommand("detectAgents");
}

export function gitBranch(cwd: string): Promise<string | null> {
  return invokeCommand("gitBranch", { cwd });
}

export function gitStatus(workspaceId: string): Promise<WorkspaceGitStatus> {
  return invokeCommand("gitStatus", { workspaceId });
}

export const systemApi = {
  storeSavedAt,
  listShells,
  listSystemFonts,
  detectAgents,
  gitBranch,
  gitStatus,
} as const;
