import { useEffect, useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Bell,
  CheckCircle2,
  CircleDot,
  Clock3,
  Eye,
  FolderGit2,
  GitBranch,
  LayoutGrid,
  List,
  Mic,
  Pause,
  Play,
  SearchX,
  Square,
  X,
  Zap,
} from "lucide-react";

import { Badge, Button, IconButton, SearchField, StatusDot } from "../ui";
import { ConfirmActionDialog } from "../overlays/Dialog";
import {
  DEFAULT_FLEET_FILTERS,
  deriveFleetModel,
  filterFleetModel,
  formatFleetDuration,
  formatFleetRelativeTime,
  type FleetAgentModel,
  type FleetDerivationInput,
  type FleetFilters,
  type FleetModel,
  type FleetStatus,
  type FleetStatusFilter,
  type FleetSummary,
  type FleetViewMode,
} from "./model";
import styles from "./FleetCommandCenter.module.css";

/**
 * Actions that are safe to dispatch from the fleet board.
 *
 * A terminal does not have a fleet-level suspend lifecycle.  Keeping that
 * action out of this union prevents a visual affordance from accidentally
 * being wired to Stop (or to an invented PTY operation).
 */
export type FleetBatchAction = "focus" | "voice" | "resume" | "stop";

export interface FleetCommandCenterProps extends FleetDerivationInput {
  /** Timestamp used to render optional last-activity telemetry deterministically. */
  now?: number;
  onFocus?: (terminalId: string, workspaceId?: string) => void;
  onVoice?: (terminalId?: string) => void;
  onResume?: (terminalId: string) => void;
  onStop?: (terminalId: string) => void;
  onSuspendGroup?: (groupId: string) => void;
  onResumeGroup?: (groupId: string) => void;
  onBatchAction?: (action: FleetBatchAction, terminalIds: string[]) => void;
  /** Alias kept for hosts that call this callback simply `onBatch`. */
  onBatch?: (action: FleetBatchAction, terminalIds: string[]) => void;
  viewMode?: FleetViewMode;
  onViewModeChange?: (mode: FleetViewMode) => void;
  className?: string;
}

interface StatusMeta {
  label: string;
  tone: "neutral" | "running" | "attention" | "error";
  dot: "running" | "attention" | "error" | "offline";
  icon: LucideIcon;
}

const STATUS_META: Record<FleetStatus, StatusMeta> = {
  working: { label: "Working", tone: "running", dot: "running", icon: Activity },
  attention: { label: "Attention", tone: "attention", dot: "attention", icon: Bell },
  suspended: { label: "Suspended", tone: "neutral", dot: "offline", icon: Pause },
  exited: { label: "Exited", tone: "error", dot: "error", icon: CheckCircle2 },
};

const SUMMARY_ITEMS: readonly { status: FleetStatus; label: string; icon: LucideIcon }[] = [
  { status: "working", label: "Working", icon: Activity },
  { status: "attention", label: "Attention", icon: Bell },
  { status: "suspended", label: "Suspended", icon: Pause },
  { status: "exited", label: "Exited", icon: CheckCircle2 },
];

function statusMeta(status: FleetStatus): StatusMeta {
  return STATUS_META[status];
}

function summaryCount(summary: FleetSummary, status: FleetStatus): number {
  return summary[status];
}

function actionLabel(action: FleetBatchAction): string {
  switch (action) {
    case "focus":
      return "Focus";
    case "voice":
      return "Voice";
    case "resume":
      return "Resume";
    case "stop":
      return "Stop (preserve session)";
  }
}

type PendingFleetConfirmation =
  | { kind: "stop"; terminalIds: string[]; label: string; batch: boolean }
  | { kind: "suspend-group"; groupId: string; label: string };

function setFilter<K extends keyof FleetFilters>(
  setFilters: React.Dispatch<React.SetStateAction<FleetFilters>>,
  key: K,
  value: FleetFilters[K],
): void {
  setFilters((current) => ({ ...current, [key]: value }));
}

function StatusBadge({ status }: { status: FleetStatus }) {
  const meta = statusMeta(status);
  return (
    <Badge indicator={meta.dot} size="sm" tone={meta.tone} shape="pill">
      {meta.label}
    </Badge>
  );
}

export interface BatchActionBarProps {
  selectedCount: number;
  canFocus?: boolean;
  canVoice?: boolean;
  canResume?: boolean;
  canStop?: boolean;
  onAction: (action: FleetBatchAction) => void;
  onClear: () => void;
}

export function BatchActionBar({
  selectedCount,
  canFocus = true,
  canVoice = true,
  canResume = true,
  canStop = true,
  onAction,
  onClear,
}: BatchActionBarProps) {
  if (selectedCount === 0) return null;
  return (
    <div className={styles.batchBar} role="toolbar" aria-label="Batch actions">
      <span className={styles.batchLabel}>
        <CircleDot aria-hidden="true" size={14} />
        {selectedCount} <span>{selectedCount === 1 ? "agent selected" : "agents selected"}</span>
      </span>
      <div className={styles.batchActions}>
        <Button disabled={!canFocus} leadingIcon={<Eye aria-hidden="true" size={13} />} onClick={() => onAction("focus")} size="sm" variant="ghost">
          {actionLabel("focus")}
        </Button>
        <Button disabled={!canVoice} leadingIcon={<Mic aria-hidden="true" size={13} />} onClick={() => onAction("voice")} size="sm" variant="ghost">
          {actionLabel("voice")}
        </Button>
        <Button disabled={!canResume} leadingIcon={<Play aria-hidden="true" size={13} />} onClick={() => onAction("resume")} size="sm" variant="ghost">
          {actionLabel("resume")}
        </Button>
        <Button disabled={!canStop} leadingIcon={<Square aria-hidden="true" size={13} />} onClick={() => onAction("stop")} size="sm" variant="ghost" title="Stop selected agents without deleting their sessions">
          {actionLabel("stop")}
        </Button>
        <IconButton icon={<X aria-hidden="true" size={14} />} label="Clear selection" onClick={onClear} size="sm" />
      </div>
    </div>
  );
}

interface AgentCardProps {
  agent: FleetAgentModel;
  now: number;
  selected: boolean;
  onToggle: (id: string) => void;
  onFocus?: (terminalId: string, workspaceId?: string) => void;
  onVoice?: (terminalId?: string) => void;
  onResume?: (terminalId: string) => void;
  onStop?: (terminalId: string) => void;
}

function AgentCard({
  agent,
  now,
  selected,
  onToggle,
  onFocus,
  onVoice,
  onResume,
  onStop,
}: AgentCardProps) {
  const lastActivity = formatFleetRelativeTime(agent.lastActivity, now);
  const duration = formatFleetDuration(agent.duration);
  const isResumable = agent.status === "suspended" || agent.status === "exited";
  const contextAttention = agent.contextUsage !== null && agent.contextUsage >= 85;
  const notificationLabel = agent.notificationCount === 1 ? "notification" : "notifications";

  return (
    <article className={styles.agentCard} data-selected={selected || undefined} data-status={agent.status}>
      <div className={styles.agentTop}>
        <div className={styles.agentIdentity}>
          <input
            aria-label={`Select ${agent.label} in ${agent.workspaceName}`}
            checked={selected}
            className={styles.checkbox}
            onChange={() => onToggle(agent.id)}
            type="checkbox"
          />
          {onFocus ? (
            <button
              aria-label={`Focus ${agent.label} in ${agent.workspaceName}`}
              className={styles.cardMain}
              onClick={() => onFocus(agent.terminalId, agent.workspaceId)}
              type="button"
            >
              <span className={styles.agentTitle}>{agent.label}</span>
              {agent.title && agent.title !== agent.label ? <span className={styles.agentSubtitle}>{agent.title}</span> : null}
              <code className={styles.command}>{agent.command}</code>
            </button>
          ) : (
            <div className={`${styles.cardMain} ${styles.cardMainStatic}`}>
              <span className={styles.agentTitle}>{agent.label}</span>
              {agent.title && agent.title !== agent.label ? <span className={styles.agentSubtitle}>{agent.title}</span> : null}
              <code className={styles.command}>{agent.command}</code>
            </div>
          )}
        </div>
        <StatusBadge status={agent.status} />
      </div>

      <div className={styles.agentTelemetry} aria-label="Agent telemetry">
        {agent.branch ? (
          <span className={styles.telemetryItem} title={`Branch ${agent.branch}`}>
            <GitBranch aria-hidden="true" size={11} />
            {agent.branch}
          </span>
        ) : null}
        {agent.contextUsage !== null ? (
          <span className={styles.telemetryItem} data-attention={contextAttention || undefined}>
            <Zap aria-hidden="true" size={11} />
            {agent.contextUsage}% context
          </span>
        ) : null}
        {agent.notificationCount > 0 ? (
          <span className={styles.telemetryItem} data-attention="true">
            <Bell aria-hidden="true" size={11} />
            {agent.notificationCount} {notificationLabel}
          </span>
        ) : null}
        {lastActivity ? (
          <span className={styles.telemetryItem}>
            <Clock3 aria-hidden="true" size={11} />
            {lastActivity}
          </span>
        ) : null}
        {duration ? <span className={styles.telemetryItem}>{duration}</span> : null}
      </div>

      <div className={styles.agentFooter}>
        <span className={styles.agentSubtitle} title={agent.cwd}>{agent.cwd || "workspace"}</span>
        <div className={styles.agentActions}>
          {onFocus ? <IconButton icon={<Eye aria-hidden="true" size={13} />} label="Focus agent" onClick={() => onFocus(agent.terminalId, agent.workspaceId)} size="sm" /> : null}
          {onVoice ? <IconButton icon={<Mic aria-hidden="true" size={13} />} label="Send voice command to agent" onClick={() => onVoice(agent.terminalId)} size="sm" /> : null}
          {isResumable && onResume ? <IconButton icon={<Play aria-hidden="true" size={13} />} label="Resume agent" onClick={() => onResume(agent.terminalId)} size="sm" /> : null}
          {onStop ? <IconButton icon={<Square aria-hidden="true" size={13} />} label="Stop agent (preserve session)" title="Stop agent without deleting its session" onClick={() => onStop(agent.terminalId)} size="sm" /> : null}
        </div>
      </div>
    </article>
  );
}

function SummaryStrip({
  summary,
  activeStatus,
  onStatus,
}: {
  summary: FleetSummary;
  activeStatus: FleetStatusFilter;
  onStatus: (status: FleetStatusFilter) => void;
}) {
  return (
    <div aria-label="Fleet summary" className={styles.summaryStrip} role="group">
      {SUMMARY_ITEMS.map(({ status, label, icon: Icon }) => (
        <button
          aria-pressed={activeStatus === status}
          className={styles.summaryItem}
          data-active={activeStatus === status || undefined}
          data-status={status}
          key={status}
          onClick={() => onStatus(activeStatus === status ? "all" : status)}
          type="button"
        >
          <Icon aria-hidden="true" className={styles.summaryIcon} size={17} />
          <span className={styles.summaryCopy}>
            <strong className={styles.summaryValue}>{summaryCount(summary, status)}</strong>
            <span className={styles.summaryLabel}>{label}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

export function FleetCommandCenter({
  workspaces,
  groups = [],
  exited,
  notifications,
  contextUsage,
  titles,
  branches,
  lastActivity,
  durations,
  agentLabels,
  now = Date.now(),
  onFocus,
  onVoice,
  onResume,
  onStop,
  onSuspendGroup,
  onResumeGroup,
  onBatchAction,
  onBatch,
  viewMode: controlledViewMode,
  onViewModeChange,
  className,
}: FleetCommandCenterProps) {
  const [filters, setFilters] = useState<FleetFilters>({ ...DEFAULT_FLEET_FILTERS });
  const [uncontrolledViewMode, setUncontrolledViewMode] = useState<FleetViewMode>("cards");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingFleetConfirmation | null>(null);
  const sourceModel = useMemo<FleetModel>(
    () => deriveFleetModel({ workspaces, groups, exited, notifications, contextUsage, titles, branches, lastActivity, durations, agentLabels }),
    [agentLabels, branches, contextUsage, durations, exited, groups, lastActivity, notifications, titles, workspaces],
  );
  const model = useMemo(() => filterFleetModel(sourceModel, filters), [filters, sourceModel]);
  const viewMode = controlledViewMode ?? uncontrolledViewMode;

  const agentOptions = useMemo(
    () => [...new Set(sourceModel.agents.map((agent) => agent.label))].sort((a, b) => a.localeCompare(b)),
    [sourceModel.agents],
  );
  const visibleIds = useMemo(() => model.agents.map((agent) => agent.id), [model.agents]);
  const selectedAgents = useMemo(
    () => sourceModel.agents.filter((agent) => selectedIds.has(agent.id)),
    [selectedIds, sourceModel.agents],
  );
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const hasResumableSelection = selectedAgents.some((agent) => agent.status === "suspended" || agent.status === "exited");
  const hasBatchHandler = Boolean(onBatchAction || onBatch);

  useEffect(() => {
    const available = new Set(sourceModel.agents.map((agent) => agent.id));
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => available.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [sourceModel.agents]);

  function changeViewMode(next: FleetViewMode): void {
    setUncontrolledViewMode(next);
    onViewModeChange?.(next);
  }

  function toggleSelected(id: string): void {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleVisibleSelection(): void {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
      return next;
    });
  }

  function requestStop(terminalIds: readonly string[], batch = false): void {
    const ids = [...new Set(terminalIds.filter(Boolean))];
    if (ids.length === 0) return;
    const labels = sourceModel.agents
      .filter((agent) => ids.includes(agent.terminalId))
      .map((agent) => agent.label);
    setPendingConfirmation({
      kind: "stop",
      terminalIds: ids,
      label: labels.length <= 2 ? labels.join(" e ") : `${labels.length} agentes`,
      batch,
    });
  }

  function requestGroupSuspension(groupId: string, label: string): void {
    setPendingConfirmation({ kind: "suspend-group", groupId, label });
  }

  function confirmPendingAction(): void {
    const pending = pendingConfirmation;
    if (!pending) return;
    setPendingConfirmation(null);
    if (pending.kind === "suspend-group") {
      onSuspendGroup?.(pending.groupId);
      return;
    }
    if (pending.batch) {
      const handler = onBatchAction ?? onBatch;
      if (handler) {
        handler("stop", pending.terminalIds);
        return;
      }
    }
    pending.terminalIds.forEach((id) => onStop?.(id));
  }

  function dispatchBatch(action: FleetBatchAction): void {
    const ids = selectedAgents.map((agent) => agent.terminalId);
    if (ids.length === 0) return;
    if (action === "stop") {
      requestStop(ids, true);
      return;
    }
    const handler = onBatchAction ?? onBatch;
    if (handler) {
      handler(action, ids);
      return;
    }
    if (action === "focus") ids.forEach((id) => onFocus?.(id));
    else if (action === "voice") onVoice?.(ids[0]);
    else if (action === "resume") ids.forEach((id) => onResume?.(id));
  }

  const rootClassName = [styles.root, className].filter(Boolean).join(" ");

  return (
    <section aria-label="Fleet command center" className={rootClassName}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Terra / Command center</p>
          <h1 className={styles.title}>Fleet command center</h1>
          <p className={styles.subtitle}>Veja cada execução de agente de relance e foque, fale, retome ou pare sem deixar a console silenciosa.</p>
        </div>
        <div className={styles.headerActions}>
          {onVoice ? <Button leadingIcon={<Mic aria-hidden="true" size={14} />} onClick={() => onVoice()} size="sm" variant="default">Voice command</Button> : null}
          <div aria-label="Fleet display mode" className={styles.viewToggle} role="group">
            <button aria-label="Card view" aria-pressed={viewMode === "cards"} className={styles.viewButton} data-active={viewMode === "cards" || undefined} onClick={() => changeViewMode("cards")} type="button"><LayoutGrid aria-hidden="true" size={14} /></button>
            <button aria-label="List view" aria-pressed={viewMode === "list"} className={styles.viewButton} data-active={viewMode === "list" || undefined} onClick={() => changeViewMode("list")} type="button"><List aria-hidden="true" size={14} /></button>
          </div>
        </div>
      </header>

      <div aria-label="Fleet filters" className={styles.toolbar} role="group">
        <SearchField
          aria-label="Search fleet"
          className={styles.search}
          label="Search fleet"
          onChange={(event) => setFilter(setFilters, "query", event.target.value)}
          placeholder="Search agents, workspaces, branches..."
          value={filters.query}
        />
        <label className={styles.filterLabel}>
          Group
          <select className={styles.filterSelect} onChange={(event) => setFilter(setFilters, "groupId", event.target.value)} value={filters.groupId}>
            <option value="all">All groups</option>
            {sourceModel.groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select>
        </label>
        <label className={styles.filterLabel}>
          Status
          <select className={styles.filterSelect} onChange={(event) => setFilter(setFilters, "status", event.target.value as FleetStatusFilter)} value={filters.status}>
            <option value="all">All states</option>
            {SUMMARY_ITEMS.map(({ status, label }) => <option key={status} value={status}>{label}</option>)}
          </select>
        </label>
        <label className={styles.filterLabel}>
          Agent
          <select className={styles.filterSelect} onChange={(event) => setFilter(setFilters, "agent", event.target.value)} value={filters.agent}>
            <option value="all">All agents</option>
            {agentOptions.map((agent) => <option key={agent} value={agent}>{agent}</option>)}
          </select>
        </label>
        <div className={styles.filterActions}>
          <Button disabled={!filters.query && filters.groupId === "all" && filters.status === "all" && filters.agent === "all"} onClick={() => setFilters({ ...DEFAULT_FLEET_FILTERS })} size="sm" variant="ghost">Reset</Button>
        </div>
      </div>

      <SummaryStrip activeStatus={filters.status} onStatus={(status) => setFilter(setFilters, "status", status)} summary={model.summary} />

      {model.groups.length > 0 ? (
        <div className={styles.board}>
          {model.groups.map((group) => {
            const groupStatus = statusMeta(group.status);
            const GroupIcon = groupStatus.icon;
            const groupAgentCount = group.projects.reduce((count, project) => count + project.agents.length, 0);
            return (
              <section aria-labelledby={`fleet-group-${group.id}`} className={styles.group} key={group.id}>
                <header className={styles.groupHeader}>
                  <div className={styles.groupHeading}>
                    <StatusDot label={`${groupStatus.label} group`} pulse={group.status === "working"} size="sm" status={groupStatus.dot} />
                    <GroupIcon aria-hidden="true" size={14} />
                    <h2 className={styles.groupTitle} id={`fleet-group-${group.id}`}>{group.name}</h2>
                    <span className={styles.groupMeta}>{group.projects.length} projects · {groupAgentCount} agents</span>
                  </div>
                  <div className={styles.groupActions}>
                    <StatusBadge status={group.status} />
                    {group.id !== "ungrouped" && (group.suspended ? onResumeGroup : onSuspendGroup) ? (
                      <button className={styles.groupButton} onClick={() => (group.suspended ? onResumeGroup?.(group.id) : requestGroupSuspension(group.id, group.name))} type="button">
                        {group.suspended ? "Resume group" : "Suspend group"}
                      </button>
                    ) : null}
                  </div>
                </header>
                <div className={styles.projectGrid}>
                  {group.projects.map((project) => (
                    <article className={styles.project} key={project.id}>
                      <header className={styles.projectHeader}>
                        {onFocus ? (
                          <button aria-label={`Focus project ${project.name}`} className={styles.projectButton} onClick={() => project.agents[0] && onFocus(project.agents[0].terminalId, project.id)} type="button">
                            <FolderGit2 aria-hidden="true" className={styles.projectIcon} size={14} />
                            <span className={styles.projectCopy}>
                              <span className={styles.projectName}>{project.name}</span>
                              <span className={styles.projectPath} title={project.cwd}>{project.cwd}</span>
                            </span>
                          </button>
                        ) : (
                          <div className={`${styles.projectButton} ${styles.projectButtonStatic}`}>
                            <FolderGit2 aria-hidden="true" className={styles.projectIcon} size={14} />
                            <span className={styles.projectCopy}>
                              <span className={styles.projectName}>{project.name}</span>
                              <span className={styles.projectPath} title={project.cwd}>{project.cwd}</span>
                            </span>
                          </div>
                        )}
                        {project.branch ? <span className={styles.branch} title={`Branch ${project.branch}`}><GitBranch aria-hidden="true" size={11} />{project.branch}</span> : null}
                      </header>
                      <div className={styles.agents} data-view={viewMode}>
                        {project.agents.map((agent) => (
                          <AgentCard
                            agent={agent}
                            key={agent.id}
                            now={now}
                            onFocus={onFocus}
                            onResume={onResume}
                            onStop={onStop ? (terminalId) => requestStop([terminalId]) : undefined}
                            onToggle={toggleSelected}
                            onVoice={onVoice}
                            selected={selectedIds.has(agent.id)}
                          />
                        ))}
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <div className={styles.empty} role="status">
          <SearchX aria-hidden="true" className={styles.emptyIcon} size={22} />
          <span>{sourceModel.agents.length === 0 ? "No agents in the fleet yet." : "No agents match these filters."}</span>
          {sourceModel.agents.length > 0 ? <button className={styles.emptyAction} onClick={() => setFilters({ ...DEFAULT_FLEET_FILTERS })} type="button">Clear filters</button> : null}
        </div>
      )}

      <BatchActionBar
        canFocus={Boolean(onFocus || hasBatchHandler)}
        canResume={hasResumableSelection && Boolean(onResume || onBatchAction || onBatch)}
        canStop={Boolean(onStop || onBatchAction || onBatch)}
        canVoice={Boolean(onVoice || onBatchAction || onBatch)}
        onAction={dispatchBatch}
        onClear={() => setSelectedIds(new Set())}
        selectedCount={selectedIds.size}
      />
      {model.agents.length > 0 ? (
        <button aria-pressed={allVisibleSelected} className={styles.selectAll} onClick={toggleVisibleSelection} type="button">
          <span aria-hidden="true" className={styles.selectAllIndicator} data-selected={allVisibleSelected || undefined} />
          {allVisibleSelected ? "Clear visible selection" : "Select all visible agents"}
        </button>
      ) : null}
      <ConfirmActionDialog
        open={pendingConfirmation !== null}
        onOpenChange={(open) => {
          if (!open) setPendingConfirmation(null);
        }}
        title={pendingConfirmation?.kind === "suspend-group" ? `Suspender grupo ${pendingConfirmation.label}?` : `Parar ${pendingConfirmation?.label ?? "agente"}?`}
        description={pendingConfirmation?.kind === "suspend-group"
          ? "Todos os PTYs do grupo serão parados, mas os metadados e o histórico permanecerão disponíveis para retomada."
          : "O processo será parado, mas a sessão e sua posição permanecerão disponíveis para retomada."
        }
        confirmLabel={pendingConfirmation?.kind === "suspend-group" ? "Suspender grupo" : "Parar sessão"}
        onConfirm={confirmPendingAction}
      />
    </section>
  );
}

export type { FleetAgentModel, FleetDerivationInput, FleetFilters, FleetModel, FleetStatus, FleetStatusFilter, FleetSummary, FleetViewMode } from "./model";
