import { Gauge, Power, RotateCcw, SquareArrowOutUpRight } from "lucide-react";
import type { AgentLabel } from "../../domain/agentLabels";
import { CONTEXT_ATTENTION_PERCENT, type AgentRunStatus } from "../../domain/agentStatus";
import { useT } from "../../i18n";
import { formatTokens } from "../../domain/formatTokens";
import type { AgentTokenUsage, NotificationItem } from "../../types";
import { totalTokens, type InspectorActionKind, type InspectorTarget } from "./inspectorModel";
import type { InspectorRuntimeState } from "./inspectorRuntime";
import { relativeTime } from "../notifications/NotificationCenter";
import "./inspector.css";

export type InspectorStatus = AgentRunStatus;

export interface AgentInspectorProps {
  target: InspectorTarget | null;
  label: AgentLabel | null;
  status: InspectorStatus;
  /** Latest unread message from the agent, if any. */
  request: NotificationItem | null;
  /** Most recent signals for this agent, newest first. */
  activity: readonly NotificationItem[];
  runtime: InspectorRuntimeState;
  /** Tokens from the agent's own session log, when its hooks reported one. */
  usage?: AgentTokenUsage | null;
  onAction: (action: InspectorActionKind, target: InspectorTarget) => void;
  now?: number;
}

/**
 * The agent first: what it is doing, how much context is left and what it
 * asked. Container, pane, tab and PTY identifiers wait behind "Technical
 * details".
 */
export function AgentInspector({ target, label, status, request, activity, runtime, usage = null, onAction, now = Date.now() }: AgentInspectorProps) {
  const t = useT();
  if (!target) {
    return (
      <div className="terra-inspector-empty">
        <Gauge size={18} aria-hidden="true" />
        <strong>{t("inspector.emptyTitle")}</strong>
        <span>{t("inspector.emptyBody")}</span>
      </div>
    );
  }

  const context = target.contextUsage;
  const info = runtime.status === "ready" ? runtime.info : null;
  const runtimeText = runtime.status === "loading"
    ? t("inspector.loading")
    : info
      ? info.running ? t("inspector.running") : info.reaped ? t("status.exited") : t("status.idle")
      : t("inspector.unavailable");

  return (
    <div className="terra-inspector terra-stagger">
      <div className="terra-inspector-head">
        <div className="terra-inspector-title">
          <strong>{label?.primary ?? target.displayName}</strong>
          <span>{label?.tag ?? target.profileLabel} · {target.projectName}</span>
        </div>
        <span className="terra-status-chip" data-status={status}>{t(`status.${status}` as const)}</span>
      </div>

      <section className="terra-inspector-block" aria-label={t("inspector.context")}>
        <div className="terra-inspector-row">
          <span>{t("inspector.context")}</span>
          <b>{context === null ? "—" : `${context}%`}</b>
        </div>
        <span className="terra-meter" aria-hidden="true">
          <span className="terra-meter-fill" data-high={(context ?? 0) >= CONTEXT_ATTENTION_PERCENT} style={{ width: `${context ?? 0}%` }} />
        </span>
        <span className="terra-inspector-hint">{t("inspector.contextHint")}</span>
      </section>

      {usage ? (
        <section className="terra-inspector-block" aria-label={t("inspector.tokens")}>
          <div className="terra-inspector-row">
            <span>{t("inspector.tokens")}</span>
            <b>{formatTokens(totalTokens(usage))}</b>
          </div>
          <span className="terra-inspector-hint">
            {t("inspector.tokensDetail", {
              input: formatTokens(usage.input_tokens + usage.cache_write_tokens),
              output: formatTokens(usage.output_tokens),
              cached: formatTokens(usage.cache_read_tokens),
              turns: usage.turns,
            })}
            {usage.model ? ` · ${usage.model}` : ""}
          </span>
        </section>
      ) : null}

      {request ? (
        <section className="terra-inspector-request" aria-label={t("inspector.request")}>
          <span className="terra-inspector-kicker">{t("inspector.request")}</span>
          <p>{request.message}</p>
          <span className="terra-inspector-hint">{relativeTime(request.ts, t, now)}</span>
        </section>
      ) : null}

      <section className="terra-inspector-block" aria-label={t("inspector.activity")}>
        <span className="terra-inspector-kicker">{t("inspector.activity")}</span>
        {activity.length === 0 ? (
          <span className="terra-inspector-hint">{t("inspector.noActivity")}</span>
        ) : (
          <ul className="terra-inspector-activity">
            {activity.map((item) => (
              <li key={item.key}>
                <span className="terra-inspector-time">{relativeTime(item.ts, t, now)}</span>
                <span>{item.message}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="terra-inspector-actions" aria-label={t("inspector.actions")}>
        <button type="button" className="terra-button" onClick={() => onAction("restart", target)}>
          <RotateCcw size={13} aria-hidden="true" />
          {t("pane.menu.restart")}
        </button>
        <button type="button" className="terra-button" onClick={() => onAction(target.detached ? "reattach" : "detach", target)}>
          <SquareArrowOutUpRight size={13} aria-hidden="true" />
          {target.detached ? t("pane.menu.reattach") : t("inspector.detach")}
        </button>
        <button type="button" className="terra-button terra-button-danger terra-inspector-kill" onClick={() => onAction("kill", target)}>
          <Power size={13} aria-hidden="true" />
          {t("pane.confirmKill.confirm")}
        </button>
      </div>

      <details className="terra-inspector-details">
        <summary>{t("inspector.technical")}</summary>
        <dl>
          <div><dt>{t("inspector.runtime")}</dt><dd>{runtimeText}</dd></div>
          <div><dt>{t("inspector.pid")}</dt><dd><code>{info?.pid ?? "—"}</code></dd></div>
          <div><dt>{t("inspector.size")}</dt><dd><code>{info ? `${info.cols} × ${info.rows}` : "—"}</code></dd></div>
          <div><dt>{t("inspector.command")}</dt><dd><code>{target.command}</code></dd></div>
          <div><dt>{t("inspector.directory")}</dt><dd><code>{target.cwd || "—"}</code></dd></div>
          <div><dt>{t("inspector.group")}</dt><dd>{target.groupName ?? "—"}</dd></div>
          <div><dt>{t("inspector.pty")}</dt><dd><code>{target.terminalId}</code></dd></div>
          <div><dt>{t("inspector.pane")}</dt><dd><code>{target.paneId ?? "—"}</code></dd></div>
          <div><dt>{t("inspector.container")}</dt><dd><code>{target.containerId ?? "—"}</code></dd></div>
        </dl>
      </details>
    </div>
  );
}
