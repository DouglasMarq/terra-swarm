import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { Folder, GitBranch, Plus, Search } from "../../components/icons";
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { getDropProjection, type DropProjection } from "./dropProjection";
import { ProjectTree } from "./ProjectTree";
import { NavigatorFilesView } from "./NavigatorFilesView";
import { NavigatorGitView } from "./NavigatorGitView";
import {
  buildNavigatorTree,
  filterNavigatorTree,
} from "./treeModel";
import type { ActivityTab, NavigatorNode, NavigatorPanelProps } from "./types";
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

function overlayLabel(node: NavigatorNode): string {
  if (node.kind === "group") return `Grupo · ${node.name}`;
  if (node.kind === "project") return `Projeto · ${node.name}`;
  return `Agente · ${node.name}`;
}

function latestRect(event: DragMoveEvent | DragEndEvent) {
  const overRect = event.over?.rect;
  const initial = event.active.rect.current.initial;
  if (!overRect || !initial) return null;
  return {
    overRect,
    pointerY: initial.top + event.delta.y + initial.height / 2,
    pointerX: initial.left + event.delta.x + initial.width / 2,
  };
}

const EMPTY_COLLAPSED_IDS: readonly string[] = [];

/**
 * Full navigator surface. DnD state lives here; ProjectTree remains a pure
 * presentation of the normalized tree and can be reused in compact layouts.
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
  onHideContainer,
  onHideWorkspace,
  onSuspendGroup,
  onResumeGroup,
  onContextMenu,
  onMoveNode,
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
}: NavigatorPanelProps) {
  const [query, setQuery] = useState("");
  const [localCollapsed, setLocalCollapsed] = useState<Set<string>>(() => new Set(defaultCollapsedIds));
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [projection, setProjection] = useState<DropProjection | null>(null);
  const projectionRef = useRef<DropProjection | null>(null);
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
    () => buildNavigatorTree(workspaces, { snapshot, groups, exited, notifications, contextUsage, statuses, branches, containerVisibility }),
    [branches, containerVisibility, contextUsage, exited, groups, notifications, snapshot, statuses, workspaces],
  );
  const filteredTree = useMemo(() => filterNavigatorTree(tree, query), [query, tree]);
  const expandableIds = useMemo(() => collectExpandable(filteredTree), [filteredTree]);
  const expandedIds = useMemo(() => {
    if (query.trim()) return expandableIds;
    const result = new Set(expandableIds);
    collapsed.forEach((id) => result.delete(id));
    return result;
  }, [collapsed, expandableIds, query]);
  const activeNode = activeDragId ? tree.byDragId[activeDragId] ?? tree.byId[activeDragId] : null;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => {
    if (controlledCollapsed) return;
    setLocalCollapsed((current) => {
      const valid = new Set(defaultCollapsedIds);
      if (current.size === 0 && valid.size > 0) return valid;
      return current;
    });
  }, [controlledCollapsed, defaultCollapsedIds]);

  function toggleNode(id: string) {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    if (!controlledCollapsed) setLocalCollapsed(next);
    onCollapsedChange?.([...next]);
  }

  function updateProjection(event: DragMoveEvent | DragEndEvent): DropProjection | null {
    const over = event.over;
    const rect = latestRect(event);
    if (!over || !rect || !activeDragId) {
      projectionRef.current = null;
      setProjection(null);
      return null;
    }
    const next = getDropProjection({
      activeId: activeDragId,
      overId: String(over.id),
      overRect: rect.overRect,
      pointerY: rect.pointerY,
      pointerX: rect.pointerX,
      nodes: tree,
    });
    projectionRef.current = next;
    setProjection(next);
    return next;
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveDragId(String(event.active.id));
    projectionRef.current = null;
    setProjection(null);
  }

  function handleDragMove(event: DragMoveEvent) {
    updateProjection(event);
  }

  function handleDragEnd(event: DragEndEvent) {
    const next = updateProjection(event) ?? projectionRef.current;
    if (next?.canDrop) onMoveNode?.(next);
    setActiveDragId(null);
    projectionRef.current = null;
    setProjection(null);
  }

  function handleDragCancel() {
    setActiveDragId(null);
    projectionRef.current = null;
    setProjection(null);
  }

  function handleQuery(event: ChangeEvent<HTMLInputElement>) {
    setQuery(event.target.value);
  }

  const dropIntents = projection ? { [projection.targetId]: projection.intent } : {};
  const projectCount = workspaces.length;
  const createProject = onCreateProject ?? onCreateWorkspace;

  return (
    <aside aria-label={title} className={classes(styles.panel, className)} style={style}>
      <header className={styles.header}>
        <div className={styles.headerTop}>
          <div className={styles.titleCluster}>
            <span aria-hidden="true" className={styles.mark}><Folder size={13} /></span>
            <h2 className={styles.title}>{title}</h2>
          </div>
        </div>
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
        <DndContext collisionDetection={closestCenter} onDragCancel={handleDragCancel} onDragEnd={handleDragEnd} onDragMove={handleDragMove} onDragStart={handleDragStart} sensors={sensors}>
          <ProjectTree
            activeTerminalId={activeTerminalId}
            activeWorkspaceId={activeWorkspaceId}
            activeContainerId={activeContainerId}
            activePaneId={activePaneId}
            branches={branches}
            contextUsage={contextUsage}
            containerVisibility={containerVisibility}
            dropIntents={dropIntents}
            exited={exited}
            groups={groups}
            expandedIds={expandedIds}
            notifications={notifications}
            onContextMenu={onContextMenu}
            onCreateAgent={onCreateAgent}
            onCreateGroup={onCreateGroup}
            onCreateProject={createProject}
            onFocus={onFocus}
            onHideContainer={onHideContainer}
            onHideWorkspace={onHideWorkspace}
            onMoveNode={onMoveNode}
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
          <DragOverlay dropAnimation={null}>
            {activeNode ? <div className={styles.dragOverlay}><span aria-hidden="true"><Folder size={14} /></span><span>{overlayLabel(activeNode)}</span><span className={styles.dragOverlayKind}>{activeNode.kind}</span></div> : null}
          </DragOverlay>
        </DndContext>
        {emptyState && workspaces.length === 0 ? emptyState : null}
      </div> : selectedActivity === "files" && loadFiles ? <NavigatorFilesView activeWorkspaceId={activeWorkspaceId} loadFiles={loadFiles} onSelectWorkspace={onOpenWorkspace} workspaces={workspaces} /> : selectedActivity === "git" && loadGitStatus ? <NavigatorGitView activeWorkspaceId={activeWorkspaceId} loadGitStatus={loadGitStatus} onSelectWorkspace={onOpenWorkspace} workspaces={workspaces} /> : <div className={styles.integrationView}><div className={styles.integrationEmpty}>Esta atividade não está disponível.</div></div>}
      <footer className={styles.footer}>
        <span>{projectCount} projeto{projectCount === 1 ? "" : "s"}</span>
        {createProject ? <button className={styles.footerAction} onClick={() => createProject(null)} type="button"><Plus aria-hidden="true" size={12} /> Novo projeto</button> : null}
      </footer>
    </aside>
  );
}
