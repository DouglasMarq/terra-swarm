import { useReportedStates } from "../../stores/mcpStore";
import { t } from "../../i18n";
import { Folder, GitBranch, Plus, Search } from "../../components/icons";
import { Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type ChangeEvent, type MouseEvent } from "react";
import { ProjectTree } from "./ProjectTree";
import { NavigatorFilesView } from "./NavigatorFilesView";
import { useEditorStore } from "../../stores/editorStore";
import { NavigatorGitView } from "./NavigatorGitView";
import {
  buildNavigatorTree,
  filterNavigatorTree,
} from "./treeModel";
import type { ActivityTab, NavigatorNode, NavigatorNodeRef, NavigatorPanelProps } from "./types";
import styles from "./Navigator.module.css";

const ACTIVITY_TABS: readonly { id: ActivityTab; label: string }[] = [
  { id: "projects", get label() { return t("nav.projects"); } },
  { id: "files", get label() { return t("nav.files"); } },
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
  title,
  className,
  style,
  emptyState,
  agentLabels,
  flatten = false,
  headerSlot,
  agentMenu,
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
  const reported = useReportedStates();
  const tree = useMemo(
    () => buildNavigatorTree(workspaces, { snapshot, groups, exited, notifications, contextUsage, statuses, branches, containerVisibility, agentLabels, flatten, reported }),
    [agentLabels, branches, containerVisibility, contextUsage, exited, flatten, groups, notifications, snapshot, statuses, workspaces, reported],
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
    const isAgentMenu = node.kind === "agent" && Boolean(agentMenu);
    if (!isAgentMenu && (node.kind !== "project" || !onDeleteWorkspace)) return;
    const width = typeof window === "undefined" ? 1024 : window.innerWidth;
    const height = typeof window === "undefined" ? 768 : window.innerHeight;
    // The agent menu is wider and taller than the single "Delete project" item.
    const menuWidth = isAgentMenu ? 272 : 196;
    const menuHeight = isAgentMenu ? 360 : 52;
    // Opened from the keyboard (ContextMenu key, Shift+F10, Enter on "…")
    // there is no pointer position: anchor to the row or button instead.
    let anchorX = event.clientX;
    let anchorY = event.clientY;
    if (anchorX === 0 && anchorY === 0) {
      const rect = event.currentTarget.getBoundingClientRect();
      anchorX = rect.left;
      anchorY = rect.bottom;
    }
    // 56px keeps it clear of the 48px window chrome and the macOS traffic lights.
    setContextMenu({
      node,
      x: Math.max(8, Math.min(anchorX, width - menuWidth)),
      y: Math.max(56, Math.min(anchorY, height - menuHeight)),
    });
  }

  const projectCount = workspaces.length;
  const createProject = onCreateProject ?? onCreateWorkspace;

  return (
    <aside aria-label={title ?? t("shell.sidebar.label")} className={classes(styles.panel, className)} style={style}>
      <header className={styles.header}>
        {headerSlot ?? (
          <div className={styles.headerTop}>
            <div className={styles.titleCluster}>
              <span aria-hidden="true" className={styles.mark}><Folder size={13} /></span>
              <h2 className={styles.title}>{title ?? t("shell.sidebar.label")}</h2>
            </div>
          </div>
        )}
        <nav aria-label={t("nav.activity")} className={styles.activityTabs} role="tablist">
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
          <input aria-label={t("nav.search")} className={styles.searchInput} onChange={handleQuery} placeholder={t("nav.searchPlaceholder")} type="search" value={query} />
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
        {contextMenu && contextMenu.node.kind === "agent" && agentMenu ? (() => {
          const agent = tree.byId[contextMenu.node.id];
          if (!agent || agent.kind !== "agent") return null;
          const groupsForAgent = agentMenu(agent.terminalId, agent.source.command).filter((group) => group.length > 0);
          return (
            <div
              aria-label={t("nav.agentMenu", { name: agent.name })}
              className={`${styles.contextMenu} ${styles.agentMenu}`}
              onPointerDown={(event) => event.stopPropagation()}
              role="menu"
              style={{ left: contextMenu.x, top: contextMenu.y }}
            >
              {groupsForAgent.map((group, index) => (
                <div className={styles.agentMenuGroup} role="group" key={group[0]?.id ?? index}>
                  {group.map((item) => (
                    <button
                      className={styles.agentMenuItem}
                      data-danger={item.danger}
                      disabled={item.disabled}
                      key={item.id}
                      onClick={() => {
                        setContextMenu(null);
                        item.onSelect();
                      }}
                      role="menuitem"
                      type="button"
                    >
                      <span className={styles.agentMenuIcon} aria-hidden="true">{item.icon}</span>
                      <span className={styles.agentMenuLabel}>{item.label}</span>
                      {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          );
        })() : null}
        {contextMenu && contextMenu.node.kind === "project" ? (
          <div
            aria-label={t("nav.projectMenu")}
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
              <span>{t("nav.deleteProject")}</span>
            </button>
          </div>
        ) : null}
        {emptyState && workspaces.length === 0 ? emptyState : null}
      </div> : selectedActivity === "files" && loadFiles ? <NavigatorFilesView activeWorkspaceId={activeWorkspaceId} loadFiles={loadFiles} onSelectWorkspace={onOpenWorkspace} onOpenFile={(workspaceId, path) => useEditorStore.getState().open({ workspaceId, path })} workspaces={workspaces} /> : selectedActivity === "git" && loadGitStatus ? <NavigatorGitView activeWorkspaceId={activeWorkspaceId} loadGitStatus={loadGitStatus} onSelectWorkspace={onOpenWorkspace} workspaces={workspaces} /> : <div className={styles.integrationView}><div className={styles.integrationEmpty}>{t("nav.unavailable")}</div></div>}
      <footer className={styles.footer}>
        <span>{t("nav.projectCount", { count: projectCount })}</span>
        {createProject ? <button className={styles.footerAction} onClick={() => createProject(null)} type="button"><Plus aria-hidden="true" size={12} /> {t("palette.newProject")}</button> : null}
      </footer>
    </aside>
  );
}
