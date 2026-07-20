export interface TerminalMeta {
  id: string;
  command: string;
  width: number | null;
}

export interface Workspace {
  id: string;
  name: string;
  cwd: string;
  terminals: TerminalMeta[];
}

export interface AgentInfo {
  id: string;
  label: string;
  available: boolean;
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

export interface NotificationPayload {
  id: string;
  workspace_id: string;
  count: number;
  messages: string[];
}

export interface NotificationItem {
  key: number;
  terminalId: string;
  workspaceId: string;
  message: string;
  ts: number;
  read: boolean;
  system?: boolean;
  update?: boolean;
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

export type VoiceStatus = "idle" | "recording" | "transcribing";

export interface VoiceModelInfo {
  id: string;
  display_name: string;
  size_label: string;
  description: string;
  downloaded: boolean;
  active: boolean;
}

export interface VoiceDownloadProgress {
  model_id: string;
  downloaded: number;
  total: number;
  percent: number;
}
