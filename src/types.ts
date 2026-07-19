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
