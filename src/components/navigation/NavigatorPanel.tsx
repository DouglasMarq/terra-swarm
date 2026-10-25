import { useReportedStates } from "../../stores/mcpStore";
import { useT, type MessageKey } from "../../i18n";
import { Folder, GitBranch, Plus, Search } from "../../components/icons";
import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type MouseEvent } from "react";
import { ProjectTree } from "./ProjectTree";
import { NavigatorFilesView } from "./NavigatorFilesView";
import { useEditorStore } from "../../stores/editorStore";
import { NavigatorGitView } from "./NavigatorGitView";
import { AgentContextMenu, ProjectContextMenu, type MenuPosition } from "./NavigatorContextMenus";
import {
  buildNavigatorTree,
  filterNavigatorTree,
} from "./treeModel";
import type { ActivityTab, NavigatorActivityCapabilities, NavigatorNode, NavigatorNodeRef, NavigatorPanelProps } from "./types";
import styles from "./Navigator.module.css";

const AGENT_MENU_WIDTH_PX = 272;
const AGENT_MENU_HEIGHT_PX = 360;
const PROJECT_MENU_WIDTH_PX = 196;
const PROJECT_MENU_HEIGHT_PX = 52;
const MENU_MIN_TOP_PX = 56;
const MENU_MIN_LEFT_PX = 8;
const FALLBACK_VIEWPORT_WIDTH_PX = 1024;
const FALLBACK_VIEWPORT_HEIGHT_PX = 768;

const ACTIVITY_TABS: readonly { id: ActivityTab; label: MessageKey }[] = [
  { id: "projects", label: "nav.projects" },
  { id: "files", label: "nav.files" },
  { id: "git", label: "nav.gitTab" },
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

interface ContextMenuState extends MenuPosition {
  node: NavigatorNodeRef;
}

interface ActivitySources {
  availableActivities?: readonly ActivityTab[];
  capabilities?: NavigatorActivityCapabilities;
  hasFiles: boolean;
  hasGit: boolean;
}

function isActivityEnabled(tab: ActivityTab, sources: ActivitySources): boolean {
  if (sources.capabilities && sources.capabilities[tab] === false) return false;
  if (tab === "files") return sources.hasFiles;
  if (tab === "git") return sources.hasGit;
  return true;
}

function enabledActivityTabs(sources: ActivitySources): readonly ActivityTab[] {
  const { availableActivities, capabilities } = sources;
  const source = availableActivities ?? (capabilities
    ? ACTIVITY_TABS.filter((tab) => capabilities[tab.id]).map((tab) => tab.id)
    : DEFAULT_ACTIVITIES);
  const result = ACTIVITY_TABS
    .filter((tab) => source.includes(tab.id) && isActivityEnabled(tab.id, sources))
    .map((tab) => tab.id);
  return result.length > 0 ? result : DEFAULT_ACTIVITIES;
}

function viewportSize(): { width: number; height: number } {
  if (typeof window === "undefined") return { width: FALLBACK_VIEWPORT_WIDTH_PX, height: FALLBACK_VIEWPORT_HEIGHT_PX };
  return { width: window.innerWidth, height: window.innerHeight };
}

function menuAnchor(event: MouseEvent<HTMLElement>): MenuPosition {
  if (event.clientX !== 0 || event.clientY !== 0) return { x: event.clientX, y: event.clientY };
  const rect = event.currentTarget.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom };
}

function contextMenuPosition(event: MouseEvent<HTMLElement>, isAgentMenu: boolean): MenuPosition {
  const { width, height } = viewportSize();
  const menuWidth = isAgentMenu ? AGENT_MENU_WIDTH_PX : PROJECT_MENU_WIDTH_PX;
  const menuHeight = isAgentMenu ? AGENT_MENU_HEIGHT_PX : PROJECT_MENU_HEIGHT_PX;
  const anchor = menuAnchor(event);
  return {
    x: Math.max(MENU_MIN_LEFT_PX, Math.min(anchor.x, width - menuWidth)),
    y: Math.max(MENU_MIN_TOP_PX, Math.min(anchor.y, height - menuHeight)),
  };
}

function useMenuDismiss(isOpen: boolean, onDismiss: () => void): void {
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    document.addEventListener("pointerdown", onDismiss);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onDismiss);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen, onDismiss]);
}

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
  shouldFlatten = false,
  headerSlot,
  agentMenu,
}: NavigatorPanelProps) {
  const translate = useT();
  const [query, setQuery] = useState("");
  const [localCollapsed, setLocalCollapsed] = useState<Set<string>>(() => new Set(defaultCollapsedIds));
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const isCollapseControlled = collapsedIds !== undefined;
  const hasWorkspaces = workspaces.length > 0;
  const enabledActivities = useMemo(
    () => enabledActivityTabs({
      availableActivities,
      capabilities,
      hasFiles: Boolean(loadFiles) && hasWorkspaces,
      hasGit: Boolean(loadGitStatus) && hasWorkspaces,
    }),
    [availableActivities, capabilities, loadFiles, loadGitStatus, hasWorkspaces],
  );
  const selectedActivity = enabledActivities.includes(activeActivity) ? activeActivity : "projects";
  const collapsed = useMemo(() => new Set(collapsedIds ?? localCollapsed), [collapsedIds, localCollapsed]);
  const reported = useReportedStates();
  const tree = useMemo(
    () => buildNavigatorTree(workspaces, { snapshot, groups, exited, notifications, contextUsage, statuses, branches, containerVisibility, agentLabels, shouldFlatten, reported }),
    [agentLabels, branches, containerVisibility, contextUsage, exited, shouldFlatten, groups, notifications, snapshot, statuses, workspaces, reported],
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
    if (isCollapseControlled) return;
    setLocalCollapsed((current) => {
      const valid = new Set(defaultCollapsedIds);
      if (current.size === 0 && valid.size > 0) return valid;
      return current;
    });
  }, [isCollapseControlled, defaultCollapsedIds]);

  useMenuDismiss(contextMenu !== null, closeContextMenu);

  function toggleNode(id: string) {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    if (!isCollapseControlled) setLocalCollapsed(next);
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
    setContextMenu({ node, ...contextMenuPosition(event, isAgentMenu) });
  }

  const projectCount = workspaces.length;
  const createProject = onCreateProject ?? onCreateWorkspace;

  function renderAgentMenu() {
    if (!contextMenu || contextMenu.node.kind !== "agent" || !agentMenu) return null;
    const agent = tree.byId[contextMenu.node.id];
    if (!agent || agent.kind !== "agent") return null;
    const groupsForAgent = agentMenu(agent.terminalId, agent.source.command).filter((group) => group.length > 0);
    return <AgentContextMenu agent={agent} groups={groupsForAgent} onClose={closeContextMenu} position={contextMenu} />;
  }

  function renderProjectMenu() {
    if (!contextMenu || contextMenu.node.kind !== "project") return null;
    const projectId = contextMenu.node.id;
    return <ProjectContextMenu onClose={closeContextMenu} onDelete={() => onDeleteWorkspace?.(projectId)} position={contextMenu} />;
  }

  function renderProjectsView() {
    return (
      <div className={styles.treeViewport}>
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
        {renderAgentMenu()}
        {renderProjectMenu()}
        {emptyState && workspaces.length === 0 ? emptyState : null}
      </div>
    );
  }

  function renderActivityView() {
    if (selectedActivity === "projects") return renderProjectsView();
    if (selectedActivity === "files" && loadFiles) {
      return <NavigatorFilesView activeWorkspaceId={activeWorkspaceId} loadFiles={loadFiles} onSelectWorkspace={onOpenWorkspace} onOpenFile={(workspaceId, path) => useEditorStore.getState().open({ workspaceId, path })} workspaces={workspaces} />;
    }
    if (selectedActivity === "git" && loadGitStatus) {
      return <NavigatorGitView activeWorkspaceId={activeWorkspaceId} loadGitStatus={loadGitStatus} onSelectWorkspace={onOpenWorkspace} workspaces={workspaces} />;
    }
    return <div className={styles.integrationView}><div className={styles.integrationEmpty}>{translate("nav.unavailable")}</div></div>;
  }

  return (
    <aside aria-label={title ?? translate("shell.sidebar.label")} className={classes(styles.panel, className)} style={style}>
      <header className={styles.header}>
        {headerSlot ?? (
          <div className={styles.headerTop}>
            <div className={styles.titleCluster}>
              <span aria-hidden="true" className={styles.mark}><Folder size={13} /></span>
              <h2 className={styles.title}>{title ?? translate("shell.sidebar.label")}</h2>
            </div>
          </div>
        )}
        <nav aria-label={translate("nav.activity")} className={styles.activityTabs} role="tablist">
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
              <span className={styles.tabLabel}>{translate(tab.label)}</span>
            </button>
          ))}
        </nav>
        <label className={styles.searchRow}>
          <Search aria-hidden="true" size={13} />
          <input aria-label={translate("nav.search")} className={styles.searchInput} onChange={handleQuery} placeholder={translate("nav.searchPlaceholder")} type="search" value={query} />
        </label>
      </header>
      {renderActivityView()}
      <footer className={styles.footer}>
        <span>{translate("nav.projectCount", { count: projectCount })}</span>
        {createProject ? <button className={styles.footerAction} onClick={() => createProject(null)} type="button"><Plus aria-hidden="true" size={12} /> {translate("palette.newProject")}</button> : null}
      </footer>
    </aside>
  );
}
