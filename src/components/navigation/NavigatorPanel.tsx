import { Folder, GitBranch, Plus, Search } from "../../components/icons";
import { Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type ChangeEvent, type MouseEvent } from "react";
import { ProjectTree } from "./ProjectTree";
import { NavigatorFilesView } from "./NavigatorFilesView";
import { NavigatorGitView } from "./NavigatorGitView";
import {
  buildNavigatorTree,
  filterNavigatorTree,
} from "./treeModel";
import type { ActivityTab, NavigatorNode, NavigatorNodeRef, NavigatorPanelProps } from "./types";
import styles from "./Navigator.module.css";

const ACTIVITY_TABS: readonly { id: ActivityTab; label: string }[] = [
  { id: "projects", label: "Projetos" },
  { id: "files", label: "Arquivos" },
  { id: "git", label: "Git" },
];

const DEFAULT_ACTIVITIES: readonly ActivityTab[] = ["projects"];

function collectExpandable(tree: ReturnType<typeof buildNavigatorTree>): Set<string> {
  const ids = new Set<string>();
  const visit = (node: NavigatorNode) => {
    if (node.children.length > 0) ids.add(node.id);
    node.children.forEach(visit);
  };
  tree.roots.forEach(visit);
  return ids;
}

function classes(...values: Array<string | undefined | false>): string {
  return values.filter(Boolean).join(" ");
}

const EMPTY_COLLAPSED_IDS: readonly string[] = [];

/**
 * Full navigator surface. Project ordering is intentionally static; the
 * panel only exposes explicit create, focus, hide and delete actions.
 */
export function NavigatorPanel({
  workspaces,
  snapshot = null,
  groups = [],
  activeWorkspaceId = null,
  activeContainerId = null,
  activePaneId = null,
  activeTerminalId = null,
  exited = {},
  notifications = {},
  contextUsage = {},
  statuses,
  branches = [],
  containerVisibility = {},
  collapsedIds,
  defaultCollapsedIds = EMPTY_COLLAPSED_IDS,
  onCollapsedChange,
  onOpenWorkspace,
  onOpenTerminal,
  onFocus,
  onCreateGroup,
  onCreateProject,
  onCreateWorkspace,
  onCreateAgent,
  onRenameNode,
  onDeleteWorkspace,
  onHideContainer,
  onHideWorkspace,
  onSuspendGroup,
  onResumeGroup,
  onContextMenu,
  loadFiles,
  loadGitStatus,
  activeActivity = "projects",
  onActivityChange,
  capabilities,
  availableActivities,
  title = "Terra Navigator",
  className,
  style,
  emptyState,
  agentLabels,
  flatten = false,
  headerSlot,
}: NavigatorPanelProps) {
  const [query, setQuery] = useState("");
  const [localCollapsed, setLocalCollapsed] = useState<Set<string>>(() => new Set(defaultCollapsedIds));
  const [contextMenu, setContextMenu] = useState<{
    node: NavigatorNodeRef;
    x: number;
    y: number;
  } | null>(null);
  const controlledCollapsed = collapsedIds !== undefined;
  const enabledActivities = useMemo(() => {
    const source = availableActivities ?? (capabilities
      ? ACTIVITY_TABS.filter((tab) => capabilities[tab.id]).map((tab) => tab.id)
      : DEFAULT_ACTIVITIES);
    const result = ACTIVITY_TABS.filter((tab) => {
      if (!source.includes(tab.id)) return false;
      if (capabilities && capabilities[tab.id] === false) return false;
      if (tab.id === "files") return Boolean(loadFiles && workspaces.length > 0);
      if (tab.id === "git") return Boolean(loadGitStatus && workspaces.length > 0);
      return true;
    }).map((tab) => tab.id);
    return result.length > 0 ? result : DEFAULT_ACTIVITIES;
  }, [availableActivities, capabilities, loadFiles, loadGitStatus, workspaces.length]);
  const selectedActivity = enabledActivities.includes(activeActivity) ? activeActivity : "projects";
  const collapsed = useMemo(() => new Set(collapsedIds ?? localCollapsed), [collapsedIds, localCollapsed]);
  const tree = useMemo(
    () => buildNavigatorTree(workspaces, { snapshot, groups, exited, notifications, contextUsage, statuses, branches, containerVisibility, agentLabels, flatten }),
    [agentLabels, branches, containerVisibility, contextUsage, exited, flatten, groups, notifications, snapshot, statuses, workspaces],
  );
  const filteredTree = useMemo(() => filterNavigatorTree(tree, query), [query, tree]);
  const expandableIds = useMemo(() => collectExpandable(filteredTree), [filteredTree]);
  const expandedIds = useMemo(() => {
    if (query.trim()) return expandableIds;
    const result = new Set(expandableIds);
    collapsed.forEach((id) => result.delete(id));
    return result;
  }, [collapsed, expandableIds, query]);
  useEffect(() => {
    if (controlledCollapsed) return;
    setLocalCollapsed((current) => {
      const valid = new Set(defaultCollapsedIds);
      if (current.size === 0 && valid.size > 0) return valid;
      return current;
    });
  }, [controlledCollapsed, defaultCollapsedIds]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu]);

  function toggleNode(id: string) {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    if (!controlledCollapsed) setLocalCollapsed(next);
    onCollapsedChange?.([...next]);
  }

  function handleQuery(event: ChangeEvent<HTMLInputElement>) {
    setQuery(event.target.value);
  }

  function handleContextMenu(event: MouseEvent<HTMLElement>, node: NavigatorNodeRef) {
    event.preventDefault();
    event.stopPropagation();
    onContextMenu?.(event, node);
    if (node.kind !== "project" || !onDeleteWorkspace) return;
    const width = typeof window === "undefined" ? 1024 : window.innerWidth;
    const height = typeof window === "undefined" ? 768 : window.innerHeight;
    setContextMenu({
      node,
      x: Math.max(8, Math.min(event.clientX, width - 196)),
      y: Math.max(8, Math.min(event.clientY, height - 52)),
    });
  }

  const projectCount = workspaces.length;
  const createProject = onCreateProject ?? onCreateWorkspace;

  return (
    <aside aria-label={title} className={classes(styles.panel, className)} style={style}>
      <header className={styles.header}>
        {headerSlot ?? (
          <div className={styles.headerTop}>
            <div className={styles.titleCluster}>
              <span aria-hidden="true" className={styles.mark}><Folder size={13} /></span>
              <h2 className={styles.title}>{title}</h2>
            </div>
          </div>
        )}
        <nav aria-label="Atividade" className={styles.activityTabs} role="tablist">
          {ACTIVITY_TABS.filter((tab) => enabledActivities.includes(tab.id)).map((tab) => (
            <button
              aria-selected={selectedActivity === tab.id}
              className={classes(styles.tab, selectedActivity === tab.id && styles.tabActive)}
              key={tab.id}
              onClick={() => onActivityChange?.(tab.id)}
              role="tab"
              type="button"
            >
              {tab.id === "git" ? <GitBranch aria-hidden="true" size={12} /> : null}
              <span className={styles.tabLabel}>{tab.label}</span>
            </button>
          ))}
        </nav>
        <label className={styles.searchRow}>
          <Search aria-hidden="true" size={13} />
          <input aria-label="Buscar projetos e agentes" className={styles.searchInput} onChange={handleQuery} placeholder="Buscar projetos, agentes…" type="search" value={query} />
        </label>
      </header>
      {selectedActivity === "projects" ? <div className={styles.treeViewport}>
          <ProjectTree
            activeTerminalId={activeTerminalId}
            activeWorkspaceId={activeWorkspaceId}
            activeContainerId={activeContainerId}
            activePaneId={activePaneId}
            branches={branches}
            contextUsage={contextUsage}
            containerVisibility={containerVisibility}
            exited={exited}
            groups={groups}
            expandedIds={expandedIds}
            notifications={notifications}
            onContextMenu={handleContextMenu}
            onCreateAgent={onCreateAgent}
            onCreateGroup={onCreateGroup}
            onCreateProject={createProject}
            onDeleteWorkspace={onDeleteWorkspace}
            onFocus={onFocus}
            onHideContainer={onHideContainer}
            onHideWorkspace={onHideWorkspace}
            onOpenTerminal={onOpenTerminal}
            onOpenWorkspace={onOpenWorkspace}
            onRenameNode={onRenameNode}
            onResumeGroup={onResumeGroup}
            onSuspendGroup={onSuspendGroup}
            onToggle={toggleNode}
            statuses={statuses}
            tree={filteredTree}
            workspaces={workspaces}
          />
        {contextMenu ? (
          <div
            aria-label="Menu de contexto do projeto"
            className={styles.contextMenu}
            onPointerDown={(event) => event.stopPropagation()}
            role="menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button
              className={styles.contextMenuItem}
              onClick={() => {
                const projectId = contextMenu.node.id;
                setContextMenu(null);
                onDeleteWorkspace?.(projectId);
              }}
              role="menuitem"
              type="button"
            >
              <Trash2 aria-hidden="true" size={14} />
              <span>Excluir projeto</span>
            </button>
          </div>
        ) : null}
        {emptyState && workspaces.length === 0 ? emptyState : null}
      </div> : selectedActivity === "files" && loadFiles ? <NavigatorFilesView activeWorkspaceId={activeWorkspaceId} loadFiles={loadFiles} onSelectWorkspace={onOpenWorkspace} workspaces={workspaces} /> : selectedActivity === "git" && loadGitStatus ? <NavigatorGitView activeWorkspaceId={activeWorkspaceId} loadGitStatus={loadGitStatus} onSelectWorkspace={onOpenWorkspace} workspaces={workspaces} /> : <div className={styles.integrationView}><div className={styles.integrationEmpty}>Esta atividade não está disponível.</div></div>}
      <footer className={styles.footer}>
        <span>{projectCount} projeto{projectCount === 1 ? "" : "s"}</span>
        {createProject ? <button className={styles.footerAction} onClick={() => createProject(null)} type="button"><Plus aria-hidden="true" size={12} /> Novo projeto</button> : null}
      </footer>
    </aside>
  );
}
