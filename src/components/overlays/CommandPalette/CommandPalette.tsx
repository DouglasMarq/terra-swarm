import { useLocale, useT } from "../../../i18n";
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
  Terminal,
  Trash2,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { Command } from "cmdk";
import { useEffect, useMemo, useState } from "react";
import type { AgentInfo, Workspace, WorkspaceGroup } from "../../../types";
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
  const t = useT();
  const locale = useLocale();
  const [query, setQuery] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const commands = useMemo(
    () =>
      buildCommandModel({
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
      }),
    // `locale` re-runs the model so labels follow a language switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [locale, agentLabels, resumeCount, exitedTerminalIds, agents, dockOpen, focusedGroupId, focusedTerminalId, focusedWorkspaceId, groups, hasDetachedTabs, hasRecentlyClosedTabs, recentCommandIds, voiceEnabled, voiceRecording, workspaces],
  );
  const visibleCommands = useMemo(() => filterCommands(commands, query), [commands, query]);
  const visibleGroups = useMemo(
    () => groupCommands(visibleCommands).filter((group) => group.commands.length > 0),
    [visibleCommands],
  );

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
    setStatusMessage(t("palette.unavailable"));
  }

  return (
    <Command.Dialog
      aria-describedby="terra-command-palette-description"
      aria-label={t("palette.title")}
      className={styles.dialog}
      contentClassName={styles.dialogContent}
      label={t("palette.title")}
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
            aria-label={t("palette.searchPlaceholder")}
            autoFocus
            className={styles.input}
            onValueChange={setQuery}
            placeholder={t("palette.searchPlaceholder")}
            value={query}
          />
          <kbd className={styles.escapeKey}>Esc</kbd>
        </div>
        <p className={styles.description} id="terra-command-palette-description">
          {t("palette.hint")}
        </p>
        <Command.List aria-label={t("palette.title")} className={styles.list}>
          {visibleGroups.length === 0 ? (
            <Command.Empty className={styles.empty}>{t("palette.empty")}</Command.Empty>
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
                      {command.confirmation ? <span className={styles.confirmHint}>{t("common.confirm")}</span> : null}
                    </Command.Item>
                  );
                })}
              </Command.Group>
            ))
          )}
        </Command.List>
        <div className={styles.footer}>
          <span><kbd>↑</kbd><kbd>↓</kbd> {t("palette.navigate")}</span>
          <span><kbd>Enter</kbd> {t("palette.run")}</span>
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
