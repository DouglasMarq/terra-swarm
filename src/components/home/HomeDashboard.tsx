import { useMemo } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  ArrowUpRight,
  Bot,
  Check,
  Clock3,
  FolderKanban,
  Gauge,
  Layers3,
  Mic,
  Plus,
  Sparkles,
  Users,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { DEFAULT_HOTKEYS, formatHotkey, usePreferencesStore, type Hotkey } from "../../stores/preferencesStore";
import "./home.css";

export type HomeStatusTone = "good" | "warn" | "bad" | "neutral";

export interface SwarmPulseData {
  activeAgents: number;
  totalAgents?: number;
  queuedRuns?: number;
  completedRuns?: number;
  throughput?: string;
  tone?: "stable" | "attention" | "offline";
  note?: string;
}

export interface HomeQuickAction {
  id: string;
  label: string;
  description?: string;
  shortcut?: string;
  icon?: LucideIcon;
  disabled?: boolean;
}

export interface HomeRecentWorkspace {
  id: string;
  name: string;
  detail?: string;
  updatedAt?: string;
  status?: HomeStatusTone;
  agentCount?: number;
  icon?: LucideIcon;
}

export interface HomeActiveGroup {
  id: string;
  name: string;
  detail?: string;
  workspaceCount?: number;
  agentCount?: number;
  status?: HomeStatusTone;
}

export interface HomeTimelineEvent {
  id: string;
  label: string;
  detail?: string;
  time: string;
  tone?: HomeStatusTone;
  icon?: LucideIcon;
}

export interface HomeDashboardProps {
  greeting?: string;
  subtitle?: string;
  pulse?: SwarmPulseData;
  quickActions?: readonly HomeQuickAction[];
  recentWorkspaces?: readonly HomeRecentWorkspace[];
  activeGroups?: readonly HomeActiveGroup[];
  timeline?: readonly HomeTimelineEvent[];
  onQuickAction?: (actionId: string) => void;
  onOpenWorkspace?: (workspaceId: string) => void;
  onOpenGroup?: (groupId: string) => void;
  onPulseClick?: () => void;
  trailingHeader?: ReactNode;
}

const defaultPulse: SwarmPulseData = {
  activeAgents: 0,
  totalAgents: 0,
  queuedRuns: 0,
  completedRuns: 0,
  throughput: "—",
  tone: "offline",
  note: "Conecte um workspace para acompanhar o pulso do swarm.",
};

function defaultQuickActions(hotkeys: Readonly<Record<string, Hotkey>>): readonly HomeQuickAction[] {
  return [
    {
      id: "new-workspace",
      label: "Novo workspace",
      description: "Inicie uma sessão focada",
      shortcut: formatHotkey(hotkeys.newWorkspace ?? DEFAULT_HOTKEYS.newWorkspace),
      icon: Plus,
    },
    {
      id: "new-agent",
      label: "Iniciar agente",
      description: "Adicione uma execução da Luna Max",
      shortcut: formatHotkey(hotkeys.newTerminal ?? DEFAULT_HOTKEYS.newTerminal),
      icon: Bot,
    },
    {
      id: "open-fleet",
      label: "Abrir frota",
      description: "Veja todas as execuções ativas",
      icon: Layers3,
    },
    {
      id: "voice-command",
      label: "Comando de voz",
      description: "Diga uma intenção de orquestração",
      shortcut: formatHotkey(hotkeys.toggleVoice ?? DEFAULT_HOTKEYS.toggleVoice),
      icon: Mic,
    },
  ];
}

export function HomeDashboard({
  greeting = "Bom dia",
  subtitle = "Um console sereno para coordenar o trabalho na Terra.",
  pulse = defaultPulse,
  quickActions,
  recentWorkspaces = [],
  activeGroups = [],
  timeline = [],
  onQuickAction,
  onOpenWorkspace,
  onOpenGroup,
  onPulseClick,
  trailingHeader,
}: HomeDashboardProps) {
  const hotkeys = usePreferencesStore((state) => state.hotkeys);
  const generatedQuickActions = useMemo(() => defaultQuickActions(hotkeys), [hotkeys]);
  const selectedQuickActions = quickActions ?? generatedQuickActions;
  const totalAgents = pulse.totalAgents ?? pulse.activeAgents;
  const tone = pulse.tone ?? "stable";
  const displayedQuickActions = useMemo(
    () => selectedQuickActions.length > 0 ? selectedQuickActions : generatedQuickActions,
    [generatedQuickActions, selectedQuickActions],
  );

  return (
    <section className="terra-home" aria-label="Início da Terra">
      <div className="terra-home-inner">
        <header className="terra-home-heading">
          <div>
            <p className="terra-home-kicker">Console sereno / Visão geral</p>
            <h1 className="terra-home-title">{greeting}</h1>
            <p className="terra-home-subtitle">{subtitle}</p>
          </div>
          {trailingHeader ? <div className="terra-home-header-actions">{trailingHeader}</div> : null}
        </header>

        <div className="terra-home-metrics">
          <button
            className="terra-home-card terra-home-pulse-card"
            type="button"
            onClick={onPulseClick}
            disabled={!onPulseClick}
            aria-label="Abrir pulso do swarm"
          >
            <div className="terra-home-card-header">
              <span className="terra-home-card-label">Pulso do swarm</span>
              <Activity size={14} className="terra-home-stat-icon" aria-hidden="true" />
            </div>
            <div className="terra-home-pulse-main">
              <span className="terra-home-pulse-orbit" data-tone={tone} aria-hidden="true">
                <Gauge size={24} strokeWidth={1.4} />
              </span>
              <span className="terra-home-pulse-summary">
                <strong className="terra-home-pulse-value">
                  {pulse.activeAgents}/{totalAgents}
                </strong>
                <span className="terra-home-pulse-caption">agentes em execução</span>
              </span>
              <p className="terra-home-pulse-note">{pulse.note}</p>
            </div>
            <div className="terra-home-pulse-footer">
              <span><Zap size={12} aria-hidden="true" /><strong>{pulse.throughput ?? "—"}</strong> processamento</span>
              <span><Clock3 size={12} aria-hidden="true" /><strong>{pulse.queuedRuns ?? 0}</strong> na fila</span>
            </div>
          </button>
          <StatCard
            label="Concluídas"
            value={String(pulse.completedRuns ?? 0)}
            detail="Execuções registradas neste ciclo"
            icon={Check}
            tone="good"
          />
        </div>

        <div className="terra-home-grid">
          <div>
            <DashboardSection title="Ações rápidas" icon={Sparkles} meta="Comece pela intenção">
              <div className="terra-home-actions-list">
                {displayedQuickActions.map((action) => {
                  const Icon = action.icon ?? Zap;
                  return (
                    <button
                      className="terra-home-action-card"
                      key={action.id}
                      type="button"
                      disabled={action.disabled}
            onClick={() => onQuickAction?.(action.id)}
                    >
                      <span className="terra-home-action-icon"><Icon size={15} aria-hidden="true" /></span>
                      <span className="terra-home-action-copy">
                        <span className="terra-home-action-title">{action.label}</span>
                        {action.description && (
                          <span className="terra-home-action-description">{action.description}</span>
                        )}
                        {action.shortcut && (
                          <span className="terra-home-action-shortcut">{action.shortcut}</span>
                        )}
                      </span>
                      <ArrowUpRight size={13} className="terra-home-stat-icon" aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            </DashboardSection>

            <DashboardSection
              title="Workspaces recentes"
              icon={FolderKanban}
              meta={recentWorkspaces.length ? `${recentWorkspaces.length} disponíveis` : "Nenhum workspace"}
            >
              {recentWorkspaces.length === 0 ? (
                <EmptyList icon={FolderKanban}>Crie um workspace para incluí-lo na sua rotina.</EmptyList>
              ) : (
                <div className="terra-home-list">
                  {recentWorkspaces.map((workspace) => {
                    const Icon = workspace.icon ?? FolderKanban;
                    return (
                      <button
                        className="terra-home-recent-item"
                        key={workspace.id}
                        type="button"
                        onClick={() => onOpenWorkspace?.(workspace.id)}
                      >
                        <span className="terra-home-item-icon"><Icon size={14} aria-hidden="true" /></span>
                        <span className="terra-home-item-copy">
                          <span className="terra-home-item-title">{workspace.name}</span>
                          <span className="terra-home-item-detail">{workspace.detail ?? "Pronto para uma nova execução"}</span>
                        </span>
                        <span className="terra-home-status-dot" data-tone={workspace.status ?? "neutral"} aria-hidden="true" />
                        {workspace.agentCount !== undefined && (
                          <span className="terra-home-item-time">{workspace.agentCount} agentes</span>
                        )}
                        {workspace.updatedAt && <span className="terra-home-item-time">{workspace.updatedAt}</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </DashboardSection>
          </div>

          <div>
            <DashboardSection
              title="Grupos ativos"
              icon={Users}
              meta={activeGroups.length ? `${activeGroups.length} grupos` : "Em espera"}
            >
              {activeGroups.length === 0 ? (
                <EmptyList icon={Users}>Os grupos aparecem aqui quando houver trabalho coordenado.</EmptyList>
              ) : (
                <div className="terra-home-list">
                  {activeGroups.map((group) => (
                    <button
                      className="terra-home-group-item"
                      key={group.id}
                      type="button"
                      onClick={() => onOpenGroup?.(group.id)}
                    >
                      <span className="terra-home-status-dot" data-tone={group.status ?? "good"} aria-hidden="true" />
                      <span className="terra-home-item-copy">
                        <span className="terra-home-item-title">{group.name}</span>
                        <span className="terra-home-item-detail">{group.detail ?? "Grupo coordenado de workspaces"}</span>
                      </span>
                      <span className="terra-home-group-stats">
                        <span><FolderKanban size={12} aria-hidden="true" />{group.workspaceCount ?? 0}</span>
                        <span><Bot size={12} aria-hidden="true" />{group.agentCount ?? 0}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </DashboardSection>

            <DashboardSection title="Linha do tempo" icon={Clock3} meta="Sinais recentes">
              {timeline.length === 0 ? (
                <EmptyList icon={Activity}>Ainda não há sinais. A Terra manterá o próximo handoff visível.</EmptyList>
              ) : (
                <div className="terra-home-timeline">
                  {timeline.map((event) => {
                    const Icon = event.icon ?? Activity;
                    return (
                      <div className="terra-home-timeline-item" key={event.id}>
                        <span className="terra-home-timeline-marker" data-tone={event.tone ?? "neutral"}>
                          <Icon size={9} aria-hidden="true" />
                        </span>
                        <span className="terra-home-timeline-copy">
                          <span className="terra-home-timeline-label">{event.label}</span>
                          {event.detail && <span className="terra-home-timeline-detail">{event.detail}</span>}
                        </span>
                        <span className="terra-home-timeline-time">{event.time}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </DashboardSection>
          </div>
        </div>
      </div>

    </section>
  );
}

function DashboardSection({
  title,
  icon: Icon,
  meta,
  children,
}: {
  title: string;
  icon: LucideIcon;
  meta?: string;
  children: ReactNode;
}) {
  return (
    <section className="terra-home-section terra-home-card terra-home-section-card">
      <div className="terra-home-section-heading">
        <h2 className="terra-home-section-title"><Icon size={14} aria-hidden="true" />{title}</h2>
        {meta && <span className="terra-home-section-meta">{meta}</span>}
      </div>
      {children}
    </section>
  );
}

function StatCard({
  label,
  value,
  detail,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  icon: LucideIcon;
  tone: HomeStatusTone;
}) {
  return (
    <div className="terra-home-card terra-home-stat-card">
      <div className="terra-home-card-header">
        <span className="terra-home-card-label">{label}</span>
        <Icon className="terra-home-stat-icon" data-tone={tone === "good" ? "good" : tone === "warn" ? "warn" : undefined} size={14} aria-hidden="true" />
      </div>
      <strong className="terra-home-stat-value">{value}</strong>
      <span className="terra-home-stat-detail">{detail}</span>
    </div>
  );
}

function EmptyList({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <div className="terra-home-list-empty">
      <Icon size={15} aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

export { defaultPulse as DEFAULT_HOME_PULSE };
