import { invoke } from "@tauri-apps/api/core";
import type { AgentInfo, AgentTokenUsage, AgentLaunchExtras } from "../../domain/agent.model";
import type { McpAgentStatus, McpServerInfo, McpTask, McpTaskPatch, McpTaskPriority } from "../../domain/mcp.model";
import type { BacklogSnapshot, RunningTerminal, SpawnedTerminal, TerminalRuntimeInfo, TerminalPlacement } from "../../domain/terminal.model";
import type { VoiceModelInfo } from "../../domain/voice.model";
import type { ActivePaneSelection, Workspace, WorkspaceGroup, WorkspaceSnapshotTransfer, WorkspaceContainerPatch, WorkspaceLayout, WorkspaceGitStatus, WorkspacePaneMove } from "../../domain/workspace.model";
import type { WorkspaceFileContent, WorkspaceFileListing, WorkspaceFileSaved, WorkspaceFileWrite } from "../../domain/workspaceFiles.model";
import type { WorktreeDiff, WorktreePullRequest, WorktreeStatus } from "../../domain/worktree.model";
import type { SystemFont } from "../terminalFonts";
import { toIpcError } from "./errors";

export interface IpcCommandContract {
  listWorkspaces: {
    args: undefined;
    result: Workspace[];
  };
  storeSavedAt: {
    args: undefined;
    result: number | null;
  };
  exportWorkspaceSnapshot: {
    args: { path: string };
    result: WorkspaceSnapshotTransfer;
  };
  importWorkspaceSnapshot: {
    args: { path: string };
    result: WorkspaceSnapshotTransfer;
  };
  createWorkspace: {
    args: { request: { name: string; cwd: string } };
    result: Workspace;
  };
  closeWorkspace: {
    args: { id: string };
    result: void;
  };
  renameWorkspace: {
    args: { request: { id: string; name: string } };
    result: void;
  };
  listGroups: {
    args: undefined;
    result: WorkspaceGroup[];
  };
  createGroup: {
    args: { name: string };
    result: WorkspaceGroup;
  };
  renameGroup: {
    args: { request: { id: string; name: string } };
    result: void;
  };
  removeGroup: {
    args: { id: string };
    result: void;
  };
  suspendGroup: {
    args: { id: string };
    result: void;
  };
  resumeGroup: {
    args: { id: string };
    result: void;
  };
  setWorkspaceGroup: {
    args: { request: { workspaceId: string; groupId: string | null } };
    result: void;
  };
  setTerminalPlacement: {
    args: { request: TerminalPlacement };
    result: void;
  };
  setActivePane: {
    args: { request: ActivePaneSelection };
    result: void;
  };
  reorderWorkspaceContainers: {
    args: { request: { workspaceId: string; order: string[] } };
    result: void;
  };
  reorderWorkspacePanes: {
    args: { request: { workspaceId: string; containerId: string; order: string[] } };
    result: void;
  };
  moveWorkspacePane: {
    args: { request: WorkspacePaneMove };
    result: void;
  };
  setWorkspaceContainerState: {
    args: {
      request: {
        workspaceId: string;
        containerId: string;
        patch: WorkspaceContainerPatch;
      };
    };
    result: void;
  };
  setWorkspaceLayout: {
    args: { request: { workspaceId: string; layout: WorkspaceLayout } };
    result: void;
  };
  setWorkspaceCollapsed: {
    args: { request: { workspaceId: string; isCollapsed: boolean } };
    result: void;
  };
  spawnTerminal: {
    args: {
      request: {
        workspaceId: string;
        command: string;
        cols: number;
        rows: number;
        terminalId: string | null;
        shell: string | null;
        launch: AgentLaunchExtras | null;
      };
    };
    result: SpawnedTerminal;
  };
  listShells: {
    args: undefined;
    result: string[];
  };
  listSystemFonts: {
    args: undefined;
    result: SystemFont[];
  };
  writeTerminal: {
    args: { id: string; data: string };
    result: void;
  };
  resizeTerminal: {
    args: { request: { id: string; cols: number; rows: number } };
    result: void;
  };
  killTerminal: {
    args: { id: string };
    result: void;
  };
  stopTerminal: {
    args: { id: string };
    result: void;
  };
  terminalBacklog: {
    args: { id: string };
    result: BacklogSnapshot;
  };
  setDurableScrollbackEnabled: {
    args: { isEnabled: boolean };
    result: void;
  };
  runningTerminals: {
    args: undefined;
    result: RunningTerminal[];
  };
  terminalRuntimeInfo: {
    args: { id: string };
    result: TerminalRuntimeInfo | null;
  };
  reorderWorkspaces: {
    args: { order: string[] };
    result: void;
  };
  setTerminalWidth: {
    args: { request: { wsId: string; terminalId: string; width: number } };
    result: void;
  };
  detectAgents: {
    args: undefined;
    result: AgentInfo[];
  };
  probeDevServers: {
    args: { ports: number[] };
    result: number[];
  };
  gitBranch: {
    args: { cwd: string };
    result: string | null;
  };
  listWorkspaceFiles: {
    args: { request: { workspaceId: string; relativePath?: string; limit?: number } };
    result: WorkspaceFileListing;
  };
  readWorkspaceFile: {
    args: { workspaceId: string; relativePath: string };
    result: WorkspaceFileContent;
  };
  writeWorkspaceFile: {
    args: { request: WorkspaceFileWrite };
    result: WorkspaceFileSaved;
  };
  gitStatus: {
    args: { workspaceId: string };
    result: WorkspaceGitStatus;
  };
  mcpServerInfo: {
    args: undefined;
    result: McpServerInfo;
  };
  mcpSetEnabled: {
    args: { isEnabled: boolean };
    result: McpServerInfo;
  };
  mcpListTasks: {
    args: { workspaceId: string };
    result: McpTask[];
  };
  mcpCreateTask: {
    args: {
      request: {
        workspaceId: string;
        title: string;
        description: string | null;
        priority: McpTaskPriority | null;
        assignee: string | null;
      };
    };
    result: McpTask;
  };
  mcpUpdateTask: {
    args: { request: { workspaceId: string; id: string; patch: McpTaskPatch } };
    result: McpTask;
  };
  mcpDeleteTask: {
    args: { workspaceId: string; id: string };
    result: void;
  };
  agentUsage: {
    args: { workspaceId: string };
    result: AgentTokenUsage[];
  };
  mcpAgentStatuses: {
    args: { workspaceId: string };
    result: McpAgentStatus[];
  };
  worktreeStatus: {
    args: { workspaceId: string; terminalId: string };
    result: WorktreeStatus | null;
  };
  worktreeRemove: {
    args: { request: { workspaceId: string; terminalId: string; shouldDeleteBranch: boolean } };
    result: void;
  };
  worktreeDiff: {
    args: { workspaceId: string; terminalId: string };
    result: WorktreeDiff;
  };
  worktreeCommit: {
    args: { request: { workspaceId: string; terminalId: string; message: string } };
    result: WorktreeStatus;
  };
  worktreeMerge: {
    args: { workspaceId: string; terminalId: string };
    result: WorktreeStatus;
  };
  worktreeOpenPr: {
    args: { request: WorktreePullRequest };
    result: string;
  };
  voiceToggleRecording: {
    args: undefined;
    result: void;
  };
  voiceSetLanguage: {
    args: { language: string };
    result: void;
  };
  voiceIsMicAvailable: {
    args: undefined;
    result: boolean;
  };
  voiceListInputDevices: {
    args: undefined;
    result: string[];
  };
  voiceSetInputDevice: {
    args: { device: string | null };
    result: void;
  };
  voiceTestMicStart: {
    args: { device: string | null };
    result: void;
  };
  voiceTestMicStop: {
    args: undefined;
    result: void;
  };
  voiceListModels: {
    args: undefined;
    result: VoiceModelInfo[];
  };
  voiceSetModel: {
    args: { modelId: string };
    result: void;
  };
  voiceDownloadModel: {
    args: { modelId: string };
    result: void;
  };
}

type CommandKey = keyof IpcCommandContract;

const IPC_COMMANDS = {
  listWorkspaces: "list_workspaces",
  storeSavedAt: "store_saved_at",
  exportWorkspaceSnapshot: "export_workspace_snapshot",
  importWorkspaceSnapshot: "import_workspace_snapshot",
  createWorkspace: "create_workspace",
  closeWorkspace: "close_workspace",
  renameWorkspace: "rename_workspace",
  listGroups: "list_groups",
  createGroup: "create_group",
  renameGroup: "rename_group",
  removeGroup: "remove_group",
  suspendGroup: "suspend_group",
  resumeGroup: "resume_group",
  setWorkspaceGroup: "set_workspace_group",
  setTerminalPlacement: "set_terminal_placement",
  setActivePane: "set_active_pane",
  reorderWorkspaceContainers: "reorder_workspace_containers",
  reorderWorkspacePanes: "reorder_workspace_panes",
  moveWorkspacePane: "move_workspace_pane",
  setWorkspaceContainerState: "set_workspace_container_state",
  setWorkspaceLayout: "set_workspace_layout",
  setWorkspaceCollapsed: "set_workspace_collapsed",
  spawnTerminal: "spawn_terminal",
  listShells: "list_available_shells",
  listSystemFonts: "list_system_fonts",
  writeTerminal: "write_terminal",
  resizeTerminal: "resize_terminal",
  killTerminal: "kill_terminal",
  stopTerminal: "stop_terminal",
  terminalBacklog: "terminal_backlog",
  setDurableScrollbackEnabled: "set_durable_scrollback_enabled",
  runningTerminals: "running_terminals",
  terminalRuntimeInfo: "terminal_runtime_info",
  reorderWorkspaces: "reorder_workspaces",
  setTerminalWidth: "set_terminal_width",
  detectAgents: "detect_agents",
  probeDevServers: "probe_dev_servers",
  gitBranch: "git_branch",
  listWorkspaceFiles: "list_workspace_files",
  readWorkspaceFile: "read_workspace_file",
  writeWorkspaceFile: "write_workspace_file",
  gitStatus: "git_status",
  mcpServerInfo: "mcp_server_info",
  agentUsage: "agent_usage",
  mcpSetEnabled: "mcp_set_enabled",
  mcpListTasks: "mcp_list_tasks",
  mcpCreateTask: "mcp_create_task",
  mcpUpdateTask: "mcp_update_task",
  mcpDeleteTask: "mcp_delete_task",
  mcpAgentStatuses: "mcp_agent_statuses",
  worktreeStatus: "worktree_status",
  worktreeRemove: "worktree_remove",
  worktreeDiff: "worktree_diff",
  worktreeCommit: "worktree_commit",
  worktreeMerge: "worktree_merge",
  worktreeOpenPr: "worktree_open_pr",
  voiceToggleRecording: "voice_toggle_recording",
  voiceSetLanguage: "voice_set_language",
  voiceIsMicAvailable: "voice_is_mic_available",
  voiceListInputDevices: "voice_list_input_devices",
  voiceSetInputDevice: "voice_set_input_device",
  voiceTestMicStart: "voice_test_mic_start",
  voiceTestMicStop: "voice_test_mic_stop",
  voiceListModels: "voice_list_models",
  voiceSetModel: "voice_set_model",
  voiceDownloadModel: "voice_download_model",
} as const satisfies { [K in CommandKey]: string };

type CommandArgs<K extends CommandKey> = IpcCommandContract[K]["args"];
type CommandResult<K extends CommandKey> = IpcCommandContract[K]["result"];

function rejectTyped(error: unknown): never {
  throw toIpcError(error);
}

export function invokeCommand<K extends CommandKey>(
  key: K,
  ...args: CommandArgs<K> extends undefined ? [] : [args: CommandArgs<K>]
): Promise<CommandResult<K>> {
  const payload = args[0];
  const command = IPC_COMMANDS[key];

  if (payload === undefined) {
    return invoke<CommandResult<K>>(command).catch(rejectTyped);
  }

  // Tauri's generic IPC payload is structurally a record at runtime. The
  // command contract keeps each argument shape precise for callers while the
  // boundary cast avoids widening every public wrapper to an index signature.
  return invoke<CommandResult<K>>(
    command,
    payload as Record<string, unknown>,
  ).catch(rejectTyped);
}
