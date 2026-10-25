import type { AgentRole } from "./agent.model";
import type { WorktreeInfo } from "./worktree.model";

export interface TerminalMeta {
  id: string;
  command: string;
  width: number | null;
  paneId?: string | null;
  tabId?: string | null;
  groupId?: string | null;
  isSuspended?: boolean;
  worktree?: WorktreeInfo | null;
  role?: AgentRole | null;
}

export interface TerminalPlacement {
  workspaceId: string;
  terminalId: string;
  paneId: string;
  tabId: string;
}

export interface ExitPayload {
  id: string;
  workspace_id: string;
  code: number | null;
  seq: number;
}

export interface OutputChunk {
  data: string;
  total: number;
}

export interface SpawnedTerminal {
  meta: TerminalMeta;
  seq: number;
}

export interface RunningTerminal {
  id: string;
  seq: number;
}

export interface TerminalRuntimeInfo {
  id: string;
  pid: number | null;
  cols: number;
  rows: number;
  isRunning: boolean;
  isReaped: boolean;
  generation: number;
}

export interface BacklogSnapshot {
  data: string;
  total: number;
}

export interface ResumeItem {
  terminalId: string;
  wsId: string;
  wsName: string;
  cwd: string;
  command: string;
  agentId: string;
  resumeCommand: string;
}

export interface ContextPayload {
  id: string;
  workspace_id: string;
  used: number;
}

export interface TitlePayload {
  id: string;
  workspace_id: string;
  title: string;
}
