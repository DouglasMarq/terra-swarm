import { useState, type MouseEvent } from "react";
import type { SubTabLaneProps, SubTabLaneTab } from "./types";
import { ConfirmActionDialog } from "../overlays/Dialog";

function tabLabel(entry: SubTabLaneTab): string {
  const value = entry.tab.title || entry.tab.command || "Terminal";
  return value.trim().slice(0, 2).toUpperCase() || "··";
}

function tabTitle(entry: SubTabLaneTab): string {
  return entry.tab.title || entry.tab.command || `Terminal ${entry.tab.id}`;
}

function stop(event: MouseEvent<HTMLButtonElement>): void {
  event.stopPropagation();
}

function SubTab({
  entry,
  onFocusTab,
  onDetachTab,
  onRequestKill,
}: {
  entry: SubTabLaneTab;
  onFocusTab?: (tabId: string) => void;
  onDetachTab?: (tabId: string) => void;
  onRequestKill?: (entry: SubTabLaneTab) => void;
}) {
  const title = tabTitle(entry);

  return (
    <div
      className="terra-subtab-lane__tab"
      data-active={entry.active}
      data-status={entry.status ?? "idle"}
      data-unread={entry.unread === true}
      role="group"
      title={title}
    >
      <button
        type="button"
        className="terra-subtab-lane__tab-button"
        aria-label={`Focar ${title}`}
        aria-pressed={entry.active}
        onClick={() => onFocusTab?.(entry.tab.id)}
      >
        <span aria-hidden="true">{tabLabel(entry)}</span>
        <span className="terra-subtab-lane__sr-only">{title}</span>
      </button>
      {onDetachTab ? (
        <button
          type="button"
          className="terra-subtab-lane__close"
          aria-label={`Desanexar ${title}`}
          onClick={(event) => {
            stop(event);
            onDetachTab(entry.tab.id);
          }}
        >
          ×
        </button>
      ) : null}
      {onRequestKill ? (
        <button
          type="button"
          className="terra-subtab-lane__kill"
          aria-label={`Encerrar ${title}`}
          onClick={(event) => {
            stop(event);
            onRequestKill(entry);
          }}
        >
          ■
        </button>
      ) : null}
    </div>
  );
}

export function SubTabLane({
  tabs,
  onFocusTab,
  onNewTab,
  onDetachTab,
  onKillTab,
  className,
}: SubTabLaneProps) {
  const [pendingKill, setPendingKill] = useState<SubTabLaneTab | null>(null);

  return (
    <>
      <aside className={className ? `terra-subtab-lane ${className}` : "terra-subtab-lane"} aria-label="Abas do painel">
        {tabs.map((entry) => (
          <SubTab
            key={entry.tab.id}
            entry={entry}
            onFocusTab={onFocusTab}
            onDetachTab={onDetachTab}
            onRequestKill={onKillTab ? setPendingKill : undefined}
          />
        ))}
      {onNewTab ? (
        <button
          type="button"
          className="terra-subtab-lane__new"
          aria-label="Criar nova aba"
          onClick={onNewTab}
        >
          +
        </button>
      ) : null}
      </aside>
      <ConfirmActionDialog
        open={pendingKill !== null}
        onOpenChange={(open) => {
          if (!open) setPendingKill(null);
        }}
        title={pendingKill ? `Encerrar ${tabTitle(pendingKill)}?` : "Encerrar terminal?"}
        description={pendingKill ? `O processo do terminal “${tabTitle(pendingKill)}” será encerrado. Esta ação não pode ser desfeita.` : "O processo do terminal será encerrado."}
        confirmLabel="Encerrar terminal"
        onConfirm={() => {
          const tab = pendingKill;
          if (tab) onKillTab?.(tab.tab.id);
          setPendingKill(null);
        }}
      />
    </>
  );
}
