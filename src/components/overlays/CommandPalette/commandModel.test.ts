import { describe, expect, it, vi } from "vitest";
import type { AgentInfo } from "../../../domain/agent.model";
import type { Workspace, WorkspaceGroup } from "../../../domain/workspace.model";
import {
  buildCommandModel,
  executeCommand,
  filterCommands,
  groupCommands,
  isDestructiveCommand,
  type CommandDescriptor,
  type CommandIntent,
  type CommandPaletteCallbacks,
} from "./commandModel";
import { normalizeSearchText } from "../../../lib/text/normalizeSearchText";
import { defined } from "../../../test/defined";

const workspaces: Workspace[] = [
  {
    id: "ws-terra",
    name: "Projeto Coração",
    cwd: "/tmp/coracao",
    terminals: [
      { id: "pty-1", command: "codex", width: 120 },
      { id: "pty-2", command: "claude", width: 120 },
    ],
  },
];

const groups: WorkspaceGroup[] = [
  {
    id: "grp-core",
    name: "Núcleo",
    isCollapsed: false,
    projectIds: ["ws-terra"],
    parentGroupId: null,
    isSuspended: false,
  },
];

const agents: AgentInfo[] = [
  { id: "codex", label: "Codex", isAvailable: true },
  { id: "claude", label: "Claude Code", isAvailable: false },
];

describe("command palette model", () => {
  it("Given Portuguese accents and extra whitespace, when normalizing a query, then they are folded", () => {
    expect(normalizeSearchText("  Configurações  ")).toBe("configuracoes");
    expect(normalizeSearchText("AÇÃO rápida")).toBe("acao rapida");
  });

  it("Given a multi-word query, when matching, then every normalized token must match across labels and keywords", () => {
    const commands = buildCommandModel({ workspaces, groups, agents });
    const result = filterCommands(commands, "coracao agente");
    expect(result.some((command) => command.id.startsWith("open-terminal:ws-terra:pty-1"))).toBe(true);
    expect(filterCommands(commands, "não existe")).toHaveLength(0);
  });

  it("Given agents, when building commands, then resume is offered only for one that has exited", () => {
    const live = buildCommandModel({ workspaces, focusedWorkspaceId: "ws-terra", focusedTerminalId: "pty-1" });
    expect(live.some((item) => item.id === "agent:resume-focused")).toBe(false);
  });

  it("Given the current state, when building commands, then navigation, create, agent and settings groups are built", () => {
    const commands = buildCommandModel({
      workspaces,
      groups,
      agents,
      focusedWorkspaceId: "ws-terra",
      focusedTerminalId: "pty-1",
      hasDetachedTabs: true,
      recentCommandIds: ["navigate:fleet"],
      exitedTerminalIds: ["pty-1"],
    });
    const grouped = groupCommands(commands);
    expect(grouped.find((group) => group.id === "recent")?.commands.map((item) => item.recentOf)).toContain("navigate:fleet");
    expect(grouped.find((group) => group.id === "navigation")?.commands.some((item) => item.id === "open-workspace:ws-terra")).toBe(true);
    expect(grouped.find((group) => group.id === "create")?.commands.some((item) => item.id === "create-agent:codex")).toBe(true);
    expect(grouped.find((group) => group.id === "agent")?.commands.some((item) => item.id === "agent:resume-focused")).toBe(true);
    expect(grouped.find((group) => group.id === "settings")?.commands.some((item) => item.id === "settings:reopen-tab")).toBe(true);
  });

  it("Given no valid workspace target, when building commands, then agent spawning is not offered", () => {
    const commands = buildCommandModel({ workspaces, agents });
    const generic = commands.find((command) => command.id === "create:agent");
    const codex = commands.find((command) => command.id === "create-agent:codex");
    const createAgent = vi.fn();

    expect(generic?.label).toBe("Novo agente… (selecione um projeto)");
    expect(generic?.isDisabled).toBe(true);
    expect(codex?.isDisabled).toBe(true);
    expect(executeCommand(defined(generic), { onCreateAgent: createAgent }).kind).toBe("unavailable");
    expect(createAgent).not.toHaveBeenCalled();
  });

  it("Given stop, restart and import actions, when executing them, then they are marked destructive and return a confirmation", () => {
    const commands = buildCommandModel({
      workspaces,
      groups,
      agents,
      focusedWorkspaceId: "ws-terra",
      focusedTerminalId: "pty-1",
    });
    const stop = commands.find((command) => command.id === "agent:stop-focused");
    const restart = commands.find((command) => command.id === "agent:restart-focused");
    const importCommand = commands.find((command) => command.id === "settings:import");
    expect(stop && isDestructiveCommand(stop)).toBe(true);
    expect(restart && isDestructiveCommand(restart)).toBe(true);
    expect(importCommand && isDestructiveCommand(importCommand)).toBe(true);

    const action = vi.fn();
    const callbacks: CommandPaletteCallbacks = { onFocusedAgentAction: action };
    const result = executeCommand(defined(stop), callbacks);
    expect(result.kind).toBe("requestConfirm");
    expect(result.kind === "requestConfirm" ? result.request.kind : null).toBe("stop-agent");
    expect(action).not.toHaveBeenCalled();
  });

  it("Given safe commands, when executing them, then they are dispatched through host callbacks", () => {
    const commands = buildCommandModel({ workspaces, groups, agents });
    const navigate = vi.fn();
    const createGroup = vi.fn();
    const openTerminal = vi.fn();
    const callbacks: CommandPaletteCallbacks = {
      onNavigate: navigate,
      onCreateGroup: createGroup,
      onOpenTerminal: openTerminal,
    };
    expect(executeCommand(defined(commands.find((command) => command.id === "navigate:fleet")), callbacks).kind).toBe("executed");
    expect(executeCommand(defined(commands.find((command) => command.id === "create:group")), callbacks).kind).toBe("executed");
    expect(executeCommand(defined(commands.find((command) => command.id === "open-terminal:ws-terra:pty-1")), callbacks).kind).toBe("executed");
    expect(navigate).toHaveBeenCalledWith("fleet");
    expect(createGroup).toHaveBeenCalledOnce();
    expect(openTerminal).toHaveBeenCalledWith("ws-terra", "pty-1");
  });

  it("Given voice commands, when building commands, then the preference, start and stop actions stay separate", () => {
    const settings = vi.fn();
    const start = vi.fn();
    const stop = vi.fn();

    const disabled = buildCommandModel({ workspaces, isVoiceEnabled: false });
    const settingsCommand = disabled.find((command) => command.id === "settings:voice");
    expect(settingsCommand?.label).toBe("Configurar entrada por voz");
    expect(executeCommand(defined(settingsCommand), { onOpenVoiceSettings: settings }).kind).toBe("executed");
    expect(settings).toHaveBeenCalledOnce();

    const idle = buildCommandModel({ workspaces, isVoiceEnabled: true, isVoiceRecording: false });
    const startCommand = idle.find((command) => command.id === "voice:start");
    expect(startCommand?.label).toBe("Iniciar captura de voz");
    expect(executeCommand(defined(startCommand), { onStartVoice: start }).kind).toBe("executed");
    expect(start).toHaveBeenCalledOnce();

    const recording = buildCommandModel({ workspaces, isVoiceEnabled: true, isVoiceRecording: true });
    const stopCommand = recording.find((command) => command.id === "voice:stop");
    expect(stopCommand?.label).toBe("Parar captura de voz");
    expect(executeCommand(defined(stopCommand), { onStopVoice: stop }).kind).toBe("executed");
    expect(stop).toHaveBeenCalledOnce();
  });
});

function everyCommand(): CommandDescriptor[] {
  const base = {
    workspaces,
    groups,
    agents,
    focusedWorkspaceId: "ws-terra",
    focusedTerminalId: "pty-1",
    focusedGroupId: "grp-core",
    hasDetachedTabs: true,
    hasRecentlyClosedTabs: true,
    resumeCount: 2,
    exitedTerminalIds: ["pty-1"],
  };
  return [
    ...buildCommandModel({ ...base, isVoiceEnabled: false }),
    ...buildCommandModel({ ...base, isVoiceEnabled: true, isVoiceRecording: false }),
    ...buildCommandModel({ ...base, isVoiceEnabled: true, isVoiceRecording: true }),
  ];
}

function fullCallbacks(): Required<CommandPaletteCallbacks> {
  return {
    onNavigate: vi.fn(),
    onOpenWorkspace: vi.fn(),
    onOpenGroup: vi.fn(),
    onOpenTerminal: vi.fn(),
    onCreateProject: vi.fn(),
    onCreateGroup: vi.fn(),
    onCreateAgent: vi.fn(),
    onToggleDock: vi.fn(),
    onOpenVoiceSettings: vi.fn(),
    onStartVoice: vi.fn(),
    onStopVoice: vi.fn(),
    onExportWorkspace: vi.fn(),
    onImportWorkspace: vi.fn(),
    onReattachTerminal: vi.fn(),
    onReopenTab: vi.fn(),
    onOpenResume: vi.fn(),
    onOpenLibrary: vi.fn(),
    onFocusedAgentAction: vi.fn(),
  };
}

const SAFE_INTENT_KINDS: readonly CommandIntent["kind"][] = [
  "navigate",
  "open-workspace",
  "open-group",
  "open-terminal",
  "create-project",
  "create-group",
  "create-agent",
  "toggle-dock",
  "voice-settings",
  "start-voice",
  "stop-voice",
  "export-workspace",
  "reattach-terminal",
  "reopen-tab",
  "open-resume",
  "open-library",
  "focused-agent-action",
];

describe("command palette dispatch", () => {
  it("Given every safe command, when the host has its callback, then it runs; when it does not, then it is unavailable", () => {
    const safe = everyCommand().filter((command) => !command.isDisabled && !command.confirmation);
    const kinds = new Set(safe.map((command) => command.intent.kind));
    expect([...kinds].sort()).toEqual([...SAFE_INTENT_KINDS].sort());

    for (const command of safe) {
      expect(executeCommand(command, fullCallbacks())).toEqual({ kind: "executed", commandId: command.id });
      expect(executeCommand(command, {})).toEqual({ kind: "unavailable", commandId: command.id });
    }
  });

  it("Given safe commands, when they run, then each callback receives the command's target", () => {
    const commands = everyCommand();
    const callbacks = fullCallbacks();
    const run = (id: string) => executeCommand(defined(commands.find((command) => command.id === id)), callbacks);

    run("open-workspace:ws-terra");
    run("open-group:grp-core");
    run("create:project");
    run("create:project:grp-core");
    run("create:agent");
    run("create-agent:codex");
    run("create:team");
    run("agent:prompts");
    run("agent:resume-focused");
    run("settings:toggle-dock");
    run("settings:export");
    run("settings:reattach-terminal");
    run("settings:resume-sessions");
    run("settings:reopen-tab");

    expect(callbacks.onOpenWorkspace).toHaveBeenCalledWith("ws-terra");
    expect(callbacks.onOpenGroup).toHaveBeenCalledWith("grp-core");
    expect(callbacks.onCreateProject).toHaveBeenNthCalledWith(1, "grp-core");
    expect(callbacks.onCreateProject).toHaveBeenNthCalledWith(2, "grp-core");
    expect(callbacks.onCreateAgent).toHaveBeenNthCalledWith(1, "ws-terra", undefined);
    expect(callbacks.onCreateAgent).toHaveBeenNthCalledWith(2, "ws-terra", "codex");
    expect(callbacks.onOpenLibrary).toHaveBeenNthCalledWith(1, "team");
    expect(callbacks.onOpenLibrary).toHaveBeenNthCalledWith(2, "prompts");
    expect(callbacks.onFocusedAgentAction).toHaveBeenCalledWith("resume", expect.objectContaining({ workspaceId: "ws-terra", terminalId: "pty-1", command: "codex" }));
    expect(callbacks.onToggleDock).toHaveBeenCalledOnce();
    expect(callbacks.onExportWorkspace).toHaveBeenCalledOnce();
    expect(callbacks.onReattachTerminal).toHaveBeenCalledOnce();
    expect(callbacks.onOpenResume).toHaveBeenCalledOnce();
    expect(callbacks.onReopenTab).toHaveBeenCalledOnce();
  });

  it("Given every destructive command, when executed, then it asks for confirmation instead of running", () => {
    const callbacks = fullCallbacks();
    const destructive = buildCommandModel({
      workspaces,
      focusedWorkspaceId: "ws-terra",
      focusedTerminalId: "pty-2",
      agentLabels: { "pty-2": { primary: "Vega", tag: "claude 1" } },
    }).filter(isDestructiveCommand);

    expect(destructive.map((command) => command.confirmation?.kind)).toEqual([
      "interrupt-agent",
      "restart-agent",
      "stop-agent",
      "clear-scrollback",
      "import-snapshot",
    ]);
    for (const command of destructive) {
      expect(executeCommand(command, callbacks)).toEqual({ kind: "requestConfirm", commandId: command.id, request: command.confirmation });
    }
    expect(destructive[0].confirmation?.resourceLabel).toMatch(/^Vega/);
    expect(callbacks.onFocusedAgentAction).not.toHaveBeenCalled();
    expect(callbacks.onImportWorkspace).not.toHaveBeenCalled();
  });

  it("Given nothing to restore and no saved sessions, when building commands, then those commands are disabled", () => {
    const commands = buildCommandModel({ workspaces, recentCommandIds: [] });

    for (const id of ["settings:reattach-terminal", "settings:resume-sessions", "settings:reopen-tab"]) {
      const command = defined(commands.find((candidate) => candidate.id === id));
      expect(command.isDisabled).toBe(true);
      expect(executeCommand(command, fullCallbacks()).kind).toBe("unavailable");
    }
    expect(commands.some((command) => command.group === "recent")).toBe(false);
  });
});

describe("command palette labels", () => {
  it("Given unnamed projects, groups and terminals, when building commands, then they fall back to readable labels", () => {
    const commands = buildCommandModel({
      workspaces: [
        { id: "ws/a", name: "  ", cwd: "/srv/app", terminals: [{ id: "pty:1", command: "  ", width: 80 }] },
        { id: "ws-b", name: "", cwd: "", terminals: [] },
      ],
      groups: [{ id: "grp-x", name: " ", isCollapsed: false, projectIds: [], parentGroupId: null, isSuspended: false }],
      agents: [{ id: "kimi", label: " ", isAvailable: true }],
      focusedWorkspaceId: "ws-missing",
      focusedTerminalId: "pty:1",
      isDockOpen: false,
    });
    const labelOf = (id: string) => commands.find((command) => command.id === id)?.label;

    expect(labelOf("open-workspace:ws-a")).toContain("/srv/app");
    expect(labelOf("open-workspace:ws-b")).toContain("Projeto sem nome");
    expect(labelOf("open-terminal:ws-a:pty-1")).toContain("Terminal");
    expect(labelOf("open-group:grp-x")).toContain("grp-x");
    expect(labelOf("create-agent:kimi")).toContain("kimi");
    expect(labelOf("settings:toggle-dock")).toBe("Mostrar o inspetor");
    expect(commands.some((command) => command.id === "agent:open-focused")).toBe(false);
  });

  it("Given a labelled agent and a focused terminal that no longer exists, when building commands, then the label is used and no focused actions appear", () => {
    const labelled = buildCommandModel({
      workspaces,
      agentLabels: { "pty-1": { primary: "Vega", tag: "codex 1" } },
      focusedWorkspaceId: "ws-terra",
      focusedTerminalId: "pty-gone",
    });

    const terminal = defined(labelled.find((command) => command.id === "open-terminal:ws-terra:pty-1"));
    expect(terminal.label).toBe("Vega · Projeto Coração");
    expect(terminal.description).toContain("codex 1");
    expect(labelled.some((command) => command.group === "agent" && command.id.endsWith("-focused"))).toBe(false);
  });

  it("Given a recent command, when building commands, then its copy is listed under recent and runs the original intent", () => {
    const commands = buildCommandModel({ workspaces, recentCommandIds: ["navigate:board", "recent:navigate:fleet"] });
    const recent = commands.filter((command) => command.group === "recent");
    const onNavigate = vi.fn();

    expect(recent.map((command) => command.recentOf)).toEqual(["navigate:board"]);
    expect(executeCommand(recent[0], { onNavigate }).kind).toBe("executed");
    expect(onNavigate).toHaveBeenCalledWith("board");
  });
});
