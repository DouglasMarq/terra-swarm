import { useState, type MouseEvent } from "react";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { CSSProperties } from "react";
import type { SubTabLaneProps, SubTabLaneTab } from "./types";
import { ConfirmActionDialog } from "../overlays/Dialog";

export const SUBTAB_DND_PREFIX = "terra-subtab:";

export function subTabDndId(tabId: string): string {
  return `${SUBTAB_DND_PREFIX}${tabId}`;
}

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

function SortableSubTab({
  entry,
  containerId,
  paneId,
  onFocusTab,
  onDetachTab,
  onRequestKill,
}: {
  entry: SubTabLaneTab;
  containerId?: string;
  paneId?: string;
  onFocusTab?: (tabId: string) => void;
  onDetachTab?: (tabId: string) => void;
  onRequestKill?: (entry: SubTabLaneTab) => void;
}) {
  const title = tabTitle(entry);
  const sortable = useSortable({
    id: subTabDndId(entry.tab.id),
    data: {
      type: "tab",
      tabId: entry.tab.id,
      containerId,
      paneId,
    },
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };

  return (
    <div
      ref={sortable.setNodeRef}
      className="terra-subtab-lane__tab"
      style={style}
      data-active={entry.active}
      data-status={entry.status ?? "idle"}
      data-unread={entry.unread === true}
      data-dragging={sortable.isDragging}
      data-tab-dnd-id={subTabDndId(entry.tab.id)}
      role="group"
      title={title}
    >
      <button
        ref={sortable.setActivatorNodeRef}
        type="button"
        className="terra-subtab-lane__tab-button"
        {...sortable.attributes}
        {...sortable.listeners}
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
  containerId,
  paneId,
  className,
}: SubTabLaneProps) {
  const [pendingKill, setPendingKill] = useState<SubTabLaneTab | null>(null);

  return (
    <>
      <aside className={className ? `terra-subtab-lane ${className}` : "terra-subtab-lane"} aria-label="Abas do painel">
      <SortableContext
        items={tabs.map((entry) => subTabDndId(entry.tab.id))}
        strategy={verticalListSortingStrategy}
      >
        {tabs.map((entry) => (
          <SortableSubTab
            key={entry.tab.id}
            entry={entry}
            containerId={containerId}
            paneId={paneId}
            onFocusTab={onFocusTab}
            onDetachTab={onDetachTab}
            onRequestKill={onKillTab ? setPendingKill : undefined}
          />
        ))}
      </SortableContext>
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
