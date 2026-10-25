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
