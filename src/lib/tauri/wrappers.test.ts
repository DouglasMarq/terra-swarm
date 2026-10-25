import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  check: vi.fn(),
  relaunch: vi.fn(),
  getVersion: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
  setBadgeCount: vi.fn(),
  onDragDropEvent: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: tauri.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: tauri.relaunch }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: tauri.getVersion }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: tauri.open, save: tauri.save }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: tauri.isPermissionGranted,
  requestPermission: tauri.requestPermission,
  sendNotification: tauri.sendNotification,
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: tauri.setBadgeCount }) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: tauri.onDragDropEvent }) }));

import type { Update } from "@tauri-apps/plugin-updater";
import { api } from "../../api";
import * as mcp from "./mcp";
import * as preview from "./preview";
import * as pty from "./pty";
import * as system from "./system";
import * as voice from "./voice";
import * as workspace from "./workspace";
import { onFileDrop } from "./fileDrop";
import { appVersion, checkForUpdate, installUpdate } from "./updater";

type InvokeCase = [name: string, call: () => Promise<unknown>, command: string, payload?: Record<string, unknown>];

const placement = { workspaceId: "ws-1", terminalId: "pty-1", paneId: "pane-1", tabId: "tab-1" };
const selection = { workspaceId: "ws-1", containerId: "container-1", paneId: "pane-1" };
const layout = { mode: "grid" as const, columns: 2 };

const workspaceCases: InvokeCase[] = [
  ["listWorkspaces", () => workspace.listWorkspaces(), "list_workspaces"],
  ["listWorkspaceFiles", () => workspace.listWorkspaceFiles("ws-1"), "list_workspace_files", { request: { workspaceId: "ws-1", relativePath: "", limit: 200 } }],
  ["readWorkspaceFile", () => workspace.readWorkspaceFile("ws-1", "a.ts"), "read_workspace_file", { workspaceId: "ws-1", relativePath: "a.ts" }],
  ["exportWorkspaceSnapshot", () => workspace.exportWorkspaceSnapshot("/tmp/out.json"), "export_workspace_snapshot", { path: "/tmp/out.json" }],
  ["importWorkspaceSnapshot", () => workspace.importWorkspaceSnapshot("/tmp/in.json"), "import_workspace_snapshot", { path: "/tmp/in.json" }],
  ["createWorkspace", () => workspace.createWorkspace("terra", "/repo"), "create_workspace", { request: { name: "terra", cwd: "/repo" } }],
  ["closeWorkspace", () => workspace.closeWorkspace("ws-1"), "close_workspace", { id: "ws-1" }],
  ["renameWorkspace", () => workspace.renameWorkspace("ws-1", "swarm"), "rename_workspace", { request: { id: "ws-1", name: "swarm" } }],
  ["listGroups", () => workspace.listGroups(), "list_groups"],
  ["createGroup", () => workspace.createGroup("Frontend"), "create_group", { name: "Frontend" }],
  ["renameGroup", () => workspace.renameGroup("group-1", "Backend"), "rename_group", { request: { id: "group-1", name: "Backend" } }],
  ["removeGroup", () => workspace.removeGroup("group-1"), "remove_group", { id: "group-1" }],
  ["suspendGroup", () => workspace.suspendGroup("group-1"), "suspend_group", { id: "group-1" }],
  ["resumeGroup", () => workspace.resumeGroup("group-1"), "resume_group", { id: "group-1" }],
  ["setWorkspaceGroup", () => workspace.setWorkspaceGroup("ws-1", null), "set_workspace_group", { request: { workspaceId: "ws-1", groupId: null } }],
  ["setTerminalPlacement", () => workspace.setTerminalPlacement(placement), "set_terminal_placement", { request: placement }],
  ["setActivePane", () => workspace.setActivePane(selection), "set_active_pane", { request: selection }],
  ["reorderWorkspaceContainers", () => workspace.reorderWorkspaceContainers("ws-1", ["c-2", "c-1"]), "reorder_workspace_containers", { request: { workspaceId: "ws-1", order: ["c-2", "c-1"] } }],
  ["reorderWorkspacePanes", () => workspace.reorderWorkspacePanes("ws-1", "c-1", ["p-2"]), "reorder_workspace_panes", { request: { workspaceId: "ws-1", containerId: "c-1", order: ["p-2"] } }],
  ["setWorkspaceContainerState", () => workspace.setWorkspaceContainerState("ws-1", "c-1", { isCollapsed: true }), "set_workspace_container_state", { request: { workspaceId: "ws-1", containerId: "c-1", patch: { isCollapsed: true } } }],
  ["setWorkspaceLayout", () => workspace.setWorkspaceLayout("ws-1", layout), "set_workspace_layout", { request: { workspaceId: "ws-1", layout } }],
  ["setWorkspaceCollapsed", () => workspace.setWorkspaceCollapsed("ws-1", true), "set_workspace_collapsed", { request: { workspaceId: "ws-1", isCollapsed: true } }],
  ["reorderWorkspaces", () => workspace.reorderWorkspaces(["ws-2", "ws-1"]), "reorder_workspaces", { order: ["ws-2", "ws-1"] }],
  ["setTerminalWidth", () => workspace.setTerminalWidth("ws-1", "pty-1", 0.5), "set_terminal_width", { request: { wsId: "ws-1", terminalId: "pty-1", width: 0.5 } }],
];

const ptyCases: InvokeCase[] = [
  ["writeTerminal", () => pty.writeTerminal("pty-1", "ls\r"), "write_terminal", { id: "pty-1", data: "ls\r" }],
  ["killTerminal", () => pty.killTerminal("pty-1"), "kill_terminal", { id: "pty-1" }],
  ["stopTerminal", () => pty.stopTerminal("pty-1"), "stop_terminal", { id: "pty-1" }],
  ["terminalBacklog", () => pty.terminalBacklog("pty-1"), "terminal_backlog", { id: "pty-1" }],
  ["setDurableScrollbackEnabled", () => pty.setDurableScrollbackEnabled(true), "set_durable_scrollback_enabled", { isEnabled: true }],
  ["runningTerminals", () => pty.runningTerminals(), "running_terminals"],
  ["terminalRuntimeInfo", () => pty.terminalRuntimeInfo("pty-1"), "terminal_runtime_info", { id: "pty-1" }],
];

const systemCases: InvokeCase[] = [
  ["storeSavedAt", () => system.storeSavedAt(), "store_saved_at"],
  ["listShells", () => system.listShells(), "list_available_shells"],
  ["listSystemFonts", () => system.listSystemFonts(), "list_system_fonts"],
  ["detectAgents", () => system.detectAgents(), "detect_agents"],
  ["gitBranch", () => system.gitBranch("/repo"), "git_branch", { cwd: "/repo" }],
  ["gitStatus", () => system.gitStatus("ws-1"), "git_status", { workspaceId: "ws-1" }],
];

const voiceCases: InvokeCase[] = [
  ["voiceToggleRecording", () => voice.voiceToggleRecording(), "voice_toggle_recording"],
  ["voiceSetLanguage", () => voice.voiceSetLanguage("pt"), "voice_set_language", { language: "pt" }],
  ["voiceIsMicAvailable", () => voice.voiceIsMicAvailable(), "voice_is_mic_available"],
  ["voiceListInputDevices", () => voice.voiceListInputDevices(), "voice_list_input_devices"],
  ["voiceSetInputDevice", () => voice.voiceSetInputDevice("USB Mic"), "voice_set_input_device", { device: "USB Mic" }],
  ["voiceTestMicStart", () => voice.voiceTestMicStart(null), "voice_test_mic_start", { device: null }],
  ["voiceTestMicStop", () => voice.voiceTestMicStop(), "voice_test_mic_stop"],
  ["voiceListModels", () => voice.voiceListModels(), "voice_list_models"],
  ["voiceSetModel", () => voice.voiceSetModel("base"), "voice_set_model", { modelId: "base" }],
  ["voiceDownloadModel", () => voice.voiceDownloadModel("small"), "voice_download_model", { modelId: "small" }],
];

const mcpCases: InvokeCase[] = [
  ["mcpServerInfo", () => mcp.mcpServerInfo(), "mcp_server_info"],
  ["mcpSetEnabled", () => mcp.mcpSetEnabled(false), "mcp_set_enabled", { isEnabled: false }],
  ["mcpListTasks", () => mcp.mcpListTasks("ws-1"), "mcp_list_tasks", { workspaceId: "ws-1" }],
  ["mcpCreateTask without optionals", () => mcp.mcpCreateTask("ws-1", { title: "Ship" }), "mcp_create_task", { request: { workspaceId: "ws-1", title: "Ship", description: null, priority: null, assignee: null } }],
  ["mcpCreateTask with optionals", () => mcp.mcpCreateTask("ws-1", { title: "Ship", description: "now", priority: "high", assignee: "pty-1" }), "mcp_create_task", { request: { workspaceId: "ws-1", title: "Ship", description: "now", priority: "high", assignee: "pty-1" } }],
  ["mcpUpdateTask", () => mcp.mcpUpdateTask("ws-1", "task-1", { status: "done" }), "mcp_update_task", { request: { workspaceId: "ws-1", id: "task-1", patch: { status: "done" } } }],
  ["mcpDeleteTask", () => mcp.mcpDeleteTask("ws-1", "task-1"), "mcp_delete_task", { workspaceId: "ws-1", id: "task-1" }],
  ["mcpAgentStatuses", () => mcp.mcpAgentStatuses("ws-1"), "mcp_agent_statuses", { workspaceId: "ws-1" }],
  ["agentUsage", () => mcp.agentUsage("ws-1"), "agent_usage", { workspaceId: "ws-1" }],
];

const worktreeCases: InvokeCase[] = [
  ["worktreeStatus", () => api.worktreeStatus("ws-1", "pty-1"), "worktree_status", { workspaceId: "ws-1", terminalId: "pty-1" }],
  ["worktreeRemove", () => api.worktreeRemove("ws-1", "pty-1", true), "worktree_remove", { request: { workspaceId: "ws-1", terminalId: "pty-1", shouldDeleteBranch: true } }],
  ["worktreeDiff", () => api.worktreeDiff("ws-1", "pty-1"), "worktree_diff", { workspaceId: "ws-1", terminalId: "pty-1" }],
  ["worktreeCommit", () => api.worktreeCommit("ws-1", "pty-1", "feat: x"), "worktree_commit", { request: { workspaceId: "ws-1", terminalId: "pty-1", message: "feat: x" } }],
  ["worktreeMerge", () => api.worktreeMerge("ws-1", "pty-1"), "worktree_merge", { workspaceId: "ws-1", terminalId: "pty-1" }],
  ["probeDevServers", () => api.probeDevServers([5173]), "probe_dev_servers", { ports: [5173] }],
];

const commandCases = [...workspaceCases, ...ptyCases, ...systemCases, ...voiceCases, ...mcpCases, ...worktreeCases];

describe("IPC command wrappers", () => {
  beforeEach(() => {
    tauri.invoke.mockReset().mockResolvedValue("ok");
  });

  it.each(commandCases)("Given the %s wrapper, when calling it, then it invokes its backend command with its payload", async (...[, call, command, payload]) => {
    await expect(call()).resolves.toBe("ok");

    if (payload === undefined) expect(tauri.invoke).toHaveBeenCalledWith(command);
    else expect(tauri.invoke).toHaveBeenCalledWith(command, payload);
  });
});

type ListenCase = [name: string, subscribe: (handler: (payload: unknown) => void) => Promise<unknown>, eventName: string];

const listenCases: ListenCase[] = [
  ["onWorkspacesChanged", (handler) => workspace.onWorkspacesChanged(() => handler(undefined)), "workspaces-changed"],
  ["onPtyOutput", (handler) => pty.onPtyOutput("pty-1", handler), "pty-output-pty-1"],
  ["onTerminalExit", (handler) => pty.onTerminalExit(handler), "terminal-exit"],
  ["onTerminalNotification", (handler) => pty.onTerminalNotification(handler), "terminal-notification"],
  ["onTerminalContext", (handler) => pty.onTerminalContext(handler), "terminal-context"],
  ["onTerminalTitle", (handler) => pty.onTerminalTitle(handler), "terminal-title"],
  ["onAgentAttention", (handler) => pty.onAgentAttention(handler), "agent-attention"],
  ["onVoiceRecordingStarted", (handler) => voice.onVoiceRecordingStarted(() => handler(undefined)), "voice-recording-started"],
  ["onVoiceRecordingStopped", (handler) => voice.onVoiceRecordingStopped(() => handler(undefined)), "voice-recording-stopped"],
  ["onVoiceRecordingError", (handler) => voice.onVoiceRecordingError(handler), "voice-recording-error"],
  ["onVoiceAudioLevel", (handler) => voice.onVoiceAudioLevel(handler), "voice-audio-level"],
  ["onVoiceTranscriptionStarted", (handler) => voice.onVoiceTranscriptionStarted(() => handler(undefined)), "voice-transcription-started"],
  ["onVoiceTranscriptionComplete", (handler) => voice.onVoiceTranscriptionComplete(handler), "voice-transcription-complete"],
  ["onVoiceTranscriptionError", (handler) => voice.onVoiceTranscriptionError(handler), "voice-transcription-error"],
  ["onVoiceModelDownloadProgress", (handler) => voice.onVoiceModelDownloadProgress(handler), "voice-model-download-progress"],
  ["onVoiceModelDownloadComplete", (handler) => voice.onVoiceModelDownloadComplete(() => handler(undefined)), "voice-model-download-complete"],
  ["onVoiceModelChanged", (handler) => voice.onVoiceModelChanged(handler), "voice-model-changed"],
  ["onVoiceMicChanged", (handler) => voice.onVoiceMicChanged(handler), "voice-mic-changed"],
  ["onMcpTasksChanged", (handler) => mcp.onMcpTasksChanged(handler), "mcp-tasks-changed"],
  ["onMcpAgentStatus", (handler) => mcp.onMcpAgentStatus(handler), "mcp-agent-status"],
  ["onMcpNudge", (handler) => mcp.onMcpNudge(handler), "mcp-nudge"],
  ["onDevServer", (handler) => preview.onDevServer(handler), "terminal-dev-server"],
];

describe("IPC event subscriptions", () => {
  const unlisten = vi.fn();

  beforeEach(() => {
    tauri.listen.mockReset().mockResolvedValue(unlisten);
  });

  it.each(listenCases)("Given the %s subscription, when the backend emits its event, then the handler receives the payload", async (_name, subscribe, eventName) => {
    const handler = vi.fn();

    await expect(subscribe(handler)).resolves.toBe(unlisten);
    const [listenedName, forward] = tauri.listen.mock.calls[0] as [string, (event: { payload: unknown }) => void];
    forward({ payload: "payload" });

    expect(listenedName).toBe(eventName);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("Given a file drop subscription, when the webview reports a drop, then the handler receives the drop payload", async () => {
    tauri.onDragDropEvent.mockResolvedValue(unlisten);
    const handler = vi.fn();

    await expect(onFileDrop(handler)).resolves.toBe(unlisten);
    const forward = tauri.onDragDropEvent.mock.calls[0][0] as (event: { payload: unknown }) => void;
    forward({ payload: { type: "drop", paths: ["/a.png"] } });

    expect(handler).toHaveBeenCalledWith({ type: "drop", paths: ["/a.png"] });
  });
});

describe("dialog wrappers", () => {
  it("Given open and save options, when showing the dialogs, then the plugin receives the options", async () => {
    tauri.open.mockResolvedValue("/repo");
    tauri.save.mockResolvedValue("/tmp/out.json");

    await expect(system.openDialog({ directory: true })).resolves.toBe("/repo");
    await expect(system.saveDialog({ defaultPath: "out.json" })).resolves.toBe("/tmp/out.json");

    expect(tauri.open).toHaveBeenCalledWith({ directory: true });
    expect(tauri.save).toHaveBeenCalledWith({ defaultPath: "out.json" });
  });
});

describe("updater wrappers", () => {
  beforeEach(() => {
    tauri.check.mockReset();
    tauri.getVersion.mockReset().mockResolvedValue("1.0.0");
    tauri.relaunch.mockReset().mockResolvedValue(undefined);
  });

  it("Given the app, when asking its version, then the Tauri version is returned", async () => {
    await expect(appVersion()).resolves.toBe("1.0.0");
  });

  it("Given no update available, when checking, then the result is none", async () => {
    tauri.check.mockResolvedValue(null);

    await expect(checkForUpdate()).resolves.toEqual({ kind: "none" });
  });

  it("Given a newer release, when checking, then the result carries both versions and the update", async () => {
    const update = { version: "1.1.0" };
    tauri.check.mockResolvedValue(update);

    await expect(checkForUpdate()).resolves.toEqual({ kind: "update", version: "1.1.0", current: "1.0.0", update });
  });

  it("Given the update check fails, when checking, then the result is an error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    tauri.check.mockRejectedValue(new Error("offline"));

    await expect(checkForUpdate()).resolves.toEqual({ kind: "error" });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("Given no update, when installing, then nothing is downloaded and the app does not relaunch", async () => {
    await installUpdate(null);

    expect(tauri.relaunch).not.toHaveBeenCalled();
  });

  it("Given an update, when installing, then it is downloaded and the app relaunches", async () => {
    const downloadAndInstall = vi.fn(async () => undefined);
    const update: Pick<Update, "downloadAndInstall"> = { downloadAndInstall };

    // installUpdate only touches downloadAndInstall; the full Update class needs a live plugin resource.
    await installUpdate(update as Update);

    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(tauri.relaunch).toHaveBeenCalledTimes(1);
  });
});

describe("notification wrappers", () => {
  beforeEach(() => {
    vi.resetModules();
    tauri.isPermissionGranted.mockReset();
    tauri.requestPermission.mockReset();
  });

  async function loadNotifications() {
    return import("./notifications");
  }

  it("Given permission already granted, when ensuring it twice, then it resolves true and asks the system once", async () => {
    tauri.isPermissionGranted.mockResolvedValue(true);
    const { ensureNotificationPermission } = await loadNotifications();

    await expect(ensureNotificationPermission()).resolves.toBe(true);
    await expect(ensureNotificationPermission()).resolves.toBe(true);

    expect(tauri.isPermissionGranted).toHaveBeenCalledTimes(1);
    expect(tauri.requestPermission).not.toHaveBeenCalled();
  });

  it("Given permission not yet granted, when the user denies the request, then it resolves false", async () => {
    tauri.isPermissionGranted.mockResolvedValue(false);
    tauri.requestPermission.mockResolvedValue("denied");
    const { ensureNotificationPermission } = await loadNotifications();

    await expect(ensureNotificationPermission()).resolves.toBe(false);
  });

  it("Given permission not yet granted, when the user grants the request, then it resolves true", async () => {
    tauri.isPermissionGranted.mockResolvedValue(false);
    tauri.requestPermission.mockResolvedValue("granted");
    const { ensureNotificationPermission } = await loadNotifications();

    await expect(ensureNotificationPermission()).resolves.toBe(true);
  });

  it("Given the permission check fails, when ensuring permission, then it resolves false", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    tauri.isPermissionGranted.mockRejectedValue(new Error("no bridge"));
    const { ensureNotificationPermission } = await loadNotifications();

    await expect(ensureNotificationPermission()).resolves.toBe(false);
    consoleWarn.mockRestore();
  });

  it("Given a notification and a badge count, when showing them, then the plugin and the window receive them", async () => {
    tauri.setBadgeCount.mockResolvedValue(undefined);
    const { showNotification, setAppBadgeCount } = await loadNotifications();

    showNotification({ title: "Done", body: "Agent finished" });
    await setAppBadgeCount(3);

    expect(tauri.sendNotification).toHaveBeenCalledWith({ title: "Done", body: "Agent finished" });
    expect(tauri.setBadgeCount).toHaveBeenCalledWith(3);
  });
});
