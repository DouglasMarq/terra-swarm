import { describe, expect, it, vi } from "vitest";
import type { AgentInfo } from "../../../domain/agent.model";
import type { Workspace, WorkspaceGroup } from "../../../domain/workspace.model";
import {
  buildCommandModel,
  executeCommand,
  filterCommands,
  groupCommands,
  isDestructiveCommand,
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
    collapsed: false,
    projectIds: ["ws-terra"],
    parentGroupId: null,
    suspended: false,
  },
];

const agents: AgentInfo[] = [
  { id: "codex", label: "Codex", available: true },
  { id: "claude", label: "Claude Code", available: false },
];

describe("command palette model", () => {
  it("normalizes Portuguese accents and whitespace", () => {
    expect(normalizeSearchText("  Configurações  ")).toBe("configuracoes");
    expect(normalizeSearchText("AÇÃO rápida")).toBe("acao rapida");
  });

  it("matches all normalized query tokens across labels and keywords", () => {
    const commands = buildCommandModel({ workspaces, groups, agents });
    const result = filterCommands(commands, "coracao agente");
    expect(result.some((command) => command.id.startsWith("open-terminal:ws-terra:pty-1"))).toBe(true);
    expect(filterCommands(commands, "não existe")).toHaveLength(0);
  });

  it("offers resume only for an agent that has exited", () => {
    const live = buildCommandModel({ workspaces, focusedWorkspaceId: "ws-terra", focusedTerminalId: "pty-1" });
    expect(live.some((item) => item.id === "agent:resume-focused")).toBe(false);
  });

  it("builds navigation, create, agent and settings groups from current state", () => {
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

  it("does not offer agent spawning without a valid workspace target", () => {
    const commands = buildCommandModel({ workspaces, agents });
    const generic = commands.find((command) => command.id === "create:agent");
    const codex = commands.find((command) => command.id === "create-agent:codex");
    const createAgent = vi.fn();

    expect(generic?.label).toBe("Novo agente… (selecione um projeto)");
    expect(generic?.disabled).toBe(true);
    expect(codex?.disabled).toBe(true);
    expect(executeCommand(defined(generic), { onCreateAgent: createAgent }).kind).toBe("unavailable");
    expect(createAgent).not.toHaveBeenCalled();
  });

  it("marks stop/restart/import actions as destructive and returns confirmation", () => {
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

  it("dispatches safe commands through host callbacks", () => {
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

  it("keeps voice preference, start and stop actions semantically separate", () => {
    const settings = vi.fn();
    const start = vi.fn();
    const stop = vi.fn();

    const disabled = buildCommandModel({ workspaces, voiceEnabled: false });
    const settingsCommand = disabled.find((command) => command.id === "settings:voice");
    expect(settingsCommand?.label).toBe("Configurar entrada por voz");
    expect(executeCommand(defined(settingsCommand), { onOpenVoiceSettings: settings }).kind).toBe("executed");
    expect(settings).toHaveBeenCalledOnce();

    const idle = buildCommandModel({ workspaces, voiceEnabled: true, voiceRecording: false });
    const startCommand = idle.find((command) => command.id === "voice:start");
    expect(startCommand?.label).toBe("Iniciar captura de voz");
    expect(executeCommand(defined(startCommand), { onStartVoice: start }).kind).toBe("executed");
    expect(start).toHaveBeenCalledOnce();

    const recording = buildCommandModel({ workspaces, voiceEnabled: true, voiceRecording: true });
    const stopCommand = recording.find((command) => command.id === "voice:stop");
    expect(stopCommand?.label).toBe("Parar captura de voz");
    expect(executeCommand(defined(stopCommand), { onStopVoice: stop }).kind).toBe("executed");
    expect(stop).toHaveBeenCalledOnce();
  });
});
