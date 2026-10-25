import { useState } from "react";
import type { AgentRole } from "../domain/agent.model";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useUiStore } from "../stores/uiStore";
import type { useAgentCatalog } from "./useAgentCatalog";
import type { TerminalSessions } from "./useTerminalSessions";

type AgentCatalog = Pick<ReturnType<typeof useAgentCatalog>, "whenReady" | "isAvailable">;

interface PickerRequest {
  workspaceId: string;
  paneId: string | null;
  shouldSaveDefault: boolean;
}

type PickerSessions = Pick<TerminalSessions, "spawnInto" | "reportSpawnError">;

export function useAgentPicker(agentCatalog: AgentCatalog, sessions: PickerSessions) {
  const defaultAgent = usePreferencesStore((state) => state.defaultAgent);
  const [isOpen, setOpenState] = useState(false);
  const [target, setTarget] = useState<string | null>(null);
  const [targetPane, setTargetPane] = useState<string | null>(null);
  const [shouldSaveDefault, setSaveDefault] = useState(false);
  const [shouldIsolate, setIsolate] = useState(false);
  const [role, setRole] = useState<AgentRole | null>(null);

  const resetChoice = () => {
    setTarget(null);
    setTargetPane(null);
    setSaveDefault(false);
    setIsolate(false);
    setRole(null);
  };

  const showPicker = (request: PickerRequest) => {
    setTarget(request.workspaceId);
    setTargetPane(request.paneId);
    setSaveDefault(request.shouldSaveDefault);
    setOpenState(true);
  };

  const selectTargetWorkspace = (workspaceId: string) => {
    const ui = useUiStore.getState();
    ui.setActiveId(workspaceId);
    ui.setExpandedId(null);
  };

  const quickNewTerminal = async (workspaceId: string, paneId: string | null = null) => {
    selectTargetWorkspace(workspaceId);
    await agentCatalog.whenReady();
    const isDefaultAvailable = defaultAgent && agentCatalog.isAvailable(defaultAgent);
    if (isDefaultAvailable) {
      sessions.spawnInto(workspaceId, defaultAgent, { placement: paneId ? { paneId } : undefined }).catch(sessions.reportSpawnError);
      return;
    }
    showPicker({ workspaceId, paneId, shouldSaveDefault: false });
  };

  const chooseForPanel = async (workspaceId: string, paneId: string | null = null) => {
    selectTargetWorkspace(workspaceId);
    await agentCatalog.whenReady();
    showPicker({ workspaceId, paneId, shouldSaveDefault: true });
  };

  const choose = async (agentId: string) => {
    if (shouldSaveDefault) usePreferencesStore.getState().setDefaultAgent(agentId);
    setOpenState(false);
    const chosenTarget = target;
    const options = { shouldUseWorktree: shouldIsolate, role, placement: targetPane ? { paneId: targetPane } : undefined };
    resetChoice();
    if (!chosenTarget) return;
    await sessions.spawnInto(chosenTarget, agentId, options)
      .catch(sessions.reportSpawnError);
  };

  const setOpen = (isOpen: boolean) => {
    setOpenState(isOpen);
    if (!isOpen) resetChoice();
  };

  return {
    isOpen,
    target,
    shouldSaveDefault,
    shouldIsolate,
    role,
    setOpen,
    setSaveDefault,
    setIsolate,
    setRole,
    quickNewTerminal,
    chooseForPanel,
    choose,
  };
}
