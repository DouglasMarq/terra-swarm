import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import type { AgentInfo, VoiceStatus, Workspace } from "../types";

interface Props {
  workspaces: Workspace[];
  agents: AgentInfo[];
  exited: Record<string, number | null>;
  branch?: string;
  voiceEnabled: boolean;
  voiceStatus: VoiceStatus;
}

export function StatusBar({
  workspaces,
  agents,
  exited,
  branch,
  voiceEnabled,
  voiceStatus,
}: Props) {
  const [version, setVersion] = useState<string>("");

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(""));
  }, []);

  // Match on the command's first token so "claude --flag" still counts as an
  // agent, and never count plain shells as agents.
  const agentIds = new Set(
    agents.filter((a) => a.id !== "shell").map((a) => a.id),
  );
  const isAgent = (command: string) =>
    agentIds.has(command.split(/\s+/)[0] ?? command);
  const isRunning = (id: string) => !(id in exited);

  const allTerminals = workspaces.flatMap((w) => w.terminals);
  const runningTotal = allTerminals.filter((t) => isRunning(t.id)).length;
  const agentsTotal = allTerminals.filter(
    (t) => isRunning(t.id) && isAgent(t.command),
  ).length;

  return (
    <footer className="statusbar">
      <span className="statusbar-item statusbar-version">
        v{version || "?"}
      </span>
      <span className="statusbar-sep" />
      <span
        className="statusbar-item statusbar-agents"
        title="Agents running across all workspaces"
      >
        <span className="statusbar-dot" />
        {agentsTotal} agent{agentsTotal === 1 ? "" : "s"} running
      </span>
      <span className="statusbar-item statusbar-dim">
        {runningTotal} terminal{runningTotal === 1 ? "" : "s"}
      </span>
      {branch && (
        <>
          <span className="statusbar-sep" />
          <span className="statusbar-item">{branch}</span>
        </>
      )}
      <span className="statusbar-spacer" />
      {voiceEnabled && (
        <span className="statusbar-item statusbar-dim">
          voice: {voiceStatus === "idle" ? "ready" : `${voiceStatus}…`}
        </span>
      )}
      <span className="statusbar-item statusbar-dim">
        {workspaces.length} workspace{workspaces.length === 1 ? "" : "s"}
      </span>
    </footer>
  );
}
