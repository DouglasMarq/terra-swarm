import type { Group } from "../../domain/workspace.model";
import { useLibraryStore } from "../../stores/libraryStore";
import type { ShellSurface } from "../../stores/shellStore";
import type { CommandPaletteCallbacks } from "../overlays/CommandPalette";
import type { FocusedAgentActionHandler } from "./paneMenu";

export interface ShellPaletteProps {
  groups: readonly Group[];
  activeId: string | null;
  detachedTerminalIds: readonly string[];
  onFocusedAgentAction?: FocusedAgentActionHandler;
  onOpenSettings: () => void;
  onCreateProject: (groupId: string | null) => void;
  onCreateGroup: () => void;
  onNewAgent: (workspaceId: string, paneId?: string | null, agentId?: string) => void;
  onOpenVoiceSettings?: () => void;
  onToggleVoice: () => void;
  onVoiceStartListening?: () => void;
  onVoiceStopListening?: () => void;
  onExportWorkspace?: () => void;
  onImportWorkspace?: () => void;
  onOpenResume?: () => void;
}

export interface ShellPaletteNavigation {
  navigate: (surface: ShellSurface, workspaceId?: string | null) => void;
  focusTerminal: (id: string) => void;
  toggleDock: () => void;
  reopenLastClosedTab: () => void;
}

export function shellPaletteCallbacks(props: ShellPaletteProps, navigation: ShellPaletteNavigation): CommandPaletteCallbacks {
  const { navigate, focusTerminal } = navigation;
  return {
    onFocusedAgentAction: props.onFocusedAgentAction,
    onNavigate: (route) => {
      if (route === "settings") {
        props.onOpenSettings();
        return;
      }
      navigate(route);
    },
    onOpenWorkspace: (id) => navigate("workbench", id),
    onOpenGroup: (id) => {
      const workspaceId = props.groups.find((group) => group.id === id)?.projectIds[0];
      navigate("workbench", workspaceId ?? null);
    },
    onOpenTerminal: (_workspaceId, terminalId) => focusTerminal(terminalId),
    onCreateProject: props.onCreateProject,
    onCreateGroup: props.onCreateGroup,
    onCreateAgent: (workspaceId, agentId) =>
      props.onNewAgent(workspaceId ?? props.activeId ?? "", null, agentId),
    onToggleDock: navigation.toggleDock,
    onOpenVoiceSettings: props.onOpenVoiceSettings ?? props.onToggleVoice,
    onStartVoice: props.onVoiceStartListening ?? props.onToggleVoice,
    onStopVoice: props.onVoiceStopListening ?? props.onToggleVoice,
    onExportWorkspace: props.onExportWorkspace,
    onImportWorkspace: props.onImportWorkspace,
    onReattachTerminal: () => {
      const terminalId = props.detachedTerminalIds[0];
      if (terminalId) focusTerminal(terminalId);
    },
    onOpenResume: props.onOpenResume,
    onOpenLibrary: (dialog) => useLibraryStore.getState().openDialog(dialog),
    onReopenTab: navigation.reopenLastClosedTab,
  };
}
