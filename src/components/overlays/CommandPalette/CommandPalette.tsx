import { useT } from "../../../i18n";
import {
  ArchiveRestore,
  Bot,
  Columns3,
  Download,
  Folder,
  FolderPlus,
  Home,
  LayoutDashboard,
  Mic,
  PanelRight,
  Play,
  Plus,
  RotateCcw,
  Settings2,
  Square,
  SquareKanban,
  Terminal,
  Trash2,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { Command } from "cmdk";
import { useEffect, useState } from "react";
import type { AgentInfo } from "../../../domain/agent.model";
import type { Workspace, WorkspaceGroup } from "../../../domain/workspace.model";
import {
  buildCommandModel,
  executeCommand,
  filterCommands,
  groupCommands,
  type CommandDescriptor,
  type CommandIconName,
  type CommandPaletteCallbacks,
  type CommandPaletteData,
  type CommandConfirmRequest,
} from "./commandModel";
import styles from "./CommandPalette.module.css";

export interface CommandPaletteProps extends Omit<CommandPaletteData, "workspaces" | "groups" | "agents"> {
  open: boolean;
  workspaces: readonly Workspace[];
  groups?: readonly WorkspaceGroup[];
  agents?: readonly AgentInfo[];
  callbacks?: CommandPaletteCallbacks;
  /** Called for destructive actions; the command is not dispatched until the host confirms. */
  onRequestConfirm?: (request: CommandConfirmRequest) => void;
  onOpenChange: (open: boolean) => void;
}

const ICONS: Readonly<Record<CommandIconName, LucideIcon>> = {
  home: Home,
  workbench: LayoutDashboard,
  fleet: Columns3,
  board: SquareKanban,
  settings: Settings2,
  folder: Folder,
  group: FolderPlus,
  terminal: Terminal,
  plus: Plus,
  agent: Bot,
  dock: PanelRight,
  voice: Mic,
  export: Download,
  import: Upload,
  reopen: ArchiveRestore,
  play: Play,
  stop: Square,
  restart: RotateCcw,
  clear: Trash2,
};

const NO_COMMANDS: readonly CommandDescriptor[] = [];

function classes(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function commandKey(command: CommandDescriptor): string {
  return command.id;
}

/** Terra's keyboard-first command surface. Ctrl/Cmd+K ownership remains with the host. */
export function CommandPalette({
  open,
  workspaces,
  groups = [],
  agents = [],
  focusedWorkspaceId = null,
  focusedTerminalId = null,
  focusedGroupId = null,
  recentCommandIds = [],
  hasDetachedTabs = false,
  hasRecentlyClosedTabs = false,
  dockOpen,
  voiceEnabled,
  voiceRecording,
  agentLabels,
  resumeCount,
  exitedTerminalIds,
  callbacks = {},
  onRequestConfirm,
  onOpenChange,
}: CommandPaletteProps) {
  const translate = useT();
  const [query, setQuery] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const commands = open ? buildCommandModel({
    workspaces,
    groups,
    agents,
    focusedWorkspaceId,
    focusedTerminalId,
    focusedGroupId,
    recentCommandIds,
    hasDetachedTabs,
    hasRecentlyClosedTabs,
    dockOpen,
    voiceEnabled,
    voiceRecording,
    agentLabels,
    resumeCount,
    exitedTerminalIds,
  }) : NO_COMMANDS;
  const visibleGroups = groupCommands(filterCommands(commands, query)).filter((group) => group.commands.length > 0);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setStatusMessage("");
    }
  }, [open]);

  function handleSelect(commandId: string) {
    const selected = commands.find((candidate) => commandKey(candidate) === commandId);
    if (!selected) return;
    const result = executeCommand(selected, callbacks);
    if (result.kind === "requestConfirm") {
      onRequestConfirm?.(result.request);
      if (onRequestConfirm) onOpenChange(false);
      return;
    }
    if (result.kind === "executed") {
      onOpenChange(false);
      return;
    }
    setStatusMessage(translate("palette.unavailable"));
  }

  return (
    <Command.Dialog
      aria-describedby="terra-command-palette-description"
      aria-label={translate("palette.title")}
      className={styles.dialog}
      contentClassName={styles.dialogContent}
      label={translate("palette.title")}
      loop
      onOpenChange={onOpenChange}
      open={open}
      overlayClassName={styles.overlay}
      shouldFilter={false}
    >
      <div className={styles.body}>
        <div className={styles.searchRow}>
          <span className={styles.searchGlyph} aria-hidden="true">⌕</span>
          <Command.Input
            aria-label={translate("palette.searchPlaceholder")}
            autoFocus
            className={styles.input}
            onValueChange={setQuery}
            placeholder={translate("palette.searchPlaceholder")}
            value={query}
          />
          <kbd className={styles.escapeKey}>Esc</kbd>
        </div>
        <p className={styles.description} id="terra-command-palette-description">
          {translate("palette.hint")}
        </p>
        <Command.List aria-label={translate("palette.title")} className={styles.list}>
          {visibleGroups.length === 0 ? (
            <Command.Empty className={styles.empty}>{translate("palette.empty")}</Command.Empty>
          ) : (
            visibleGroups.map((group) => (
              <Command.Group className={styles.group} heading={group.label} key={group.id} value={group.id}>
                {group.commands.map((command) => {
                  const Icon = ICONS[command.icon];
                  return (
                    <Command.Item
                      className={classes(styles.item, command.confirmation && styles.destructive)}
                      disabled={command.disabled}
                      key={command.id}
                      keywords={[...command.keywords]}
                      onSelect={() => handleSelect(command.id)}
                      value={command.id}
                    >
                      <Icon aria-hidden="true" className={styles.itemIcon} size={16} strokeWidth={1.7} />
                      <span className={styles.itemCopy}>
                        <span className={styles.itemLabel}>{command.label}</span>
                        <span className={styles.itemDescription}>{command.description}</span>
                      </span>
                      {command.shortcut ? <kbd className={styles.itemShortcut}>{command.shortcut}</kbd> : null}
                      {command.confirmation ? <span className={styles.confirmHint}>{translate("common.confirm")}</span> : null}
                    </Command.Item>
                  );
                })}
              </Command.Group>
            ))
          )}
        </Command.List>
        <div className={styles.footer}>
          <span><kbd>↑</kbd><kbd>↓</kbd> {translate("palette.navigate")}</span>
          <span><kbd>Enter</kbd> {translate("palette.run")}</span>
          <span className={styles.footerStatus} aria-live="polite">{statusMessage}</span>
        </div>
      </div>
    </Command.Dialog>
  );
}

export type {
  CommandConfirmRequest,
  CommandDescriptor,
  CommandGroupId,
  CommandGroups,
  CommandIconName,
  CommandIntent,
  CommandPaletteCallbacks,
  CommandPaletteData,
  CommandRoute,
  CommandRunResult,
  DestructiveActionKind,
  FocusedAgentAction,
  FocusedAgentContext,
} from "./commandModel";
