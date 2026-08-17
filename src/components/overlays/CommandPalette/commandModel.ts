import type { AgentInfo, TerminalMeta, Workspace, WorkspaceGroup } from "../../../types";

export type CommandGroupId = "recent" | "navigation" | "create" | "agent" | "settings";

export type CommandRoute = "home" | "workbench" | "fleet" | "settings";

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
  onFocusedAgentAction?: (action: FocusedAgentAction, context: FocusedAgentContext) => void;
}

export type CommandIconName =
  | "home"
  | "workbench"
  | "fleet"
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

export const COMMAND_GROUP_ORDER: readonly CommandGroupId[] = [
  "recent",
  "navigation",
  "create",
  "agent",
  "settings",
];

export const COMMAND_GROUP_LABELS: Readonly<Record<CommandGroupId, string>> = {
  recent: "Recentes",
  navigation: "Navegação",
  create: "Criar",
  agent: "Agente focado",
  settings: "Configurações",
};

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .trim();
}

/**
 * Normalize Portuguese input so `configuracoes` also finds `Configurações`.
 * Keeping this function pure makes it usable by the host's quick search too.
 */
export function normalizeCommandQuery(value: string): string {
  return normalizeText(value);
}

function commandSearchText(
  label: string,
  description: string,
  keywords: readonly string[],
): string {
  return normalizeText([label, description, ...keywords].join(" "));
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
  return workspace.name.trim() || workspace.cwd || "Projeto sem nome";
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
  };
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
    resourceLabel: `${context.command} · ${context.workspaceName}`,
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
      id: "navigate:home",
      label: "Ir para Início",
      description: "Abrir o painel inicial do Terra",
      group: "navigation",
      keywords: ["inicio", "início", "dashboard", "home"],
      icon: "home",
      intent: { kind: "navigate", route: "home" },
    }),
    command({
      id: "navigate:workbench",
      label: "Ir para Workbench",
      description: "Abrir o espaço de trabalho e os terminais",
      group: "navigation",
      keywords: ["terminal", "projetos", "workspace", "bancada"],
      icon: "workbench",
      intent: { kind: "navigate", route: "workbench" },
    }),
    command({
      id: "navigate:fleet",
      label: "Abrir frota",
      description: "Ver todos os agentes e seus estados",
      group: "navigation",
      keywords: ["fleet", "frota", "agentes", "status"],
      icon: "fleet",
      intent: { kind: "navigate", route: "fleet" },
    }),
    command({
      id: "navigate:settings",
      label: "Abrir Configurações",
      description: "Preferências, recursos e atalhos do Terra",
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
        label: `Abrir grupo ${groupName}`,
        description: "Navegar para os projetos deste grupo",
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
        label: `Abrir projeto ${name}`,
        description: workspace.cwd || "Abrir container do projeto",
        group: "navigation",
        keywords: [name, workspace.cwd, "projeto", "workspace", "abrir"],
        icon: "folder",
        intent: { kind: "open-workspace", workspaceId: workspace.id },
      }),
    );
    for (const terminal of workspace.terminals) {
      const terminalName = terminalLabel(terminal);
      commands.push(
        command({
          id: `open-terminal:${safeIdPart(workspace.id)}:${safeIdPart(terminal.id)}`,
          label: `Abrir ${terminalName} · ${name}`,
          description: "Focar o terminal deste agente",
          group: "navigation",
          keywords: [terminalName, name, workspace.cwd, "agente", "terminal", "focar"],
          icon: "terminal",
          intent: { kind: "open-terminal", workspaceId: workspace.id, terminalId: terminal.id },
        }),
      );
    }
  }

  commands.push(
    command({
      id: "create:project",
      label: "Novo projeto",
      description: "Adicionar um projeto ao Terra",
      group: "create",
      keywords: ["criar", "projeto", "workspace", "novo"],
      icon: "plus",
      intent: { kind: "create-project", groupId: data.focusedGroupId ?? null },
    }),
    command({
      id: "create:group",
      label: "Novo grupo",
      description: "Organizar projetos em um novo grupo",
      group: "create",
      keywords: ["criar", "grupo", "organizar", "novo"],
      icon: "group",
      intent: { kind: "create-group" },
    }),
    command({
      id: "create:agent",
      label: hasAgentWorkspace ? "Novo agente…" : "Novo agente… (selecione um projeto)",
      description: hasAgentWorkspace
        ? "Escolher um agente disponível para iniciar"
        : "Selecione um projeto antes de iniciar um agente",
      group: "create",
      keywords: ["criar", "agente", "terminal", "novo"],
      icon: "agent",
      disabled: !hasAgentWorkspace,
      intent: { kind: "create-agent", workspaceId: focusedWorkspaceId },
    }),
  );

  for (const group of groups) {
    const groupName = group.name.trim() || group.id;
    commands.push(
      command({
        id: `create:project:${safeIdPart(group.id)}`,
        label: `Novo projeto em ${groupName}`,
        description: "Criar projeto já associado a este grupo",
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
          ? `${agentName} indisponível`
          : hasAgentWorkspace
            ? `Iniciar ${agentName}`
            : `${agentName} — selecione um projeto`,
        description: !agent.available
          ? "Agente não detectado nesta máquina"
          : hasAgentWorkspace
            ? "Iniciar este agente no projeto atual"
            : "Selecione um projeto antes de iniciar um agente",
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
    const contextLabel = `${context.command} · ${context.workspaceName}`;
    commands.push(
      command({
        id: "agent:open-focused",
        label: `Focar ${contextLabel}`,
        description: "Voltar para o agente selecionado",
        group: "agent",
        keywords: ["agente", "focar", "selecionado", context.command, context.workspaceName],
        icon: "terminal",
        intent: { kind: "open-terminal", workspaceId: context.workspaceId, terminalId: context.terminalId },
      }),
      command({
        id: "agent:resume-focused",
        label: `Retomar ${contextLabel}`,
        description: "Retomar a sessão pausada deste agente",
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
        label: `Interromper ${contextLabel}`,
        description: "Enviar interrupção para o processo do agente",
        keywords: ["interromper", "parar", "cancelar", "agente"],
        icon: "stop",
        kind: "interrupt-agent",
        action: "interrupt",
        title: "Interromper agente?",
      },
      {
        id: "agent:restart-focused",
        label: `Reiniciar ${contextLabel}`,
        description: "Parar e iniciar novamente a sessão do agente",
        keywords: ["reiniciar", "restart", "agente"],
        icon: "restart",
        kind: "restart-agent",
        action: "restart",
        title: "Reiniciar agente?",
      },
      {
        id: "agent:stop-focused",
        label: `Encerrar ${contextLabel}`,
        description: "Encerrar o processo e liberar o terminal",
        keywords: ["encerrar", "parar", "stop", "matar", "kill", "agente"],
        icon: "stop",
        kind: "stop-agent",
        action: "stop",
        title: "Encerrar agente?",
      },
      {
        id: "agent:clear-focused",
        label: `Limpar histórico de ${contextLabel}`,
        description: "Apagar o scrollback persistido desta sessão",
        keywords: ["limpar", "histórico", "historico", "scrollback", "agente"],
        icon: "clear",
        kind: "clear-scrollback",
        action: "clear-scrollback",
        title: "Limpar histórico?",
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
            `${candidate.description}. Essa ação exige confirmação.`,
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
      label: data.dockOpen === false ? "Abrir dock lateral" : "Fechar dock lateral",
      description: "Alternar o painel contextual da direita",
      group: "settings",
      keywords: ["dock", "painel", "lateral", "direita", "alternar"],
      icon: "dock",
      intent: { kind: "toggle-dock" },
    }),
    command(
      data.voiceEnabled === false
        ? {
            id: "settings:voice",
            label: "Configurar entrada por voz",
            description: "Abrir Configurações para ativar a captura de voz",
            group: "settings",
            keywords: ["voz", "voice", "microfone", "configurar", "ativar"],
            icon: "voice",
            intent: { kind: "voice-settings" },
          }
        : data.voiceRecording
          ? {
              id: "voice:stop",
              label: "Parar captura de voz",
              description: "Parar a gravação e transcrever o comando atual",
              group: "settings",
              keywords: ["voz", "voice", "microfone", "parar", "gravar", "captura"],
              icon: "voice",
              intent: { kind: "stop-voice" },
            }
          : {
              id: "voice:start",
              label: "Iniciar captura de voz",
              description: "Começar a gravação para ditado ou comando",
              group: "settings",
              keywords: ["voz", "voice", "microfone", "iniciar", "gravar", "captura"],
              icon: "voice",
              intent: { kind: "start-voice" },
            },
    ),
    command({
      id: "settings:export",
      label: "Exportar workspace",
      description: "Salvar um snapshot dos projetos e sessões",
      group: "settings",
      keywords: ["exportar", "backup", "snapshot", "salvar", "workspace"],
      icon: "export",
      intent: { kind: "export-workspace" },
    }),
    command({
      id: "settings:import",
      label: "Importar workspace…",
      description: "Restaurar um snapshot salvo anteriormente",
      group: "settings",
      keywords: ["importar", "restaurar", "snapshot", "backup", "workspace"],
      icon: "import",
      intent: { kind: "import-workspace" },
      confirmation: {
        kind: "import-snapshot",
        commandId: "settings:import",
        title: "Importar workspace?",
        description: "A importação pode substituir o estado atual. Escolha um snapshot e confirme no host.",
        resourceId: "workspace-snapshot",
        resourceLabel: "Workspace atual",
      },
    }),
    command({
      id: "settings:reattach-terminal",
      label: "Reanexar terminal destacado",
      description: "Recolocar o terminal destacado no Workbench",
      group: "settings",
      keywords: ["reanexar", "reattach", "terminal", "destacado", "anexar"],
      icon: "reopen",
      disabled: !data.hasDetachedTabs,
      intent: { kind: "reattach-terminal" },
    }),
    command({
      id: "settings:reopen-tab",
      label: "Reabrir workspace fechado",
      description: "Restaurar a última aba visualmente fechada",
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

export function commandMatches(command: CommandDescriptor, query: string): boolean {
  const normalized = normalizeCommandQuery(query);
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
