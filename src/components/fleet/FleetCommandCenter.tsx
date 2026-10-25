import { useMemo, useState } from "react";
import { Mic, Pause, Play, Search } from "lucide-react";
import type { AgentLabel } from "../../domain/agentLabels";
import { CONTEXT_ATTENTION_PERCENT } from "../../domain/agentStatus";
import { useT } from "../../i18n";
import {
  DEFAULT_FLEET_FILTERS,
  deriveFleetModel,
  filterFleetModel,
  FLEET_STATUS_PRIORITY,
  formatFleetRelativeTime,
  type FleetAgentModel,
  type FleetDerivationInput,
  type FleetFilters,
  type FleetStatus,
  type FleetStatusFilter,
} from "./model";
import "./fleet.css";

export type FleetBatchAction = "focus" | "voice" | "resume" | "stop";

export interface FleetCommandCenterProps extends Omit<FleetDerivationInput, "agentLabels"> {
  /** Task title / numbered kind per terminal, see domain/agentLabels. */
  labels?: Readonly<Record<string, AgentLabel | undefined>>;
  /** Latest unread message per terminal, for the "Needs you" cards. */
  attentionMessages?: Readonly<Record<string, string | undefined>>;
  now?: number;
  onFocus?: (terminalId: string, workspaceId?: string) => void;
  onMarkRead?: (terminalId: string) => void;
  onBatchAction?: (action: FleetBatchAction, terminalIds: string[]) => void;
  className?: string;
}

function statusRank(status: FleetStatus): number {
  return FLEET_STATUS_PRIORITY.indexOf(status);
}

/**
 * Triage for the whole fleet: what needs you first, then every agent in one
 * table with batch actions. Replaces the old Home and Events surfaces.
 */
export function FleetCommandCenter({
  labels = {},
  attentionMessages = {},
  now = Date.now(),
  onFocus,
  onMarkRead,
  onBatchAction,
  className,
  ...input
}: FleetCommandCenterProps) {
  const translate = useT();
  const [filters, setFilters] = useState<FleetFilters>(DEFAULT_FLEET_FILTERS);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const agentLabels = useMemo(
    () => Object.fromEntries(Object.entries(labels).map(([id, label]) => [id, label?.primary ?? id])),
    [labels],
  );
  const model = useMemo(() => deriveFleetModel({ ...input, agentLabels }, translate), [agentLabels, input, translate]);
  const visible = useMemo(() => filterFleetModel(model, filters), [filters, model]);
  const rows = useMemo(
    () => [...visible.agents].sort((left, right) => statusRank(left.status) - statusRank(right.status)),
    [visible.agents],
  );
  const needsYou = model.agents.filter((agent) => agent.status === "attention");
  const projectCount = new Set(model.agents.map((agent) => agent.projectId)).size;
  const selectedIds = rows.filter((agent) => selected.has(agent.terminalId)).map((agent) => agent.terminalId);
  const isAllSelected = rows.length > 0 && selectedIds.length === rows.length;

  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const setStatus = (status: FleetStatusFilter) => setFilters((current) => ({ ...current, status: current.status === status ? "all" : status }));
  const runBatch = (action: FleetBatchAction) => {
    if (selectedIds.length === 0) return;
    onBatchAction?.(action, selectedIds);
    if (action !== "voice") setSelected(new Set());
  };

  const label = (agent: FleetAgentModel) => labels[agent.terminalId];

  return (
    <section className={["terra-fleet", className].filter(Boolean).join(" ")} aria-label={translate("common.fleet")}>
      <header className="terra-fleet-head">
        <div className="terra-fleet-title">
          <h1>{translate("common.fleet")}</h1>
          <span>{translate("fleet.summary", { count: model.agents.length, projects: translate("fleet.projectCount", { count: projectCount }) })}</span>
        </div>
        <div className="terra-fleet-chips" role="group" aria-label={translate("fleet.filterByState")}>
          {FLEET_STATUS_PRIORITY.map((status) => (
            <button
              type="button"
              key={status}
              className="terra-fleet-chip"
              aria-pressed={filters.status === status}
              data-active={filters.status === status}
              onClick={() => setStatus(status)}
            >
              <span className="terra-dot" data-status={status} aria-hidden="true" />
              {translate("fleet.statusCount", { status: translate(`status.${status}` as const), count: model.summary[status] })}
            </button>
          ))}
        </div>
      </header>

      {needsYou.length > 0 ? (
        <section className="terra-fleet-section" aria-labelledby="terra-fleet-attention">
          <h2 id="terra-fleet-attention">{translate("fleet.needsYou")}</h2>
          <div className="terra-fleet-cards terra-stagger">
            {needsYou.map((agent) => {
              const message = attentionMessages[agent.terminalId];
              const isContextHigh = (agent.contextUsage ?? 0) >= CONTEXT_ATTENTION_PERCENT;
              return (
                <article className="terra-fleet-card" key={agent.terminalId}>
                  <div className="terra-fleet-card-meta">
                    <span className="terra-dot" data-status="attention" aria-hidden="true" />
                    <b>{label(agent)?.primary ?? agent.label}</b>
                    <span className="terra-tag">{label(agent)?.tag ?? agent.command} · {agent.projectName}</span>
                  </div>
                  <p>{message ?? (isContextHigh ? translate("fleet.contextHigh", { count: agent.contextUsage ?? 0 }) : translate("fleet.waiting"))}</p>
                  <div className="terra-fleet-card-actions">
                    <button type="button" className="terra-button terra-button-attention" onClick={() => onFocus?.(agent.terminalId, agent.workspaceId)}>
                      {translate("fleet.open")}
                    </button>
                    {message && onMarkRead ? (
                      <button type="button" className="terra-button" onClick={() => onMarkRead(agent.terminalId)}>
                        {translate("notifications.markRead")}
                      </button>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className="terra-fleet-section" aria-labelledby="terra-fleet-all">
        <div className="terra-fleet-toolbar">
          <h2 id="terra-fleet-all">{translate("fleet.allAgents")}</h2>
          <label className="terra-fleet-search">
            <Search size={13} aria-hidden="true" />
            <input
              type="search"
              aria-label={translate("fleet.search")}
              placeholder={translate("fleet.searchPlaceholder")}
              value={filters.query}
              onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
            />
          </label>
          {selectedIds.length > 0 ? (
            <div className="terra-fleet-batch" role="toolbar" aria-label={translate("fleet.batch")}>
              <span>{translate("fleet.selected", { count: selectedIds.length })}</span>
              <button type="button" className="terra-button" onClick={() => runBatch("stop")}>
                <Pause size={13} aria-hidden="true" />
                {translate("fleet.pause")}
              </button>
              <button type="button" className="terra-button" onClick={() => runBatch("resume")}>
                <Play size={13} aria-hidden="true" />
                {translate("fleet.resume")}
              </button>
              <button type="button" className="terra-button" onClick={() => runBatch("voice")}>
                <Mic size={13} aria-hidden="true" />
                {translate("fleet.talk")}
              </button>
            </div>
          ) : null}
        </div>

        <div className="terra-fleet-table-wrap">
          {rows.length === 0 ? (
            <div className="terra-fleet-empty">
              <span>{model.agents.length === 0 ? translate("fleet.empty") : translate("fleet.noMatch")}</span>
              {model.agents.length > 0 ? (
                <button type="button" className="terra-link-button" onClick={() => setFilters(DEFAULT_FLEET_FILTERS)}>{translate("fleet.clearFilters")}</button>
              ) : null}
            </div>
          ) : (
            <table className="terra-fleet-table">
              <thead>
                <tr>
                  <th scope="col" className="terra-fleet-check">
                    <input
                      type="checkbox"
                      aria-label={translate("fleet.selectAll")}
                      checked={isAllSelected}
                      onChange={() => setSelected(isAllSelected ? new Set() : new Set(rows.map((agent) => agent.terminalId)))}
                    />
                  </th>
                  <th scope="col">{translate("fleet.col.agent")}</th>
                  <th scope="col">{translate("fleet.col.state")}</th>
                  <th scope="col">{translate("fleet.col.context")}</th>
                  <th scope="col">{translate("fleet.col.activity")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((agent) => {
                  const agentLabel = label(agent);
                  const name = agentLabel?.primary ?? agent.label;
                  return (
                    <tr key={agent.terminalId} data-selected={selected.has(agent.terminalId)} data-status={agent.status}>
                      <td className="terra-fleet-check">
                        <input
                          type="checkbox"
                          aria-label={translate("fleet.select", { name })}
                          checked={selected.has(agent.terminalId)}
                          onChange={() => toggle(agent.terminalId)}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="terra-fleet-agent"
                          aria-label={translate("fleet.focusIn", { name, project: agent.projectName })}
                          onClick={() => onFocus?.(agent.terminalId, agent.workspaceId)}
                        >
                          <b>{name}</b>
                          <span>{agentLabel?.tag ?? agent.command} · {agent.projectName}</span>
                        </button>
                      </td>
                      <td>
                        <span className="terra-fleet-state" data-status={agent.status}>
                          <span className="terra-dot" data-status={agent.status} aria-hidden="true" />
                          {agent.status === "exited" && agent.exitCode !== null && agent.exitCode !== undefined
                            ? translate("fleet.exitedCode", { code: agent.exitCode })
                            : translate(`status.${agent.status}` as const)}
                        </span>
                      </td>
                      <td className="terra-fleet-number" data-high={(agent.contextUsage ?? 0) >= CONTEXT_ATTENTION_PERCENT}>
                        {agent.contextUsage === null ? "—" : `${agent.contextUsage}%`}
                      </td>
                      <td className="terra-fleet-muted">{formatFleetRelativeTime(agent.lastActivity, now, translate) ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </section>
  );
}
