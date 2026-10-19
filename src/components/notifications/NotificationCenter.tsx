import { useMemo, useState } from "react";
import { Bell, CheckCircle2, Info } from "lucide-react";
import type { AgentLabel } from "../../domain/agentLabels";
import type { NotificationItem } from "../../types";
import "./notifications.css";

export interface NotificationCenterProps {
  items: readonly NotificationItem[];
  labels: Readonly<Record<string, AgentLabel | undefined>>;
  workspaceNames: Readonly<Record<string, string | undefined>>;
  muted: boolean;
  onJump: (item: NotificationItem) => void;
  onMarkRead: (terminalId: string) => void;
  onMarkAllRead: () => void;
  onToggleMute: () => void;
  onOpenFleet: () => void;
  now?: number;
}

type Filter = "attention" | "all";

export function relativeTime(ts: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - ts) / 1000));
  if (seconds < 45) return "agora";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return new Date(ts).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
}

/** Latest unread signal per agent: one card per agent that needs you. */
export function attentionItems(items: readonly NotificationItem[]): NotificationItem[] {
  const latest = new Map<string, NotificationItem>();
  for (const item of items) {
    if (item.read || item.system) continue;
    const current = latest.get(item.terminalId);
    if (!current || current.ts < item.ts) latest.set(item.terminalId, item);
  }
  return [...latest.values()].sort((a, b) => b.ts - a.ts);
}

export function NotificationCenter({
  items,
  labels,
  workspaceNames,
  muted,
  onJump,
  onMarkRead,
  onMarkAllRead,
  onToggleMute,
  onOpenFleet,
  now = Date.now(),
}: NotificationCenterProps) {
  const pending = useMemo(() => attentionItems(items), [items]);
  const [filter, setFilter] = useState<Filter>(pending.length > 0 ? "attention" : "all");
  const earlier = useMemo(
    () => [...items].filter((item) => filter === "all" || item.read || item.system).sort((a, b) => b.ts - a.ts).slice(0, 12),
    [filter, items],
  );
  const pendingKeys = new Set(pending.map((item) => item.key));

  return (
    <div className="terra-notifications" role="dialog" aria-label="Notificações">
      <div className="terra-notifications-head">
        <div className="terra-notifications-title">
          <strong>Notificações</strong>
          <button type="button" className="terra-link-button" onClick={onMarkAllRead} disabled={pending.length === 0}>
            Marcar tudo como lido
          </button>
        </div>
        <div className="terra-segmented" role="group" aria-label="Filtro">
          <button type="button" aria-pressed={filter === "attention"} data-active={filter === "attention"} onClick={() => setFilter("attention")}>
            Precisa de você · {pending.length}
          </button>
          <button type="button" aria-pressed={filter === "all"} data-active={filter === "all"} onClick={() => setFilter("all")}>
            Tudo · {items.length}
          </button>
        </div>
      </div>

      <div className="terra-notifications-body">
        {pending.length === 0 && filter === "attention" ? (
          <div className="terra-notifications-empty">
            <CheckCircle2 size={18} aria-hidden="true" />
            <span>Nenhum agente esperando por você.</span>
          </div>
        ) : null}
        {filter === "attention"
          ? pending.map((item) => {
            const label = labels[item.terminalId];
            return (
              <article className="terra-notification-card terra-anim-rise" key={item.key}>
                <span className="terra-dot" data-status="attention" aria-hidden="true" />
                <div className="terra-notification-main">
                  <div className="terra-notification-meta">
                    <b>{label?.primary ?? "Agente"}</b>
                    <span className="terra-tag">{label?.tag ?? "agente"}{workspaceNames[item.workspaceId] ? ` · ${workspaceNames[item.workspaceId]}` : ""}</span>
                    <span className="terra-notification-time">{relativeTime(item.ts, now)}</span>
                  </div>
                  <p>{item.message}</p>
                  <div className="terra-notification-actions">
                    <button type="button" className="terra-button terra-button-attention" onClick={() => onJump(item)}>Ir para o pane</button>
                    <button type="button" className="terra-button" onClick={() => onMarkRead(item.terminalId)}>Marcar como lido</button>
                  </div>
                </div>
              </article>
            );
          })
          : null}

        {earlier.filter((item) => !pendingKeys.has(item.key) || filter === "all").length > 0 ? (
          <>
            <span className="terra-notifications-section">{filter === "all" ? "Recentes" : "Mais cedo · lidas"}</span>
            {earlier
              .filter((item) => filter === "all" || !pendingKeys.has(item.key))
              .map((item) => {
                const label = labels[item.terminalId];
                return (
                  <button type="button" className="terra-notification-row" key={item.key} data-read={item.read} onClick={() => onJump(item)}>
                    {item.system ? <Info size={14} aria-hidden="true" /> : <Bell size={14} aria-hidden="true" />}
                    <span className="terra-notification-row-copy">
                      <span>{item.system ? item.message : <><b>{label?.primary ?? "Agente"}</b> {item.message}</>}</span>
                      <span className="terra-notification-row-meta">
                        {item.system ? "Terra Swarm" : `${label?.tag ?? "agente"}${workspaceNames[item.workspaceId] ? ` · ${workspaceNames[item.workspaceId]}` : ""}`}
                      </span>
                    </span>
                    <span className="terra-notification-time">{relativeTime(item.ts, now)}</span>
                  </button>
                );
              })}
          </>
        ) : null}
      </div>

      <div className="terra-notifications-foot">
        <button type="button" className="terra-link-button" onClick={onOpenFleet}>Ver tudo na Frota →</button>
        <button type="button" className="terra-link-button" aria-pressed={muted} onClick={onToggleMute}>
          {muted ? "Reativar avisos" : "Silenciar 1 h"}
        </button>
      </div>
    </div>
  );
}
