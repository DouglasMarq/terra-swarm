import { invokeCommand } from "./commands";

/** Ports among `ports` with a server listening on 127.0.0.1. */
function probeDevServers(ports: number[]): Promise<number[]> {
  return invokeCommand("probeDevServers", { ports });
}

export const previewApi = { probeDevServers } as const;

/** Emitted when a terminal prints a loopback URL. */
export const DEV_SERVER_EVENT = "terminal-dev-server";

export interface DevServerPayload {
  id: string;
  workspace_id: string;
  url: string;
}
