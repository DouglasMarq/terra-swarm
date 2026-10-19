import type { ReactNode } from "react";
import { ChevronsRight, LayoutGrid, List, Settings2 } from "lucide-react";
import type { ShellSurface } from "../../stores/shellStore";
import { useT } from "../../i18n";
import "./sidebar.css";

type SidebarSurface = Extract<ShellSurface, "workbench" | "fleet">;

interface SurfaceSwitchProps {
  surface: ShellSurface;
  attentionCount: number;
  onNavigate: (surface: SidebarSurface) => void;
}

function AttentionCount({ count }: { count: number }) {
  const t = useT();
  if (count <= 0) return null;
  return <span className="terra-sidebar-count" aria-label={t("shell.attention.button", { count })}>{count}</span>;
}

/** Workbench | Frota. The two places work happens. */
export function SurfaceSwitch({ surface, attentionCount, onNavigate }: SurfaceSwitchProps) {
  const t = useT();
  return (
    <div className="terra-sidebar-switch" role="group" aria-label={t("shell.sidebar.surface")}>
      <button
        type="button"
        aria-pressed={surface === "workbench"}
        data-active={surface === "workbench"}
        onClick={() => onNavigate("workbench")}
      >
        {t("common.workbench")}
      </button>
      <button
        type="button"
        aria-pressed={surface === "fleet"}
        data-active={surface === "fleet"}
        onClick={() => onNavigate("fleet")}
      >
        {t("common.fleet")}
        <AttentionCount count={attentionCount} />
      </button>
    </div>
  );
}

export interface SidebarProps extends SurfaceSwitchProps {
  /** The project → agent navigator, rendered with the switch as its header. */
  children: ReactNode;
  activeAgents: number;
  version?: string;
  onOpenSettings: () => void;
}

export function Sidebar({ children, activeAgents, version, onOpenSettings, surface }: SidebarProps) {
  const t = useT();
  return (
    <div className="terra-sidebar" aria-label={t("shell.sidebar.label")}>
      <div className="terra-sidebar-tree">{children}</div>
      <footer className="terra-sidebar-footer">
        <button
          type="button"
          className="terra-sidebar-settings"
          data-active={surface === "settings"}
          onClick={onOpenSettings}
        >
          <Settings2 size={15} aria-hidden="true" />
          {t("common.settings")}
        </button>
        <span className="terra-sidebar-meta">
          {t("shell.sidebar.activeAgents", { count: activeAgents })}
          {version ? ` · v${version}` : ""}
        </span>
      </footer>
    </div>
  );
}

export interface CollapsedSidebarAgent {
  id: string;
  label: string;
  status: "working" | "attention" | "exited" | "suspended";
  detail: string;
}

export interface CollapsedSidebarProject {
  id: string;
  name: string;
  status: CollapsedSidebarAgent["status"] | "idle";
  suspended: boolean;
  agents: CollapsedSidebarAgent[];
}

export interface CollapsedSidebarProps {
  surface: ShellSurface;
  attentionCount: number;
  projects: readonly CollapsedSidebarProject[];
  activeWorkspaceId: string | null;
  focusedAgentId: string | null;
  onNavigate: (surface: SidebarSurface) => void;
  onOpenWorkspace: (workspaceId: string) => void;
  onFocusAgent: (workspaceId: string, terminalId: string) => void;
  onOpenSettings: () => void;
  onExpand: () => void;
  expandShortcut?: string;
}

function initials(name: string): string {
  const words = name.split(/[\s_.-]+/).filter(Boolean);
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toLowerCase();
  return name.slice(0, 2).toLowerCase();
}

/** 56px rail: surfaces, project initials, one dot per agent of the active project. */
export function CollapsedSidebar({
  surface,
  attentionCount,
  projects,
  activeWorkspaceId,
  focusedAgentId,
  onNavigate,
  onOpenWorkspace,
  onFocusAgent,
  onOpenSettings,
  onExpand,
  expandShortcut,
}: CollapsedSidebarProps) {
  const t = useT();
  const expandLabel = expandShortcut ? `${t("shell.sidebar.expand")} (${expandShortcut})` : t("shell.sidebar.expand");
  return (
    <nav className="terra-rail" aria-label={t("shell.sidebar.collapsedLabel")}>
      <button
        type="button"
        className="terra-rail-button"
        aria-label={t("common.workbench")}
        title={t("common.workbench")}
        data-active={surface === "workbench"}
        onClick={() => onNavigate("workbench")}
      >
        <LayoutGrid size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="terra-rail-button"
        aria-label={attentionCount > 0 ? t("shell.sidebar.fleetAttention", { count: attentionCount }) : t("common.fleet")}
        title={t("common.fleet")}
        data-active={surface === "fleet"}
        onClick={() => onNavigate("fleet")}
      >
        <List size={16} aria-hidden="true" />
        {attentionCount > 0 ? <span className="terra-rail-badge" aria-hidden="true">{attentionCount}</span> : null}
      </button>
      <span className="terra-rail-divider" aria-hidden="true" />
      <div className="terra-rail-projects">
        {projects.map((project) => {
          const active = project.id === activeWorkspaceId;
          return (
            <div className="terra-rail-project" key={project.id}>
              <button
                type="button"
                className="terra-rail-initials"
                data-active={active}
                data-suspended={project.suspended}
                aria-label={t("shell.sidebar.projectAgents", { name: project.name, count: project.agents.length })}
                title={project.name}
                onClick={() => onOpenWorkspace(project.id)}
              >
                {initials(project.name)}
                {project.status === "attention" ? <span className="terra-rail-project-dot" aria-hidden="true" /> : null}
              </button>
              {active
                ? project.agents.map((agent) => (
                  <button
                    type="button"
                    key={agent.id}
                    className="terra-rail-agent"
                    data-active={agent.id === focusedAgentId}
                    aria-label={`${agent.label}, ${agent.detail}`}
                    title={`${agent.label} · ${agent.detail}`}
                    onClick={() => onFocusAgent(project.id, agent.id)}
                  >
                    <span className="terra-dot" data-status={agent.status} aria-hidden="true" />
                  </button>
                ))
                : null}
            </div>
          );
        })}
      </div>
      <button type="button" className="terra-rail-button" aria-label={t("common.settings")} title={t("common.settings")} data-active={surface === "settings"} onClick={onOpenSettings}>
        <Settings2 size={16} aria-hidden="true" />
      </button>
      <button type="button" className="terra-rail-button" aria-label={expandLabel} title={expandLabel} onClick={onExpand}>
        <ChevronsRight size={16} aria-hidden="true" />
      </button>
    </nav>
  );
}
