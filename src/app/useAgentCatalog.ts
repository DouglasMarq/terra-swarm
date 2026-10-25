import { useRef, useState } from "react";
import { api } from "../api";
import type { AgentInfo } from "../domain/agent.model";

export function useAgentCatalog() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const latest = useRef<AgentInfo[]>([]);
  const ready = useRef<Promise<void>>(Promise.resolve());

  const detect = () => {
    ready.current = api
      .detectAgents()
      .then((found) => {
        latest.current = found;
        setAgents(found);
      })
      .catch((error) => console.warn("agent detection failed:", error));
    return ready.current;
  };

  return {
    agents,
    detect,
    whenReady: () => ready.current,
    isAvailable: (id: string) => latest.current.some((agent) => agent.id === id && agent.available),
  };
}
