import { t } from "../../../i18n";
import type { AgentInfo } from "../../../domain/agent.model";
import type { TerminalMeta } from "../../../domain/terminal.model";
import type { Workspace, WorkspaceGroup } from "../../../domain/workspace.model";
import { agentLabelText } from "../../../domain/agentLabels";
import { normalizeSearchText } from "../../../lib/text/normalizeSearchText";

export type CommandGroupId = "recent" | "navigation" | "create" | "agent" | "settings";

export type CommandRoute = "workbench" | "fleet" | "board" | "settings";

export type FocusedAgentAction =
  | "resume"
  | "interrupt"
  | "restart"
  | "stop"
  | "clear-scrollback";

export type DestructiveActionKind =
  | "interrupt-agent"
  | "restart-agent"
  | "stop-agent"
  | "clear-scrollback"
  | "import-snapshot";

export interface FocusedAgentContext {
  workspaceId: string;
  workspaceName: string;
  terminalId: string;
  command: string;
  /** Readable agent label ("Animações · claude 2"); falls back to the command. */
  label?: string;
}

export interface CommandConfirmRequest {
  kind: DestructiveActionKind;
  commandId: string;
  title: string;
  description: string;
  resourceId: string;
  resourceLabel: string;
  workspaceId?: string;
  terminalId?: string;
  action?: FocusedAgentAction;
}

export interface CommandPaletteData {
  workspaces: readonly Workspace[];
  groups?: readonly WorkspaceGroup[];
  agents?: readonly AgentInfo[];
  focusedWorkspaceId?: string | null;
  focusedTerminalId?: string | null;
  focusedGroupId?: string | null;
  recentCommandIds?: readonly string[];
  hasDetachedTabs?: boolean;
  hasRecentlyClosedTabs?: boolean;
  dockOpen?: boolean;
  voiceEnabled?: boolean;
  /** True only while the runtime is actively capturing audio. */
  voiceRecording?: boolean;
  /** Task title / numbered kind per terminal id (domain/agentLabels). */
  agentLabels?: Readonly<Record<string, { primary: string; tag: string } | undefined>>;
  /** Saved sessions waiting to be resumed. */
  resumeCount?: number;
  /** Agents whose process has exited; only these can be resumed in place. */
  exitedTerminalIds?: readonly string[];
}

export interface CommandPaletteCallbacks {
  onNavigate?: (route: CommandRoute) => void;
  onOpenWorkspace?: (workspaceId: string) => void;
  onOpenGroup?: (groupId: string) => void;
  onOpenTerminal?: (workspaceId: string, terminalId: string) => void;
  onCreateProject?: (groupId: string | null) => void;
  onCreateGroup?: () => void;
  onCreateAgent?: (workspaceId: string | null, agentId?: string) => void;
  onToggleDock?: () => void;
  onOpenVoiceSettings?: () => void;
  onStartVoice?: () => void;
  onStopVoice?: () => void;
  onExportWorkspace?: () => void;
  /** Import is intentionally not called by executeCommand; use the typed confirmation request. */
  onImportWorkspace?: () => void;
  /** Reattach a detached terminal; distinct from reopening a closed workspace tab. */
  onReattachTerminal?: () => void;
  onReopenTab?: () => void;
  onOpenResume?: () => void;
  /** The prompt library or the team templates. */
  onOpenLibrary?: (dialog: "prompts" | "team") => void;
  onFocusedAgentAction?: (action: FocusedAgentAction, context: FocusedAgentContext) => void;
}

export type CommandIconName =
  | "home"
  | "workbench"
  | "fleet"
  | "board"
  | "settings"
  | "folder"
  | "group"
  | "terminal"
  | "plus"
  | "agent"
  | "dock"
  | "voice"
  | "export"
  | "import"
  | "reopen"
  | "play"
  | "stop"
  | "restart"
  | "clear";

export type CommandIntent =
  | { kind: "navigate"; route: CommandRoute }
  | { kind: "open-workspace"; workspaceId: string }
  | { kind: "open-group"; groupId: string }
  | { kind: "open-terminal"; workspaceId: string; terminalId: string }
  | { kind: "create-project"; groupId: string | null }
  | { kind: "create-group" }
  | { kind: "create-agent"; workspaceId: string | null; agentId?: string }
  | { kind: "toggle-dock" }
  | { kind: "voice-settings" }
  | { kind: "start-voice" }
  | { kind: "stop-voice" }
  | { kind: "export-workspace" }
  | { kind: "import-workspace" }
  | { kind: "reattach-terminal" }
  | { kind: "reopen-tab" }
  | { kind: "open-resume" }
  | { kind: "open-library"; dialog: "prompts" | "team" }
  | { kind: "focused-agent-action"; action: FocusedAgentAction; context: FocusedAgentContext };

export interface CommandDescriptor {
  id: string;
  label: string;
  description: string;
  group: CommandGroupId;
  keywords: readonly string[];
  icon: CommandIconName;
  shortcut?: string;
  disabled?: boolean;
  intent: CommandIntent;
  confirmation?: CommandConfirmRequest;
  /** Search text is exposed for a host that wants to render its own list. */
  searchText: string;
  /** The source command id when this item is mirrored under Recentes. */
  recentOf?: string;
}

export interface CommandGroups {
  id: CommandGroupId;
  label: string;
  commands: CommandDescriptor[];
}

export type CommandRunResult =
  | { kind: "executed"; commandId: string }
  | { kind: "requestConfirm"; commandId: string; request: CommandConfirmRequest }
  | { kind: "unavailable"; commandId: string };

const COMMAND_GROUP_ORDER: readonly CommandGroupId[] = [
  "recent",
  "navigation",
  "create",
  "agent",
  "settings",
];

/** Group headings, translated on read so the palette follows the locale. */
const COMMAND_GROUP_LABELS: Readonly<Record<CommandGroupId, string>> = {
  get recent() { return t("palette.groups.recent"); },
  get navigation() { return t("palette.groups.navigation"); },
  get create() { return t("palette.groups.create"); },
  get agent() { return t("palette.groups.agent"); },
  get settings() { return t("palette.groups.settings"); },
};


function commandSearchText(
  label: string,
  description: string,
  keywords: readonly string[],
): string {
  return normalizeSearchText([label, description, ...keywords].join(" "));
}

function command(
  value: Omit<CommandDescriptor, "searchText">,
): CommandDescriptor {
  return {
    ...value,
    searchText: commandSearchText(value.label, value.description, value.keywords),
  };
}

function workspaceLabel(workspace: Workspace): string {
  return workspace.name.trim() || workspace.cwd || t("palette.unnamedProject");
}

function terminalLabel(terminal: TerminalMeta): string {
  const commandName = terminal.command.trim();
  return commandName || "Terminal";
}

function safeIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function focusedContext(data: CommandPaletteData): FocusedAgentContext | null {
  if (!data.focusedWorkspaceId || !data.focusedTerminalId) return null;
  const workspace = data.workspaces.find((candidate) => candidate.id === data.focusedWorkspaceId);
  const terminal = workspace?.terminals.find((candidate) => candidate.id === data.focusedTerminalId);
  if (!workspace || !terminal) return null;
  return {
    workspaceId: workspace.id,
    workspaceName: workspaceLabel(workspace),
    terminalId: terminal.id,
    command: terminalLabel(terminal),
    label: agentLabelOf(data, terminal.id) ?? undefined,
  };
}

function agentLabelOf(data: CommandPaletteData, terminalId: string): string | null {
  const label = data.agentLabels?.[terminalId];
  return label ? agentLabelText(label) : null;
}

function destructiveRequest(
  commandId: string,
  kind: DestructiveActionKind,
  title: string,
  description: string,
  context: FocusedAgentContext,
  action: FocusedAgentAction,
): CommandConfirmRequest {
  return {
    kind,
    commandId,
    title,
    description,
    resourceId: context.terminalId,
    resourceLabel: `${context.label ?? context.command} · ${context.workspaceName}`,
    workspaceId: context.workspaceId,
    terminalId: context.terminalId,
    action,
  };
}

function withRecentCommands(
  commands: readonly CommandDescriptor[],
  recentCommandIds: readonly string[] | undefined,
): CommandDescriptor[] {
  if (!recentCommandIds?.length) return [];
  const recent = new Set(recentCommandIds);
  return commands
    .filter((candidate) => recent.has(candidate.id) || (candidate.recentOf && recent.has(candidate.recentOf)))
    .map((candidate) =>
      command({
        ...candidate,
        id: `recent:${candidate.id}`,
        group: "recent",
        recentOf: candidate.id,
      }),
    );
}

/** Build the complete, callback-free command model for the current Terra state. */
export function buildCommandModel(data: CommandPaletteData): CommandDescriptor[] {
  const groups = data.groups ?? [];
  const agents = data.agents ?? [];
  // Starting an agent needs a real workspace target. Keep the command visible
  // so the palette explains what is missing, but never dispatch an empty id
  // to the host (which would turn into a failed spawn request).
  const focusedWorkspaceId = data.focusedWorkspaceId && data.workspaces.some(
    (workspace) => workspace.id === data.focusedWorkspaceId,
  )
    ? data.focusedWorkspaceId
    : null;
  const hasAgentWorkspace = focusedWorkspaceId !== null;
  const context = focusedContext(data);
  const commands: CommandDescriptor[] = [
    command({
      id: "navigate:workbench",
      label: t("palette.goWorkbench"),
      description: t("palette.goWorkbenchDesc"),
      group: "navigation",
      keywords: ["terminal", "projetos", "projects", "workspace", "bancada", "workbench"],
      icon: "workbench",
      intent: { kind: "navigate", route: "workbench" },
    }),
    command({
      id: "navigate:fleet",
      label: t("palette.openFleet"),
      description: t("palette.openFleetDesc"),
      group: "navigation",
      keywords: ["fleet", "frota", "agentes", "status"],
      icon: "fleet",
      intent: { kind: "navigate", route: "fleet" },
    }),
    command({
      id: "navigate:board",
      label: t("palette.openBoard"),
      description: t("palette.openBoardDesc"),
      group: "navigation",
      keywords: ["board", "kanban", "quadro", "tarefas", "tasks"],
      icon: "board",
      intent: { kind: "navigate", route: "board" },
    }),
    command({
      id: "navigate:settings",
      label: t("palette.openSettings"),
      description: t("palette.openSettingsDesc"),
      group: "navigation",
      keywords: ["configuracoes", "configurações", "preferencias", "preferências", "settings"],
      icon: "settings",
      intent: { kind: "navigate", route: "settings" },
    }),
  ];

  for (const group of groups) {
    const groupName = group.name.trim() || group.id;
    commands.push(
      command({
        id: `open-group:${safeIdPart(group.id)}`,
        label: t("palette.openGroup", { name: groupName }),
        description: t("palette.openGroupDesc"),
        group: "navigation",
        keywords: [groupName, "grupo", "projeto", "abrir"],
        icon: "group",
        intent: { kind: "open-group", groupId: group.id },
      }),
    );
  }

  for (const workspace of data.workspaces) {
    const name = workspaceLabel(workspace);
    commands.push(
      command({
        id: `open-workspace:${safeIdPart(workspace.id)}`,
        label: t("palette.openProject", { name }),
        description: workspace.cwd || t("palette.openProjectDesc"),
        group: "navigation",
        keywords: [name, workspace.cwd, "projeto", "workspace", "abrir"],
        icon: "folder",
        intent: { kind: "open-workspace", workspaceId: workspace.id },
      }),
    );
    for (const terminal of workspace.terminals) {
      const terminalName = terminalLabel(terminal);
      const agentLabel = data.agentLabels?.[terminal.id];
      const primary = agentLabel?.primary ?? terminalName;
      const tag = agentLabel?.tag ?? terminalName;
      commands.push(
        command({
          id: `open-terminal:${safeIdPart(workspace.id)}:${safeIdPart(terminal.id)}`,
          label: agentLabel ? `${primary} · ${name}` : t("palette.openAgent", { name: terminalName, project: name }),
          description: agentLabel ? t("palette.openAgentDescTagged", { tag }) : t("palette.openAgentDesc"),
          group: "navigation",
          keywords: [terminalName, primary, tag, name, workspace.cwd, "agente", "terminal", "focar"],
          icon: "terminal",
          intent: { kind: "open-terminal", workspaceId: workspace.id, terminalId: terminal.id },
        }),
      );
    }
  }

  commands.push(
    command({
      id: "create:project",
      label: t("palette.newProject"),
      description: t("palette.newProjectDesc"),
      group: "create",
      keywords: ["criar", "projeto", "workspace", "novo"],
      icon: "plus",
      intent: { kind: "create-project", groupId: data.focusedGroupId ?? null },
    }),
    command({
      id: "create:group",
      label: t("palette.newGroup"),
      description: t("palette.newGroupDesc"),
      group: "create",
      keywords: ["criar", "grupo", "organizar", "novo"],
      icon: "group",
      intent: { kind: "create-group" },
    }),
    command({
      id: "create:agent",
      label: hasAgentWorkspace ? t("palette.newAgent") : t("palette.newAgentNoProject"),
      description: hasAgentWorkspace
        ? t("palette.newAgentDesc")
        : t("palette.pickProjectFirst"),
      group: "create",
      keywords: ["criar", "agente", "terminal", "novo"],
      icon: "agent",
      disabled: !hasAgentWorkspace,
      intent: { kind: "create-agent", workspaceId: focusedWorkspaceId },
    }),
    command({
      id: "create:team",
      label: t("palette.startTeam"),
      description: hasAgentWorkspace ? t("palette.startTeamDesc") : t("palette.pickProjectFirst"),
      group: "create",
      keywords: ["time", "team", "orquestrador", "orchestrator", "papéis", "roles", "template"],
      icon: "agent",
      disabled: !hasAgentWorkspace,
      intent: { kind: "open-library", dialog: "team" },
    }),
    command({
      id: "agent:prompts",
      label: t("palette.promptLibrary"),
      description: t("palette.promptLibraryDesc"),
      group: "agent",
      keywords: ["prompt", "biblioteca", "library", "salvos", "snippets", "enviar"],
      icon: "agent",
      intent: { kind: "open-library", dialog: "prompts" },
    }),
  );

  for (const group of groups) {
    const groupName = group.name.trim() || group.id;
    commands.push(
      command({
        id: `create:project:${safeIdPart(group.id)}`,
        label: t("palette.newProjectIn", { name: groupName }),
        description: t("palette.newProjectInDesc"),
        group: "create",
        keywords: ["criar", "projeto", groupName, "grupo"],
        icon: "folder",
        intent: { kind: "create-project", groupId: group.id },
      }),
    );
  }

  for (const agent of agents) {
    const agentName = agent.label.trim() || agent.id;
    const available = agent.available && hasAgentWorkspace;
    commands.push(
      command({
        id: `create-agent:${safeIdPart(agent.id)}`,
        label: !agent.available
          ? t("palette.agentUnavailable", { name: agentName })
          : hasAgentWorkspace
            ? t("palette.startAgent", { name: agentName })
            : t("palette.startAgentNoProject", { name: agentName }),
        description: !agent.available
          ? t("palette.agentUnavailableDesc")
          : hasAgentWorkspace
            ? t("palette.startAgentDesc")
            : t("palette.pickProjectFirst"),
        group: "create",
        keywords: [agentName, agent.id, "agente", "iniciar", "disponível", "disponivel"],
        icon: "agent",
        disabled: !available,
        intent: {
          kind: "create-agent",
          workspaceId: focusedWorkspaceId,
          agentId: agent.id,
        },
      }),
    );
  }

  if (context) {
    const contextLabel = `${context.label ?? context.command} · ${context.workspaceName}`;
    commands.push(
      command({
        id: "agent:open-focused",
        label: t("palette.focus", { name: contextLabel }),
        description: t("palette.focusDesc"),
        group: "agent",
        keywords: ["agente", "focar", "selecionado", context.command, context.workspaceName],
        icon: "terminal",
        intent: { kind: "open-terminal", workspaceId: context.workspaceId, terminalId: context.terminalId },
      }),
    );
    // Resuming spawns into the same id, which the backend refuses while the
    // process is alive, so it is offered only once the agent has exited.
    if (data.exitedTerminalIds?.includes(context.terminalId)) commands.push(
      command({
        id: "agent:resume-focused",
        label: t("palette.resume", { name: contextLabel }),
        description: t("palette.resumeDesc"),
        group: "agent",
        keywords: ["retomar", "resume", "continuar", "agente", context.command],
        icon: "play",
        intent: { kind: "focused-agent-action", action: "resume", context },
      }),
    );

    const destructiveFocusedCommands: readonly {
      id: string;
      label: string;
      description: string;
      keywords: string[];
      icon: CommandIconName;
      kind: DestructiveActionKind;
      action: FocusedAgentAction;
      title: string;
    }[] = [
      {
        id: "agent:interrupt-focused",
        label: t("palette.interrupt", { name: contextLabel }),
        description: t("palette.interruptDesc"),
        keywords: ["interromper", "parar", "cancelar", "agente"],
        icon: "stop",
        kind: "interrupt-agent",
        action: "interrupt",
        title: t("palette.interruptTitle"),
      },
      {
        id: "agent:restart-focused",
        label: t("palette.restart", { name: contextLabel }),
        description: t("palette.restartDesc"),
        keywords: ["reiniciar", "restart", "agente"],
        icon: "restart",
        kind: "restart-agent",
        action: "restart",
        title: t("palette.restartTitle"),
      },
      {
        id: "agent:stop-focused",
        label: t("palette.stop", { name: contextLabel }),
        description: t("palette.stopDesc"),
        keywords: ["encerrar", "parar", "stop", "matar", "kill", "agente"],
        icon: "stop",
        kind: "stop-agent",
        action: "stop",
        title: t("palette.stopTitle"),
      },
      {
        id: "agent:clear-focused",
        label: t("palette.clear", { name: contextLabel }),
        description: t("palette.clearDesc"),
        keywords: ["limpar", "histórico", "historico", "scrollback", "agente"],
        icon: "clear",
        kind: "clear-scrollback",
        action: "clear-scrollback",
        title: t("palette.clearTitle"),
      },
    ];
    for (const candidate of destructiveFocusedCommands) {
      commands.push(
        command({
          id: candidate.id,
          label: candidate.label,
          description: candidate.description,
          group: "agent",
          keywords: candidate.keywords,
          icon: candidate.icon,
          intent: { kind: "focused-agent-action", action: candidate.action, context },
          confirmation: destructiveRequest(
            candidate.id,
            candidate.kind,
            candidate.title,
            t("palette.descriptionNeedsConfirm", { description: candidate.description }),
            context,
            candidate.action,
          ),
        }),
      );
    }
  }

  commands.push(
    command({
      id: "settings:toggle-dock",
      label: data.dockOpen === false ? t("palette.openInspector") : t("palette.closeInspector"),
      description: t("palette.toggleInspectorDesc"),
      group: "settings",
      keywords: ["dock", "painel", "lateral", "direita", "alternar"],
      icon: "dock",
      intent: { kind: "toggle-dock" },
    }),
    command(
      data.voiceEnabled === false
        ? {
            id: "settings:voice",
            label: t("palette.voiceSetup"),
            description: t("palette.voiceSetupDesc"),
            group: "settings",
            keywords: ["voz", "voice", "microfone", "configurar", "ativar"],
            icon: "voice",
            intent: { kind: "voice-settings" },
          }
        : data.voiceRecording
          ? {
              id: "voice:stop",
              label: t("palette.voiceStop"),
              description: t("palette.voiceStopDesc"),
              group: "settings",
              keywords: ["voz", "voice", "microfone", "parar", "gravar", "captura"],
              icon: "voice",
              intent: { kind: "stop-voice" },
            }
          : {
              id: "voice:start",
              label: t("palette.voiceStart"),
              description: t("palette.voiceStartDesc"),
              group: "settings",
              keywords: ["voz", "voice", "microfone", "iniciar", "gravar", "captura"],
              icon: "voice",
              intent: { kind: "start-voice" },
            },
    ),
    command({
      id: "settings:export",
      label: t("palette.export"),
      description: t("palette.exportDesc"),
      group: "settings",
      keywords: ["exportar", "backup", "snapshot", "salvar", "workspace"],
      icon: "export",
      intent: { kind: "export-workspace" },
    }),
    command({
      id: "settings:import",
      label: t("palette.import"),
      description: t("palette.importDesc"),
      group: "settings",
      keywords: ["importar", "restaurar", "snapshot", "backup", "workspace"],
      icon: "import",
      intent: { kind: "import-workspace" },
      confirmation: {
        kind: "import-snapshot",
        commandId: "settings:import",
        title: t("palette.importTitle"),
        description: t("palette.importConfirm"),
        resourceId: "workspace-snapshot",
        resourceLabel: t("palette.currentWorkspace"),
      },
    }),
    command({
      id: "settings:reattach-terminal",
      label: t("palette.reattach"),
      description: t("palette.reattachDesc"),
      group: "settings",
      keywords: ["reanexar", "reattach", "terminal", "destacado", "anexar"],
      icon: "reopen",
      disabled: !data.hasDetachedTabs,
      intent: { kind: "reattach-terminal" },
    }),
    command({
      id: "settings:resume-sessions",
      label: t("palette.resumeSessions"),
      description: t("palette.resumeSessionsDesc", { count: data.resumeCount ?? 0 }),
      group: "settings",
      keywords: ["retomar", "sessões", "resume", "continuar", "abertura"],
      icon: "agent",
      disabled: !data.resumeCount,
      intent: { kind: "open-resume" },
    }),
    command({
      id: "settings:reopen-tab",
      label: t("palette.reopen"),
      description: t("palette.reopenDesc"),
      group: "settings",
      keywords: ["reabrir", "aba", "tab", "workspace", "fechado"],
      icon: "reopen",
      disabled: !data.hasRecentlyClosedTabs,
      intent: { kind: "reopen-tab" },
    }),
  );

  const recent = withRecentCommands(commands, data.recentCommandIds);
  return recent.length > 0 ? [...recent, ...commands] : commands;
}

export function groupCommands(commands: readonly CommandDescriptor[]): CommandGroups[] {
  return COMMAND_GROUP_ORDER.map((id) => ({
    id,
    label: COMMAND_GROUP_LABELS[id],
    commands: commands.filter((candidate) => candidate.group === id),
  }));
}

function commandMatches(command: CommandDescriptor, query: string): boolean {
  const normalized = normalizeSearchText(query);
  if (!normalized) return true;
  return normalized
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => command.searchText.includes(token));
}

export function filterCommands(
  commands: readonly CommandDescriptor[],
  query: string,
): CommandDescriptor[] {
  return commands.filter((candidate) => commandMatches(candidate, query));
}

export function isDestructiveCommand(command: CommandDescriptor): boolean {
  return command.confirmation !== undefined;
}

function unavailable(commandId: string): CommandRunResult {
  return { kind: "unavailable", commandId };
}

/**
 * Dispatch a command through host callbacks. Confirmation-required intents are
 * returned without invoking any side effect, so the host owns the final dialog.
 */
export function executeCommand(
  command: CommandDescriptor,
  callbacks: CommandPaletteCallbacks,
): CommandRunResult {
  if (command.disabled) return unavailable(command.id);
  if (command.confirmation) {
    return { kind: "requestConfirm", commandId: command.id, request: command.confirmation };
  }

  const intent = command.intent;
  switch (intent.kind) {
    case "navigate":
      if (!callbacks.onNavigate) return unavailable(command.id);
      callbacks.onNavigate(intent.route);
      return { kind: "executed", commandId: command.id };
    case "open-workspace":
      if (!callbacks.onOpenWorkspace) return unavailable(command.id);
      callbacks.onOpenWorkspace(intent.workspaceId);
      return { kind: "executed", commandId: command.id };
    case "open-group":
      if (!callbacks.onOpenGroup) return unavailable(command.id);
      callbacks.onOpenGroup(intent.groupId);
      return { kind: "executed", commandId: command.id };
    case "open-terminal":
      if (!callbacks.onOpenTerminal) return unavailable(command.id);
      callbacks.onOpenTerminal(intent.workspaceId, intent.terminalId);
      return { kind: "executed", commandId: command.id };
    case "create-project":
      if (!callbacks.onCreateProject) return unavailable(command.id);
      callbacks.onCreateProject(intent.groupId);
      return { kind: "executed", commandId: command.id };
    case "create-group":
      if (!callbacks.onCreateGroup) return unavailable(command.id);
      callbacks.onCreateGroup();
      return { kind: "executed", commandId: command.id };
    case "create-agent":
      if (!callbacks.onCreateAgent) return unavailable(command.id);
      callbacks.onCreateAgent(intent.workspaceId, intent.agentId);
      return { kind: "executed", commandId: command.id };
    case "toggle-dock":
      if (!callbacks.onToggleDock) return unavailable(command.id);
      callbacks.onToggleDock();
      return { kind: "executed", commandId: command.id };
    case "voice-settings":
      if (!callbacks.onOpenVoiceSettings) return unavailable(command.id);
      callbacks.onOpenVoiceSettings();
      return { kind: "executed", commandId: command.id };
    case "start-voice":
      if (!callbacks.onStartVoice) return unavailable(command.id);
      callbacks.onStartVoice();
      return { kind: "executed", commandId: command.id };
    case "stop-voice":
      if (!callbacks.onStopVoice) return unavailable(command.id);
      callbacks.onStopVoice();
      return { kind: "executed", commandId: command.id };
    case "export-workspace":
      if (!callbacks.onExportWorkspace) return unavailable(command.id);
      callbacks.onExportWorkspace();
      return { kind: "executed", commandId: command.id };
    case "import-workspace":
      if (!callbacks.onImportWorkspace) return unavailable(command.id);
      callbacks.onImportWorkspace();
      return { kind: "executed", commandId: command.id };
    case "reattach-terminal":
      if (!callbacks.onReattachTerminal) return unavailable(command.id);
      callbacks.onReattachTerminal();
      return { kind: "executed", commandId: command.id };
    case "open-library":
      if (!callbacks.onOpenLibrary) return unavailable(command.id);
      callbacks.onOpenLibrary(intent.dialog);
      return { kind: "executed", commandId: command.id };
    case "open-resume":
      if (!callbacks.onOpenResume) return unavailable(command.id);
      callbacks.onOpenResume();
      return { kind: "executed", commandId: command.id };
    case "reopen-tab":
      if (!callbacks.onReopenTab) return unavailable(command.id);
      callbacks.onReopenTab();
      return { kind: "executed", commandId: command.id };
    case "focused-agent-action":
      if (!callbacks.onFocusedAgentAction) return unavailable(command.id);
      callbacks.onFocusedAgentAction(intent.action, intent.context);
      return { kind: "executed", commandId: command.id };
    default:
      return unavailable(command.id);
  }
}
