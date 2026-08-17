import { Activity, Bell, CheckCircle2, CircleAlert, TerminalSquare } from "lucide-react";
import type { NotificationItem } from "../../types";

export interface EventsSurfaceProps {
  items: readonly NotificationItem[];
  onFocus?: (item: NotificationItem) => void;
  onMarkAllRead?: () => void;
  onClearAll?: () => void;
}

function eventIcon(item: NotificationItem) {
  if (item.system) return item.update ? <CheckCircle2 size={14} /> : <Activity size={14} />;
  return item.read ? <TerminalSquare size={14} /> : <CircleAlert size={14} />;
}

export function EventsSurface({
  items,
  onFocus,
  onMarkAllRead,
  onClearAll,
}: EventsSurfaceProps) {
  const unread = items.filter((item) => !item.read).length;
  return (
    <section className="terra-events-surface" aria-label="Eventos da orquestração">
      <header className="terra-surface-heading">
        <div>
          <p className="terra-surface-kicker">Terra / Sinais</p>
          <h1>Eventos</h1>
          <p>Uma linha do tempo das sessões, agentes e handoffs.</p>
        </div>
        <div className="terra-surface-actions">
          <span className="terra-surface-count" aria-live="polite" aria-atomic="true">
            <Bell aria-hidden="true" size={13} /> {unread} não lidos
          </span>
          <button type="button" onClick={onMarkAllRead} disabled={unread === 0 || !onMarkAllRead}>Marcar lidos</button>
          <button type="button" onClick={onClearAll} disabled={items.length === 0 || !onClearAll}>Limpar</button>
        </div>
      </header>
      {items.length === 0 ? (
        <div className="terra-events-empty">
          <Activity aria-hidden="true" size={22} />
          <strong>Nenhum evento ainda</strong>
          <span>Quando um agente emitir um sinal, ele aparecerá aqui.</span>
        </div>
      ) : (
        <div className="terra-events-list">
          {items.map((item) => (
            <button
              className="terra-event-row"
              data-read={item.read}
              disabled={!onFocus}
              key={item.key}
              type="button"
              onClick={() => onFocus?.(item)}
            >
              <span className="terra-event-icon" aria-hidden="true">{eventIcon(item)}</span>
              <span className="terra-event-copy">
                <strong>{item.message}</strong>
                <span>{item.system ? "Terra" : item.workspaceId} · {new Date(item.ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</span>
              </span>
              {!item.read && <span className="terra-event-dot" role="img" aria-label="Não lido" />}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
