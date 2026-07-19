import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import type { AgentInfo, Workspace } from "../types";

interface Props {
  workspaces: Workspace[];
  active: Workspace | null;
  agents: AgentInfo[];
  exited: Record<string, number | null>;
}

export function StatusBar({ workspaces, active, agents, exited }: Props) {
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

  const wsTerminals = active?.terminals ?? [];
  const runningWs = wsTerminals.filter((t) => isRunning(t.id)).length;
  const agentsWs = wsTerminals.filter(
    (t) => isRunning(t.id) && isAgent(t.command),
  ).length;

  return (
    <footer className="statusbar">
      <span className="statusbar-item statusbar-version">
        v{version || "?"}
      </span>
      <span className="statusbar-sep" />
      <span className="statusbar-item" title="Terminals / agents in this workspace">
        {active ? active.name : "—"}: {runningWs} term · {agentsWs} agent
        {agentsWs === 1 ? "" : "s"}
      </span>
      <span className="statusbar-sep" />
      <span className="statusbar-item" title="Terminals / agents across all workspaces">
        Total: {runningTotal} term · {agentsTotal} agent
        {agentsTotal === 1 ? "" : "s"}
      </span>
      <span className="statusbar-spacer" />
      <span className="statusbar-item statusbar-dim">
        {workspaces.length} workspace{workspaces.length === 1 ? "" : "s"}
      </span>
    </footer>
  );
}
