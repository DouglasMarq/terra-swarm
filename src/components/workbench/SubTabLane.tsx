import { useT, type Translate } from "../../i18n";
import { useState, type MouseEvent } from "react";
import type { SubTabLaneProps, SubTabLaneTab } from "./types";
import { ConfirmActionDialog } from "../overlays/Dialog";

function tabLabel(entry: SubTabLaneTab, translate: Translate): string {
  const value = entry.tab.title || entry.tab.command || translate("lane.terminal");
  return value.trim().slice(0, 2).toUpperCase() || "··";
}

function tabTitle(entry: SubTabLaneTab, translate: Translate): string {
  return entry.tab.title || entry.tab.command || translate("lane.terminalNamed", { id: entry.tab.id });
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
  const translate = useT();
  const title = tabTitle(entry, translate);

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
        aria-label={translate("lane.focus", { name: title })}
        aria-pressed={entry.active}
        onClick={() => onFocusTab?.(entry.tab.id)}
      >
        <span aria-hidden="true">{tabLabel(entry, translate)}</span>
        <span className="terra-subtab-lane__sr-only">{title}</span>
      </button>
      {onDetachTab ? (
        <button
          type="button"
          className="terra-subtab-lane__close"
          aria-label={translate("lane.detach", { name: title })}
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
          aria-label={translate("lane.kill", { name: title })}
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
  const translate = useT();
  const [pendingKill, setPendingKill] = useState<SubTabLaneTab | null>(null);

  return (
    <>
      <aside className={className ? `terra-subtab-lane ${className}` : "terra-subtab-lane"} aria-label={translate("lane.tabs")}>
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
          aria-label={translate("lane.newTab")}
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
        title={pendingKill ? translate("lane.killTitleNamed", { name: tabTitle(pendingKill, translate) }) : translate("lane.killTitle")}
        description={pendingKill ? translate("lane.killDescNamed", { name: tabTitle(pendingKill, translate) }) : translate("lane.killDesc")}
        confirmLabel={translate("lane.killConfirm")}
        onConfirm={() => {
          const tab = pendingKill;
          if (tab) onKillTab?.(tab.tab.id);
          setPendingKill(null);
        }}
      />
    </>
  );
}
