import { deriveAgentStatus } from "../../domain/agentStatus";
import { normalizeSearchText } from "../../lib/text/normalizeSearchText";
import type { McpAgentState } from "../../domain/mcp.model";
import type { TerminalMeta } from "../../domain/terminal.model";
import type { Pane, PersistedWorkspaceContainer, PersistedWorkspacePane, PersistedWorkspaceTab, TerminalTab, Workspace, WorkspaceContainer, WorkspaceGroup, WorkspaceSnapshotV2 } from "../../domain/workspace.model";
import {
  type FlatNavigatorNode,
  type NavigatorAgentNode,
  type NavigatorBranch,
  type NavigatorContainerNode,
  type NavigatorGroupNode,
  type NavigatorNode,
  type NavigatorPaneNode,
  type NavigatorProjectNode,
  type NavigatorStatus,
  type NavigatorStatusMaps,
  type NavigatorTree,
} from "./types";

export interface BuildNavigatorTreeOptions {
  groups?: readonly WorkspaceGroup[];
  snapshot?: WorkspaceSnapshotV2 | null;
  exited?: Readonly<Record<string, number | null>>;
  notifications?: Readonly<Record<string, number | readonly unknown[] | undefined>>;
  contextUsage?: Readonly<Record<string, number>>;
  statuses?: NavigatorStatusMaps;
  branches?: readonly NavigatorBranch[];
  containerVisibility?: Readonly<Record<string, boolean>>;
  /** Display labels per terminal id (task title, numbered kind, optional name). */
  agentLabels?: Readonly<Record<string, { primary: string; tag: string } | undefined>>;
  /** Put agents directly under their project, skipping container and pane levels. */
  shouldFlatten?: boolean;
  /** State the agents reported through their hooks, by terminal id. */
  reported?: Readonly<Record<string, McpAgentState>>;
}

const EMPTY_GROUPS: readonly WorkspaceGroup[] = [];
const EMPTY_BRANCHES: readonly NavigatorBranch[] = [];

function notificationCount(
  notifications: Readonly<Record<string, number | readonly unknown[] | undefined>>,
  id: string,
): number {
  const value = notifications[id];
  return typeof value === "number" ? Math.max(0, value) : value?.length ?? 0;
}

function branchMatches(branch: NavigatorBranch, workspaceId: string, terminalId?: string): boolean {
  return (
    branch.terminalId === terminalId ||
    branch.agentId === terminalId ||
    branch.workspaceId === workspaceId ||
    branch.projectId === workspaceId
  );
}

function agentNodeStatus(
  terminalId: string,
  source: { suspended?: boolean },
  options: BuildNavigatorTreeOptions,
): NavigatorStatus {
  const explicit = options.statuses?.agents?.[terminalId];
  if (explicit) return explicit;
  return deriveAgentStatus({
    isSuspended: source.suspended,
    hasExited: terminalId in (options.exited ?? {}),
    notifications: notificationCount(options.notifications ?? {}, terminalId),
    contextUsed: options.contextUsage?.[terminalId],
    reported: options.reported?.[terminalId],
  });
}

const STATUS_RANK: Readonly<Record<NavigatorStatus, number>> = {
  attention: 4,
  working: 3,
  idle: 2.5,
  suspended: 2,
  exited: 1,
};

function statusRank(status: NavigatorStatus): number {
  return STATUS_RANK[status];
}

function statusForProject(
  workspace: Workspace,
  agents: readonly NavigatorAgentNode[],
  options: BuildNavigatorTreeOptions,
): NavigatorStatus {
  const explicit = options.statuses?.projects?.[workspace.id];
  if (explicit) return explicit;
  if (agents.length > 0) {
    return agents.reduce<NavigatorStatus>(
      (best, agent) => (statusRank(agent.status) > statusRank(best) ? agent.status : best),
      "exited",
    );
  }
  return workspace.archived ? "suspended" : "working";
}

function statusForGroup(
  group: WorkspaceGroup,
  projects: readonly NavigatorProjectNode[],
  options: BuildNavigatorTreeOptions,
): NavigatorStatus {
  const explicit = options.statuses?.groups?.[group.id];
  if (explicit) return explicit;
  if (group.suspended) return "suspended";
  return projects.reduce<NavigatorStatus>(
    (best, project) => (statusRank(project.status) > statusRank(best) ? project.status : best),
    projects.length > 0 ? "exited" : "working",
  );
}

const EMPTY_LAYOUT = { mode: "auto" as const };

function normalizeContainer(
  source: WorkspaceContainer | PersistedWorkspaceContainer,
  workspaceId: string,
): WorkspaceContainer {
  const paneIds = [...source.paneIds];
  return {
    id: source.id,
    projectId: source.projectId || workspaceId,
    paneIds,
    layout: source.layout ?? { ...EMPTY_LAYOUT, itemIds: paneIds },
    activePaneId: source.activePaneId ?? paneIds[0] ?? null,
    internalLayout: source.internalLayout,
    size: source.size,
    visible: source.visible !== false,
    collapsed: source.collapsed === true,
    closed: source.closed === true,
    fullscreen: source.fullscreen === true,
  };
}

function normalizePane(
  source: Pane | PersistedWorkspacePane,
  workspaceId: string,
  containerId: string,
): Pane {
  const tabIds = "tabIds" in source
    ? [...source.tabIds]
    : (source.tabs ?? []).map((tab) => tab.id);
  return {
    id: source.id,
    projectId: workspaceId,
    containerId: source.containerId ?? containerId,
    tabIds,
    activeTabId: source.activeTabId ?? tabIds[0] ?? null,
    layout: source.layout ?? { ...EMPTY_LAYOUT, itemIds: tabIds },
  };
}

function tabFromPersisted(tab: PersistedWorkspaceTab): TerminalTab {
  return {
    id: tab.id,
    paneId: null,
    ptyId: tab.ptyId ?? tab.sessionId ?? null,
    command: tab.name ?? tab.id,
    cwd: tab.cwd ?? "",
    width: null,
    title: tab.name ?? tab.id,
    orphaned: false,
  };
}

interface WorkspaceHierarchy {
  containers: WorkspaceContainer[];
  panes: Pane[];
  tabs: Map<string, TerminalTab>;
}

function hierarchyForWorkspace(
  workspace: Workspace,
  options: BuildNavigatorTreeOptions,
): WorkspaceHierarchy {
  const snapshot = options.snapshot;
  const snapshotProject = snapshot?.projects.find((project) => project.id === workspace.id);
  const rawContainers = snapshot
    ? snapshot.containers.filter((container) => container.projectId === workspace.id)
    : (workspace.containers ?? []);
  const containers = rawContainers.map((container) => normalizeContainer(container, workspace.id));
  const containerIds = new Set(containers.map((container) => container.id));
  const rawPanes = snapshot
    ? snapshot.panes.filter((pane) =>
      pane.projectId === workspace.id || (pane.containerId !== null && containerIds.has(pane.containerId)),
    )
    : (workspace.panes ?? []);
  const panes = rawPanes.map((pane) => normalizePane(
    pane,
    workspace.id,
    pane.containerId ?? containers[0]?.id ?? `${workspace.id}:container`,
  ));
  const tabs = new Map<string, TerminalTab>();
  if (snapshot) {
    snapshot.tabs.forEach((tab) => tabs.set(tab.id, tab));
  } else {
    (workspace.panes ?? []).forEach((pane) => {
      (pane.tabs ?? []).forEach((tab) => tabs.set(tab.id, tabFromPersisted(tab)));
    });
  }

  // Legacy workspaces sometimes carry pane metadata without a copied
  // container list. Keep the hierarchy truthful by giving those panes a
  // stable synthetic visual container rather than flattening them into the
  // project row.
  if (containers.length === 0 && panes.length > 0) {
    const id = `${workspace.id}:container`;
    containers.push({
      id,
      projectId: workspace.id,
      paneIds: panes.map((pane) => pane.id),
      layout: { ...EMPTY_LAYOUT, itemIds: panes.map((pane) => pane.id) },
      activePaneId: panes[0]?.id ?? null,
      visible: true,
      collapsed: false,
      closed: false,
      fullscreen: false,
    });
  }
  if (containers.length > 0 && panes.length === 0 && snapshotProject) {
    // A partially migrated snapshot may still expose project pane ids while
    // the pane records arrive in a later refresh. Do not lose that location.
    for (const paneId of snapshotProject.paneIds) {
      panes.push(normalizePane({
        id: paneId,
        projectId: workspace.id,
        containerId: containers[0].id,
        tabIds: [],
        activeTabId: null,
        layout: { ...EMPTY_LAYOUT, itemIds: [] },
      }, workspace.id, containers[0].id));
    }
    containers[0].paneIds = panes.map((pane) => pane.id);
  }
  return { containers, panes, tabs };
}

function indexTree(roots: readonly NavigatorNode[]): NavigatorTree {
  const byId: Record<string, NavigatorNode> = {};
  const ungrouped: NavigatorProjectNode[] = [];

  const visit = (node: NavigatorNode) => {
    byId[node.id] = node;
    if (node.kind === "agent" && node.tabId) byId[node.terminalId] = node;
    if (node.kind === "project" && node.parentId === null) ungrouped.push(node);
    node.children.forEach(visit);
  };
  roots.forEach(visit);
  return { roots: [...roots], byId, ungrouped };
}

interface AgentSlot {
  parentId: string;
  tabId?: string;
  paneId?: string;
  containerId?: string;
}

interface ProjectBuild {
  workspace: Workspace;
  options: BuildNavigatorTreeOptions;
  hierarchy: WorkspaceHierarchy;
  terminalById: ReadonlyMap<string, TerminalMeta>;
  usedTerminalIds: Set<string>;
}

interface PaneSlot {
  container: WorkspaceContainer;
  fallbackTerminals: readonly TerminalMeta[];
}

interface GroupIndex {
  groups: readonly WorkspaceGroup[];
  groupNodes: ReadonlyMap<string, NavigatorGroupNode>;
  projectsByGroup: ReadonlyMap<string, NavigatorProjectNode[]>;
  projectNodes: readonly NavigatorProjectNode[];
}

function aggregateStatus(nodes: readonly NavigatorNode[]): NavigatorStatus {
  return nodes.reduce<NavigatorStatus>((best, node) => statusRank(node.status) > statusRank(best) ? node.status : best, nodes.length > 0 ? "exited" : "working");
}

function makeGroupNode(group: WorkspaceGroup): NavigatorGroupNode {
  return {
    id: group.id,
    kind: "group",
    name: group.name,
    parentId: group.parentGroupId && group.parentGroupId !== group.id ? group.parentGroupId : null,
    depth: 0,
    children: [],
    status: group.suspended ? "suspended" : "working",
    count: 0,
    source: group,
    projectIds: [],
    isSuspended: group.suspended,
  };
}

function makeAgent(build: ProjectBuild, terminal: TerminalMeta, slot: AgentSlot): NavigatorAgentNode {
  const { workspace, options } = build;
  const branches = options.branches ?? EMPTY_BRANCHES;
  const { parentId, tabId, paneId, containerId } = slot;
  return {
    id: tabId ?? terminal.id,
    kind: "agent",
    name: options.agentLabels?.[terminal.id]?.primary ?? (terminal.command || terminal.id),
    tag: options.agentLabels?.[terminal.id]?.tag,
    parentId,
    depth: 2,
    children: [],
    status: agentNodeStatus(terminal.id, terminal, options),
    count: 0,
    source: terminal,
    workspaceId: workspace.id,
    terminalId: terminal.id,
    ...(tabId ? { tabId } : {}),
    ...(paneId ? { paneId } : {}),
    ...(containerId ? { containerId } : {}),
    branchIds: branches.filter((branch) => branchMatches(branch, workspace.id, terminal.id)).map((branch) => branch.id),
    contextUsage: options.contextUsage?.[terminal.id] ?? null,
    notifications: notificationCount(options.notifications ?? {}, terminal.id),
  };
}

function terminalForTab(build: ProjectBuild, tab: TerminalTab, paneId: string): TerminalMeta {
  const { workspace, terminalById } = build;
  const terminal = (tab.ptyId ? terminalById.get(tab.ptyId) : undefined)
    ?? terminalById.get(tab.id)
    ?? workspace.terminals.find((candidate) => candidate.tabId === tab.id)
    ?? {
      id: tab.ptyId ?? tab.id,
      command: tab.command || tab.title || tab.id,
      width: tab.width,
      suspended: false,
    };
  build.usedTerminalIds.add(terminal.id);
  return {
    ...terminal,
    paneId,
    tabId: tab.id,
    command: terminal.command || tab.command || tab.title || tab.id,
    width: terminal.width ?? tab.width,
    suspended: terminal.suspended || undefined,
  };
}

function paneAgents(build: ProjectBuild, pane: Pane, slot: PaneSlot): NavigatorAgentNode[] {
  const { container, fallbackTerminals } = slot;
  const tabChildren: NavigatorAgentNode[] = pane.tabIds
    .map((tabId) => build.hierarchy.tabs.get(tabId))
    .filter((tab): tab is TerminalTab => Boolean(tab))
    .map((tab) => makeAgent(build, terminalForTab(build, tab, pane.id), { parentId: pane.id, tabId: tab.id, paneId: pane.id, containerId: container.id }));
  if (tabChildren.length > 0) return tabChildren;
  return fallbackTerminals.map((terminal) => {
    build.usedTerminalIds.add(terminal.id);
    return makeAgent(build, { ...terminal, paneId: pane.id }, { parentId: pane.id, tabId: terminal.tabId ?? undefined, paneId: pane.id, containerId: container.id });
  });
}

function makePane(build: ProjectBuild, pane: Pane, slot: PaneSlot): NavigatorPaneNode {
  const { container } = slot;
  const children = paneAgents(build, pane, slot);
  return {
    id: pane.id,
    kind: "pane",
    name: pane.id,
    parentId: container.id,
    depth: 2,
    children,
    status: aggregateStatus(children),
    count: children.length,
    source: pane,
    workspaceId: build.workspace.id,
    projectId: build.workspace.id,
    containerId: container.id,
    paneId: pane.id,
    tabIds: [...pane.tabIds],
  };
}

function containerPanes(build: ProjectBuild, container: WorkspaceContainer): Pane[] {
  const { workspace, hierarchy } = build;
  const paneIds = container.paneIds.length > 0
    ? container.paneIds
    : hierarchy.panes.filter((pane) => pane.containerId === container.id).map((pane) => pane.id);
  const panes = paneIds
    .map((paneId) => hierarchy.panes.find((pane) => pane.id === paneId))
    .filter((pane): pane is Pane => Boolean(pane));
  if (panes.length > 0 || workspace.terminals.length === 0) return panes;
  return [{
    id: `${container.id}:pane`,
    projectId: workspace.id,
    containerId: container.id,
    tabIds: [],
    activeTabId: null,
    layout: { ...EMPTY_LAYOUT, itemIds: [] },
  } satisfies Pane];
}

function makeContainer(build: ProjectBuild, container: WorkspaceContainer): NavigatorContainerNode {
  const { workspace, hierarchy } = build;
  const effectivePanes = containerPanes(build, container);
  const fallback = hierarchy.containers.length === 1 && effectivePanes.length === 1
    ? workspace.terminals.filter((terminal) => !build.usedTerminalIds.has(terminal.id))
    : [];
  const paneChildren = effectivePanes.map((pane, index) => makePane(
    build,
    pane,
    { container, fallbackTerminals: index === 0 ? fallback : [] },
  ));
  return {
    id: container.id,
    kind: "container",
    name: container.id,
    parentId: workspace.id,
    depth: 1,
    children: paneChildren,
    status: aggregateStatus(paneChildren),
    count: paneChildren.reduce((count, pane) => count + pane.count, 0),
    source: container,
    workspaceId: workspace.id,
    projectId: workspace.id,
    containerId: container.id,
    paneIds: effectivePanes.map((pane) => pane.id),
    isVisible: container.visible && !container.closed,
    isCollapsed: container.collapsed,
    isFullscreen: container.fullscreen,
  };
}

function projectAgents(build: ProjectBuild, structuralChildren: readonly NavigatorContainerNode[]): NavigatorAgentNode[] {
  if (structuralChildren.length > 0) {
    return structuralChildren.flatMap((container) => container.children.flatMap((pane) => pane.children.filter((child): child is NavigatorAgentNode => child.kind === "agent")));
  }
  return build.workspace.terminals.map((terminal) => {
    build.usedTerminalIds.add(terminal.id);
    return makeAgent(build, terminal, { parentId: build.workspace.id });
  });
}

function projectGroupId(workspace: Workspace, index: Pick<GroupIndex, "groups" | "groupNodes">): string | null {
  if (workspace.groupId && index.groupNodes.has(workspace.groupId)) return workspace.groupId;
  return index.groups.find((group) => group.projectIds.includes(workspace.id))?.id ?? null;
}

function makeProject(workspace: Workspace, groupId: string | null, options: BuildNavigatorTreeOptions): NavigatorProjectNode {
  const projectId = workspace.id;
  const build: ProjectBuild = {
    workspace,
    options,
    hierarchy: hierarchyForWorkspace(workspace, options),
    terminalById: new Map(workspace.terminals.map((terminal) => [terminal.id, terminal])),
    usedTerminalIds: new Set<string>(),
  };
  const structuralChildren = build.hierarchy.containers.map((container) => makeContainer(build, container));
  const agents = projectAgents(build, structuralChildren);
  const projectChildren: NavigatorNode[] = options.shouldFlatten
    ? agents.map((agent) => ({ ...agent, parentId: projectId, depth: (groupId ? 1 : 0) + 1 }))
    : structuralChildren.length > 0 ? structuralChildren : agents;
  return {
    id: projectId,
    kind: "project",
    name: workspace.name || workspace.id,
    parentId: groupId,
    depth: groupId ? 1 : 0,
    children: projectChildren,
    status: statusForProject(workspace, agents, options),
    count: agents.length,
    source: workspace,
    workspaceId: workspace.id,
    terminalIds: agents.map((agent) => agent.terminalId),
    isVisible: options.containerVisibility?.[workspace.id] !== false,
  };
}

function groupProjects(child: NavigatorGroupNode | NavigatorProjectNode, projectNodes: readonly NavigatorProjectNode[]): NavigatorProjectNode[] {
  if (child.kind !== "group") return [child];
  return child.projectIds
    .map((id) => projectNodes.find((project) => project.id === id))
    .filter((value): value is NavigatorProjectNode => Boolean(value));
}

function fillGroup(group: WorkspaceGroup, index: GroupIndex, options: BuildNavigatorTreeOptions): void {
  const node = index.groupNodes.get(group.id);
  if (!node) return;
  const childGroups = index.groups
    .filter((candidate) => candidate.parentGroupId === group.id && candidate.id !== group.id)
    .map((candidate) => index.groupNodes.get(candidate.id))
    .filter((candidate): candidate is NavigatorGroupNode => Boolean(candidate));
  const projects = index.projectsByGroup.get(group.id) ?? [];
  const descendants = [...childGroups, ...projects];
  const allProjects = descendants.flatMap((child) => groupProjects(child, index.projectNodes));
  node.children = descendants;
  node.count = allProjects.reduce((count, project) => count + project.count, 0);
  node.status = statusForGroup(group, allProjects, options);
}

function isRootGroup(group: WorkspaceGroup, groupNodes: ReadonlyMap<string, NavigatorGroupNode>): boolean {
  return !group.parentGroupId || !groupNodes.has(group.parentGroupId) || group.parentGroupId === group.id;
}

function rootGroups(index: GroupIndex): NavigatorGroupNode[] {
  return index.groups
    .filter((group) => isRootGroup(group, index.groupNodes))
    .map((group) => index.groupNodes.get(group.id))
    .filter((node): node is NavigatorGroupNode => Boolean(node));
}

function assignDepth(nodes: readonly NavigatorNode[], parentId: string | null, depth: number): void {
  nodes.forEach((node) => {
    node.parentId = parentId;
    node.depth = depth;
    assignDepth(node.children, node.id, depth + 1);
  });
}

/**
 * Converts the legacy workspace/group wire model into one deterministic tree.
 * The model deliberately keeps projects and agents separate from visual containers;
 * hiding a project therefore never removes its terminals from the tree.
 */
export function buildNavigatorTree(
  workspaces: readonly Workspace[],
  options: BuildNavigatorTreeOptions = {},
): NavigatorTree {
  const groups = options.groups ?? EMPTY_GROUPS;
  const groupNodes = new Map(groups.map((group) => [group.id, makeGroupNode(group)]));
  const projectsByGroup = new Map(groups.map((group): [string, NavigatorProjectNode[]] => [group.id, []]));
  const projectNodes: NavigatorProjectNode[] = [];

  for (const workspace of workspaces) {
    const groupId = projectGroupId(workspace, { groups, groupNodes });
    const project = makeProject(workspace, groupId, options);
    projectNodes.push(project);
    if (groupId) {
      projectsByGroup.get(groupId)?.push(project);
      groupNodes.get(groupId)?.projectIds.push(project.id);
    }
  }

  const index: GroupIndex = { groups, groupNodes, projectsByGroup, projectNodes };
  groups.forEach((group) => fillGroup(group, index, options));
  const roots: NavigatorNode[] = [...rootGroups(index), ...projectNodes.filter((project) => project.parentId === null)];
  assignDepth(roots, null, 0);
  return indexTree(roots);
}

function searchableText(node: NavigatorNode): string {
  if (node.kind === "agent") return [node.name, node.source.id, ...node.branchIds].join(" ");
  if (node.kind === "project") return [node.name, node.source.cwd, node.source.id].join(" ");
  return [node.name, node.source.id].join(" ");
}

function cloneVisibleNode(node: NavigatorNode, children: NavigatorNode[]): NavigatorNode {
  return { ...node, children };
}

/** Keeps matching descendants and their path so search never loses context. */
export function filterNavigatorTree(tree: NavigatorTree, query: string): NavigatorTree {
  const needle = normalizeSearchText(query);
  if (!needle) return tree;
  const filter = (node: NavigatorNode): NavigatorNode | null => {
    const children = node.children.map(filter).filter((child): child is NavigatorNode => Boolean(child));
    const isMatch = normalizeSearchText(searchableText(node)).includes(needle);
    if (!isMatch && children.length === 0) return null;
    return cloneVisibleNode(node, isMatch ? node.children : children);
  };
  return indexTree(tree.roots.map(filter).filter((node): node is NavigatorNode => Boolean(node)));
}

export function flattenNavigatorTree(
  treeOrRoots: NavigatorTree | readonly NavigatorNode[],
  expandedIds: ReadonlySet<string> = new Set(),
): FlatNavigatorNode[] {
  const roots = "roots" in treeOrRoots ? treeOrRoots.roots : treeOrRoots;
  const result: FlatNavigatorNode[] = [];
  const visit = (node: NavigatorNode) => {
    result.push({
      id: node.id,
      kind: node.kind,
      name: node.name,
      parentId: node.parentId,
      depth: node.depth,
      hasChildren: node.children.length > 0,
      status: node.status,
      count: node.count,
      node,
    });
    if (node.children.length > 0 && expandedIds.has(node.id)) node.children.forEach(visit);
  };
  roots.forEach(visit);
  return result;
}
