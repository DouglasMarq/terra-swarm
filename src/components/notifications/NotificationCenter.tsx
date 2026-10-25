import { useMemo, useState } from "react";
import { Bell, CheckCircle2, Info } from "lucide-react";
import type { AgentLabel } from "../../domain/agentLabels";
import { elapsedTime } from "../../domain/elapsedTime";
import { latestUnreadPerAgent } from "../../domain/notifications";
import type { NotificationItem } from "../../domain/notification.model";
import { intlLocale, useT, type Translate } from "../../i18n";
import "./notifications.css";

const MAX_EARLIER_NOTIFICATIONS = 12;

export interface NotificationCenterProps {
  items: readonly NotificationItem[];
  labels: Readonly<Record<string, AgentLabel | undefined>>;
  workspaceNames: Readonly<Record<string, string | undefined>>;
  muted: boolean;
  /** Agents whose context window is nearly full (≥ `CONTEXT_ATTENTION_PERCENT`). */
  contextAlerts?: readonly { terminalId: string; workspaceId: string; used: number }[];
  onJump: (item: NotificationItem) => void;
  onFocusAgent?: (terminalId: string) => void;
  onMarkRead: (terminalId: string) => void;
  onMarkAllRead: () => void;
  onToggleMute: () => void;
  onOpenFleet: () => void;
  now?: number;
}

type Filter = "attention" | "all";

export function relativeTime(ts: number, translate: Translate, now = Date.now()): string {
  const elapsed = elapsedTime(ts, now);
  if (elapsed.unit === "now") return translate("time.now");
  if (elapsed.unit === "minutes") return translate("time.minutes", { count: elapsed.count });
  if (elapsed.unit === "hours") return translate("time.hours", { count: elapsed.count });
  return new Date(ts).toLocaleDateString(intlLocale(), { day: "2-digit", month: "short" });
}

export function NotificationCenter({
  items,
  labels,
  workspaceNames,
  muted,
  contextAlerts = [],
  onJump,
  onFocusAgent,
  onMarkRead,
  onMarkAllRead,
  onToggleMute,
  onOpenFleet,
  now = Date.now(),
}: NotificationCenterProps) {
  const translate = useT();
  const pending = useMemo(() => latestUnreadPerAgent(items), [items]);
  const pendingIds = new Set(pending.map((item) => item.terminalId));
  const contextOnly = contextAlerts.filter((alert) => !pendingIds.has(alert.terminalId));
  const attentionCount = pending.length + contextOnly.length;
  const [filter, setFilter] = useState<Filter>(attentionCount > 0 ? "attention" : "all");
  const earlier = useMemo(
    () => [...items].filter((item) => filter === "all" || item.read || item.system).sort((left, right) => right.ts - left.ts).slice(0, MAX_EARLIER_NOTIFICATIONS),
    [filter, items],
  );
  const pendingKeys = new Set(pending.map((item) => item.key));

  return (
    <div className="terra-notifications" role="dialog" aria-label={translate("notifications.title")}>
      <div className="terra-notifications-head">
        <div className="terra-notifications-title">
          <strong>{translate("notifications.title")}</strong>
          <button type="button" className="terra-link-button" onClick={onMarkAllRead} disabled={pending.length === 0}>
            {translate("notifications.markAllRead")}
          </button>
        </div>
        <div className="terra-segmented" role="group" aria-label={translate("notifications.filter")}>
          <button type="button" aria-pressed={filter === "attention"} data-active={filter === "attention"} onClick={() => setFilter("attention")}>
            {translate("notifications.needsYou", { count: attentionCount })}
          </button>
          <button type="button" aria-pressed={filter === "all"} data-active={filter === "all"} onClick={() => setFilter("all")}>
            {translate("notifications.all", { count: items.length + contextOnly.length })}
          </button>
        </div>
      </div>

      <div className="terra-notifications-body">
        {attentionCount === 0 && filter === "attention" ? (
          <div className="terra-notifications-empty">
            <CheckCircle2 size={18} aria-hidden="true" />
            <span>{translate("notifications.empty")}</span>
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
                    <b>{label?.primary ?? translate("common.agentFallback")}</b>
                    <span className="terra-tag">{label?.tag ?? translate("common.agent")}{workspaceNames[item.workspaceId] ? ` · ${workspaceNames[item.workspaceId]}` : ""}</span>
                    <span className="terra-notification-time">{relativeTime(item.ts, translate, now)}</span>
                  </div>
                  <p>{item.message}</p>
                  <div className="terra-notification-actions">
                    <button type="button" className="terra-button terra-button-attention" onClick={() => onJump(item)}>{translate("notifications.goToPane")}</button>
                    <button type="button" className="terra-button" onClick={() => onMarkRead(item.terminalId)}>{translate("notifications.markRead")}</button>
                  </div>
                </div>
              </article>
            );
          })
          : null}
        {filter === "attention"
          ? contextOnly.map((alert) => {
            const label = labels[alert.terminalId];
            return (
              <article className="terra-notification-card terra-anim-rise" key={`ctx-${alert.terminalId}`}>
                <span className="terra-dot" data-status="attention" aria-hidden="true" />
                <div className="terra-notification-main">
                  <div className="terra-notification-meta">
                    <b>{label?.primary ?? translate("common.agentFallback")}</b>
                    <span className="terra-tag">{label?.tag ?? translate("common.agent")}{workspaceNames[alert.workspaceId] ? ` · ${workspaceNames[alert.workspaceId]}` : ""}</span>
                  </div>
                  <p>{translate("fleet.contextHigh", { count: alert.used })}</p>
                  {onFocusAgent ? (
                    <div className="terra-notification-actions">
                      <button type="button" className="terra-button terra-button-attention" onClick={() => onFocusAgent(alert.terminalId)}>{translate("notifications.goToPane")}</button>
                    </div>
                  ) : null}
                </div>
              </article>
            );
          })
          : null}

        {earlier.filter((item) => !pendingKeys.has(item.key) || filter === "all").length > 0 ? (
          <>
            <span className="terra-notifications-section">{filter === "all" ? translate("notifications.recent") : translate("notifications.earlier")}</span>
            {earlier
              .filter((item) => filter === "all" || !pendingKeys.has(item.key))
              .map((item) => {
                const label = labels[item.terminalId];
                return (
                  <button type="button" className="terra-notification-row" key={item.key} data-read={item.read} onClick={() => onJump(item)}>
                    {item.system ? <Info size={14} aria-hidden="true" /> : <Bell size={14} aria-hidden="true" />}
                    <span className="terra-notification-row-copy">
                      <span>{item.system ? item.message : <><b>{label?.primary ?? translate("common.agentFallback")}</b> {item.message}</>}</span>
                      <span className="terra-notification-row-meta">
                        {item.system ? translate("common.appName") : `${label?.tag ?? translate("common.agent")}${workspaceNames[item.workspaceId] ? ` · ${workspaceNames[item.workspaceId]}` : ""}`}
                      </span>
                    </span>
                    <span className="terra-notification-time">{relativeTime(item.ts, translate, now)}</span>
                  </button>
                );
              })}
          </>
        ) : null}
      </div>

      <div className="terra-notifications-foot">
        <button type="button" className="terra-link-button" onClick={onOpenFleet}>{translate("notifications.seeFleet")}</button>
        <button type="button" className="terra-link-button" aria-pressed={muted} onClick={onToggleMute}>
          {muted ? translate("notifications.unmute") : translate("notifications.mute")}
        </button>
      </div>
    </div>
  );
}
