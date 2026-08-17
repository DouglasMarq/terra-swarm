import type { Workspace } from "../../types";

export interface TelemetryModelInput {
  workspaces: readonly Workspace[];
  exited: Readonly<Record<string, number | null>>;
  resumeCount?: number;
  contextUsage: Readonly<Record<string, number>>;
  focusedId?: string | null;
  voiceEnabled: boolean;
  voiceActive: boolean;
  voiceLabel: string;
  orchestrationHydrated: boolean;
}

export interface TerraTelemetryModel {
  activeAgents: number;
  totalAgents: number;
  queuedRuns: number;
  focusedContext: number | null;
  voiceLabel: string;
  voiceState: "disabled" | "ready" | "active";
  syncState: "syncing" | "synced";
}

/** Derives only runtime values already present in the shell props/stores. */
export function deriveTelemetryModel(input: TelemetryModelInput): TerraTelemetryModel {
  const totalAgents = input.workspaces.reduce((count, workspace) => count + workspace.terminals.length, 0);
  const activeAgents = input.workspaces.reduce(
    (count, workspace) => count + workspace.terminals.filter((terminal) => !(terminal.id in input.exited) && !terminal.suspended).length,
    0,
  );
  const focusedContext = input.focusedId
    ? input.contextUsage[input.focusedId] ?? null
    : null;

  return {
    activeAgents,
    totalAgents,
    queuedRuns: Math.max(0, input.resumeCount ?? 0),
    focusedContext,
    voiceLabel: input.voiceLabel,
    voiceState: input.voiceEnabled ? (input.voiceActive ? "active" : "ready") : "disabled",
    syncState: input.orchestrationHydrated ? "synced" : "syncing",
  };
}
