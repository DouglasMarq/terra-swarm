import type { ReactNode } from "react";
import type { WorkbenchTabRenderContext } from "../workbench/types";
import { TerminalPane } from "../TerminalPane";

export interface TerminalTabSurfaceProps {
  context: WorkbenchTabRenderContext;
  fontSize: number;
  focusedId: string | null;
  expandedId: string | null;
  exited: Readonly<Record<string, number | null>>;
  notifications: Readonly<Record<string, number>>;
  contextUsage: Readonly<Record<string, number>>;
  titles: Readonly<Record<string, string>>;
  branch?: string;
  detachedIds?: ReadonlySet<string>;
  onClearNotifications: (id: string) => void;
  onFocus: (id: string) => void;
  onToggleExpand: (id: string | null) => void;
  onRestart: (id: string, command: string) => void;
  onDetach?: (id: string) => void;
  onKill: (id: string) => void;
}

/**
 * Adapter between the normalized workbench tab contract and the existing
 * xterm/PTY lifecycle. It deliberately never calls a backend command during
 * unmount: removing a visual tab is not the same operation as killing a PTY.
 */
export function TerminalTabSurface({
  context,
  fontSize,
  focusedId,
  expandedId,
  exited,
  notifications,
  contextUsage,
  titles,
  branch,
  detachedIds,
  onClearNotifications,
  onFocus,
  onToggleExpand,
  onRestart,
  onDetach,
  onKill,
}: TerminalTabSurfaceProps): ReactNode {
  const { tab } = context;
  const ptyId = tab.ptyId;
  if (!ptyId) {
    return (
      <div className="terra-orphan-tab" role="status">
        <strong>Tab órfã</strong>
        <span>{tab.title || tab.command || "Sessão sem PTY"}</span>
      </div>
    );
  }

  const hidden = context.hidden || detachedIds?.has(ptyId) === true;
  return (
    <TerminalPane
      id={ptyId}
      command={tab.command}
      fontSize={fontSize}
      exited={ptyId in exited}
      expanded={expandedId === ptyId}
      basis={100}
      height="100%"
      entering={false}
      dragOver={false}
      notifications={notifications[ptyId] ?? 0}
      contextUsed={contextUsage[ptyId]}
      title={titles[ptyId] || tab.title}
      branch={branch}
      onClearNotifications={() => onClearNotifications(ptyId)}
      focused={focusedId === ptyId}
      onFocus={() => onFocus(ptyId)}
      onToggleExpand={() => onToggleExpand(expandedId === ptyId ? null : ptyId)}
      onRestart={() => onRestart(ptyId, tab.command)}
      onClose={() => onKill(ptyId)}
      onDetach={onDetach ? () => onDetach(ptyId) : undefined}
      onKill={() => onKill(ptyId)}
      hidden={hidden}
    />
  );
}
