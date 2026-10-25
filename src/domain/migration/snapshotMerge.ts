import type { Pane, Project, TerminalTab, Workspace, WorkspaceContainer, WorkspaceSnapshotV2 } from "../workspace.model";
import { uniqueStrings } from "../../lib/collections/uniqueStrings";
import { DOMAIN_SNAPSHOT_VERSION, runtimeTab, uniqueId, type ActiveSelection, type RuntimeTab } from "./snapshotReaders";
import { mergeLayout } from "./workspaceLayout";
import { migrateLegacyWorkspaces, type LegacyMigrationOptions } from "./legacyMigration";
import { normalizeSnapshotV2 } from "./snapshotNormalize";

export interface SnapshotMergeOptions extends LegacyMigrationOptions {
  /** Visibility is UI state and therefore survives a backend refresh. */
  containerVisibility?: Readonly<Record<string, boolean>>;
}

function findOldTab(
  incoming: TerminalTab,
  oldById: ReadonlyMap<string, TerminalTab>,
  oldByPty: ReadonlyMap<string, TerminalTab>,
): TerminalTab | null {
  const direct = oldById.get(incoming.id);
  if (direct && (!incoming.ptyId || !direct.ptyId || direct.ptyId === incoming.ptyId)) {
    return direct;
  }
  if (incoming.ptyId) return oldByPty.get(incoming.ptyId) ?? null;
  return null;
}

function uniqueStableId(preferred: string, fallback: string, used: Set<string>): string {
  return uniqueId(preferred, fallback, used);
}

interface SnapshotMerge {
  incoming: WorkspaceSnapshotV2;
  old: WorkspaceSnapshotV2;
  containerVisibility: Readonly<Record<string, boolean>> | undefined;
  oldProjectById: Map<string, Project>;
  oldPaneById: Map<string, Pane>;
  oldTabById: Map<string, TerminalTab>;
  oldTabByPty: Map<string, TerminalTab>;
  incomingProjectById: Map<string, Project>;
  incomingPaneById: Map<string, Pane>;
  incomingTabById: Map<string, TerminalTab>;
  usedPaneIds: Set<string>;
  usedTabIds: Set<string>;
  finalTabs: TerminalTab[];
  finalPanesById: Map<string, Pane>;
  finalTabIdByIncomingId: Map<string, string>;
  finalPaneIdByIncomingId: Map<string, string>;
  finalPaneIdByOldId: Map<string, string>;
  finalTabIdByOldId: Map<string, string>;
}

interface TabPlacement {
  project: Project;
  pane: Pane;
  tab: TerminalTab;
}

interface PanePlacement {
  incomingPane: Pane;
  projectId: string;
  containerId: string;
  preferredId: string;
  oldPane: Pane | null;
}

interface ProjectMerge {
  project: Project;
  panes: Pane[];
  oldContainers: WorkspaceContainer[];
  incomingContainers: WorkspaceContainer[];
  validPaneIds: Set<string>;
}

interface ContainerSlot {
  containerIndex: number;
  containerId: string;
  assignedPaneIds: ReadonlySet<string>;
}

interface MergedEntities {
  projects: Project[];
  containers: WorkspaceContainer[];
  panes: Pane[];
}


function firstTabByPty(tabs: readonly TerminalTab[]): Map<string, TerminalTab> {
  const tabByPty = new Map<string, TerminalTab>();
  for (const tab of tabs) {
    if (tab.ptyId && !tabByPty.has(tab.ptyId)) tabByPty.set(tab.ptyId, tab);
  }
  return tabByPty;
}

function createSnapshotMerge(
  incoming: WorkspaceSnapshotV2,
  old: WorkspaceSnapshotV2,
  options: SnapshotMergeOptions,
): SnapshotMerge {
  return {
    incoming,
    old,
    containerVisibility: options.containerVisibility,
    oldProjectById: new Map(old.projects.map((project) => [project.id, project])),
    oldPaneById: new Map(old.panes.map((pane) => [pane.id, pane])),
    oldTabById: new Map(old.tabs.map((tab) => [tab.id, tab])),
    oldTabByPty: firstTabByPty(old.tabs),
    incomingProjectById: new Map(incoming.projects.map((project) => [project.id, project])),
    incomingPaneById: new Map(incoming.panes.map((pane) => [pane.id, pane])),
    incomingTabById: new Map(incoming.tabs.map((tab) => [tab.id, tab])),
    usedPaneIds: new Set<string>(),
    usedTabIds: new Set<string>(),
    finalTabs: [],
    finalPanesById: new Map<string, Pane>(),
    finalTabIdByIncomingId: new Map<string, string>(),
    finalPaneIdByIncomingId: new Map<string, string>(),
    finalPaneIdByOldId: new Map<string, string>(),
    finalTabIdByOldId: new Map<string, string>(),
  };
}

function ensureMergedPane(merge: SnapshotMerge, placement: PanePlacement): Pane {
  const existing = merge.finalPanesById.get(placement.preferredId);
  if (existing) return existing;
  const id = uniqueStableId(placement.preferredId, placement.incomingPane.id, merge.usedPaneIds);
  const pane: Pane = {
    ...(placement.oldPane ?? placement.incomingPane),
    id,
    projectId: placement.projectId,
    containerId: placement.containerId,
    tabIds: [],
    activeTabId: null,
    layout: mergeLayout(
      placement.oldPane?.layout,
      placement.incomingPane.layout,
      new Set<string>(),
      merge.incoming.layout,
    ),
  };
  merge.finalPanesById.set(id, pane);
  return pane;
}

function mergedPaneFor(merge: SnapshotMerge, placement: TabPlacement, oldTab: TerminalTab | null): Pane {
  const { project: incomingProject, pane: incomingPane } = placement;
  const isIncomingPlacementExplicit = runtimeTab(placement.tab).placementExplicit === true;
  const oldPane = oldTab?.paneId ? merge.oldPaneById.get(oldTab.paneId) ?? null : null;
  const directOldPane = merge.oldPaneById.get(incomingPane.id) ?? null;
  const preferredPaneId =
    (isIncomingPlacementExplicit && incomingPane.id) ||
    (oldPane?.projectId === incomingProject.id ? oldPane.id : null) ||
    (directOldPane?.projectId === incomingProject.id ? directOldPane.id : null) ||
    incomingPane.id;
  const finalPane = ensureMergedPane(merge, {
    incomingPane,
    projectId: incomingProject.id,
    containerId: "",
    preferredId: preferredPaneId,
    oldPane: isIncomingPlacementExplicit ? directOldPane : oldPane,
  });
  merge.finalPaneIdByIncomingId.set(incomingPane.id, finalPane.id);
  if (oldPane) merge.finalPaneIdByOldId.set(oldPane.id, finalPane.id);
  if (directOldPane) merge.finalPaneIdByOldId.set(directOldPane.id, finalPane.id);
  return finalPane;
}

function mergedTab(
  incomingTab: TerminalTab,
  oldTab: TerminalTab | null,
  ids: { id: string; paneId: string },
): RuntimeTab {
  const incomingRuntime = runtimeTab(incomingTab);
  const oldRuntime = oldTab ? runtimeTab(oldTab) : null;
  return {
    ...incomingTab,
    id: ids.id,
    paneId: ids.paneId,
    orphaned: incomingTab.orphaned,
    ...(oldRuntime?.suspended !== undefined && incomingRuntime.suspended === undefined
      ? { suspended: oldRuntime.suspended }
      : {}),
    ...(oldRuntime?.groupId !== undefined && incomingRuntime.groupId === undefined
      ? { groupId: oldRuntime.groupId }
      : {}),
  };
}

function mergeIncomingTab(merge: SnapshotMerge, placement: TabPlacement): void {
  const incomingTab = placement.tab;
  const oldTab = findOldTab(incomingTab, merge.oldTabById, merge.oldTabByPty);
  const finalPane = mergedPaneFor(merge, placement, oldTab);
  const preferredTabId = oldTab?.id ?? incomingTab.id;
  const finalTabId = uniqueStableId(preferredTabId, incomingTab.id, merge.usedTabIds);
  merge.finalTabIdByIncomingId.set(incomingTab.id, finalTabId);
  if (oldTab) merge.finalTabIdByOldId.set(oldTab.id, finalTabId);
  merge.finalTabs.push(mergedTab(incomingTab, oldTab, { id: finalTabId, paneId: finalPane.id }));
  finalPane.tabIds.push(finalTabId);
}

function mergeIncomingTabs(merge: SnapshotMerge): void {
  for (const project of merge.incoming.projects) {
    for (const incomingPaneId of project.paneIds) {
      const pane = merge.incomingPaneById.get(incomingPaneId);
      if (!pane) continue;
      const incomingTabs = pane.tabIds
        .map((tabId) => merge.incomingTabById.get(tabId))
        .filter((tab): tab is TerminalTab => Boolean(tab));
      for (const tab of incomingTabs) mergeIncomingTab(merge, { project, pane, tab });
    }
  }
}

// Orphan tabs have no live PTY identity. Retain them as recoverable records;
// a tab with an identity absent from the authoritative backend projection is
// stale and is intentionally not reintroduced after a refresh.
function retainOrphanTabs(merge: SnapshotMerge): void {
  for (const oldTab of merge.old.tabs) {
    if (oldTab.ptyId || merge.finalTabIdByOldId.has(oldTab.id)) continue;
    const oldRuntime = runtimeTab(oldTab);
    const orphan: RuntimeTab = {
      ...oldTab,
      id: uniqueStableId(oldTab.id, `orphan-tab-${merge.finalTabs.length + 1}`, merge.usedTabIds),
      orphaned: true,
      ...(oldRuntime.suspended !== undefined ? { suspended: oldRuntime.suspended } : {}),
    };
    merge.finalTabs.push(orphan);
    if (orphan.paneId) {
      const pane = merge.finalPanesById.get(orphan.paneId);
      if (pane && !pane.tabIds.includes(orphan.id)) pane.tabIds.push(orphan.id);
    }
  }
}

function finalizeMergedPane(merge: SnapshotMerge, paneId: string, pane: Pane): void {
  const incomingPane = merge.incomingPaneById.get(
    [...merge.finalPaneIdByIncomingId.entries()].find(([, finalId]) => finalId === paneId)?.[0] ?? "",
  );
  const oldPane = merge.oldPaneById.get(paneId);
  const validTabIds = new Set(merge.finalTabs.filter((tab) => tab.paneId === paneId).map((tab) => tab.id));
  const oldActiveTab = oldPane?.activeTabId
    ? merge.finalTabIdByOldId.get(oldPane.activeTabId) ?? oldPane.activeTabId
    : null;
  const incomingActiveTab = incomingPane?.activeTabId
    ? merge.finalTabIdByIncomingId.get(incomingPane.activeTabId) ?? incomingPane.activeTabId
    : null;
  pane.tabIds = uniqueStrings([
    ...(oldPane?.tabIds ?? []).map((tabId) => merge.finalTabIdByOldId.get(tabId) ?? tabId),
    ...pane.tabIds,
  ]).filter((tabId) => validTabIds.has(tabId));
  pane.activeTabId =
    (oldActiveTab && validTabIds.has(oldActiveTab) ? oldActiveTab : null) ||
    (incomingActiveTab && validTabIds.has(incomingActiveTab) ? incomingActiveTab : null) ||
    pane.tabIds[0] ||
    null;
  pane.layout = mergeLayout(
    oldPane?.layout,
    incomingPane?.layout ?? pane.layout,
    validTabIds,
    merge.incoming.layout,
  );
}

function panesByIncomingProject(merge: SnapshotMerge, finalPanes: readonly Pane[]): Map<string, Pane[]> {
  const finalPanesByProject = new Map<string, Pane[]>();
  for (const pane of finalPanes) {
    const projectId = pane.projectId;
    if (!projectId || !merge.incomingProjectById.has(projectId)) continue;
    const list = finalPanesByProject.get(projectId) ?? [];
    list.push(pane);
    finalPanesByProject.set(projectId, list);
  }
  return finalPanesByProject;
}

function projectMergeFor(
  merge: SnapshotMerge,
  project: Project,
  panesByProject: ReadonlyMap<string, Pane[]>,
): ProjectMerge {
  const panes = panesByProject.get(project.id) ?? [];
  return {
    project,
    panes,
    oldContainers: merge.old.containers.filter((container) => container.projectId === project.id),
    incomingContainers: merge.incoming.containers.filter((container) => container.projectId === project.id),
    validPaneIds: new Set(panes.map((pane) => pane.id)),
  };
}

function resolveMergedPaneId(merge: SnapshotMerge, paneId: string): string {
  return merge.finalPaneIdByIncomingId.get(paneId) ?? merge.finalPaneIdByOldId.get(paneId) ?? paneId;
}

function mergedContainerPaneIds(merge: SnapshotMerge, projectMerge: ProjectMerge, slot: ContainerSlot): string[] {
  const oldContainer = projectMerge.oldContainers.find((container) => container.id === slot.containerId);
  const incomingContainer = projectMerge.incomingContainers.find((container) => container.id === slot.containerId);
  const declaredPaneIds = uniqueStrings([
    ...(oldContainer?.paneIds ?? []).map((paneId) => resolveMergedPaneId(merge, paneId)),
    ...(incomingContainer?.paneIds ?? []).map((paneId) => resolveMergedPaneId(merge, paneId)),
  ]).filter((paneId) => projectMerge.validPaneIds.has(paneId) && !slot.assignedPaneIds.has(paneId));
  if (slot.containerIndex !== 0) return declaredPaneIds;
  return uniqueStrings([
    ...declaredPaneIds,
    ...projectMerge.panes.map((pane) => pane.id).filter((paneId) => !slot.assignedPaneIds.has(paneId)),
  ]);
}

function mergedContainer(
  merge: SnapshotMerge,
  projectMerge: ProjectMerge,
  slot: { containerId: string; paneIds: string[] },
): WorkspaceContainer {
  const { containerId, paneIds } = slot;
  const projectId = projectMerge.project.id;
  const oldContainer = projectMerge.oldContainers.find((container) => container.id === containerId);
  const incomingContainer = projectMerge.incomingContainers.find((container) => container.id === containerId);
  const base = oldContainer ?? incomingContainer ?? {
    id: containerId,
    projectId,
    paneIds: [],
    layout: merge.incoming.layout,
    visible: true,
    collapsed: false,
    closed: false,
    fullscreen: false,
  };
  const container: WorkspaceContainer = {
    ...base,
    id: containerId,
    projectId,
    paneIds,
    activePaneId:
      base.activePaneId && paneIds.includes(base.activePaneId)
        ? base.activePaneId
        : (paneIds[0] ?? null),
    layout: mergeLayout(
      oldContainer?.layout,
      incomingContainer?.layout,
      new Set(paneIds),
      merge.incoming.layout,
    ),
  };
  const requestedVisibility = merge.containerVisibility?.[container.id];
  if (requestedVisibility !== undefined) {
    container.visible = requestedVisibility;
    container.closed = !requestedVisibility;
  }
  return container;
}

function mergeProjectContainers(merge: SnapshotMerge, projectMerge: ProjectMerge): WorkspaceContainer[] {
  const orderedContainerIds = uniqueStrings([
    ...projectMerge.oldContainers.map((container) => container.id),
    ...projectMerge.incomingContainers.map((container) => container.id),
    `container-${projectMerge.project.id}`,
  ]);
  const assignedPaneIds = new Set<string>();
  const containers: WorkspaceContainer[] = [];
  for (const [containerIndex, containerId] of orderedContainerIds.entries()) {
    const paneIds = mergedContainerPaneIds(merge, projectMerge, { containerIndex, containerId, assignedPaneIds });
    paneIds.forEach((paneId) => assignedPaneIds.add(paneId));
    containers.push(mergedContainer(merge, projectMerge, { containerId, paneIds }));
  }
  return containers;
}

function mergedProject(
  merge: SnapshotMerge,
  projectMerge: ProjectMerge,
  containers: readonly WorkspaceContainer[],
): Project {
  const incomingProject = projectMerge.project;
  const oldProject = merge.oldProjectById.get(incomingProject.id);
  const paneIds = projectMerge.panes.map((pane) => pane.id);
  const containerIds = containers.map((container) => container.id);
  const oldActivePaneId = oldProject?.activePaneId;
  const incomingActivePaneId = incomingProject.activePaneId
    ? merge.finalPaneIdByIncomingId.get(incomingProject.activePaneId)
    : undefined;
  const activePaneId =
    (oldActivePaneId && paneIds.includes(oldActivePaneId) ? oldActivePaneId : null) ||
    (incomingActivePaneId && paneIds.includes(incomingActivePaneId) ? incomingActivePaneId : null) ||
    paneIds[0] ||
    null;
  const activeContainerId =
    (oldProject?.activeContainerId && containerIds.includes(oldProject.activeContainerId)
      ? oldProject.activeContainerId
      : null) ||
    containerIds[0] ||
    null;
  return {
    ...incomingProject,
    paneIds,
    containerIds,
    activePaneId,
    activeContainerId,
    layout: mergeLayout(
      oldProject?.layout,
      incomingProject.layout,
      new Set([...paneIds, ...containerIds]),
      merge.incoming.layout,
    ),
  };
}

function mergeProjects(merge: SnapshotMerge, finalPanes: readonly Pane[]): Omit<MergedEntities, "panes"> {
  const panesByProject = panesByIncomingProject(merge, finalPanes);
  const projects: Project[] = [];
  const containers: WorkspaceContainer[] = [];
  for (const incomingProject of merge.incoming.projects) {
    const projectMerge = projectMergeFor(merge, incomingProject, panesByProject);
    const projectContainers = mergeProjectContainers(merge, projectMerge);
    containers.push(...projectContainers);
    projects.push(mergedProject(merge, projectMerge, projectContainers));
  }
  return { projects, containers };
}

function assignPaneContainers(containers: readonly WorkspaceContainer[], panes: readonly Pane[]): void {
  for (const container of containers) {
    for (const paneId of container.paneIds) {
      const pane = panes.find((candidate) => candidate.id === paneId);
      if (pane) pane.containerId = container.id;
    }
  }
}

function selectMergedActiveIds(merge: SnapshotMerge, entities: MergedEntities): ActiveSelection {
  const { old } = merge;
  const finalProjectIds = new Set(entities.projects.map((project) => project.id));
  const finalProjectById = new Map(entities.projects.map((project) => [project.id, project]));
  const finalTabsById = new Map(merge.finalTabs.map((tab) => [tab.id, tab]));
  const activeProjectId =
    (old.activeProjectId && finalProjectIds.has(old.activeProjectId) ? old.activeProjectId : null) ||
    entities.projects[0]?.id ||
    null;
  const activeProject = activeProjectId ? finalProjectById.get(activeProjectId) ?? null : null;
  const allPaneIds = new Set(entities.panes.map((pane) => pane.id));
  const allContainerIds = new Set(entities.containers.map((container) => container.id));
  const activeContainerId =
    (old.activeContainerId && allContainerIds.has(old.activeContainerId) ? old.activeContainerId : null) ||
    activeProject?.activeContainerId ||
    entities.containers[0]?.id ||
    null;
  const activePaneId =
    (old.activePaneId && allPaneIds.has(old.activePaneId) ? old.activePaneId : null) ||
    activeProject?.activePaneId ||
    entities.panes[0]?.id ||
    null;
  const activePane = entities.panes.find((pane) => pane.id === activePaneId) ?? null;
  const activeTabId =
    (old.activeTabId && finalTabsById.has(old.activeTabId) &&
    activePane?.tabIds.includes(old.activeTabId)
      ? old.activeTabId
      : null) ||
    activePane?.activeTabId ||
    null;
  return { activeProjectId, activeContainerId, activePaneId, activeTabId };
}

/**
 * Merge a fresh backend projection into the persisted v2 domain snapshot.
 *
 * The workspace API is authoritative for process metadata (name, cwd,
 * command, placement, suspension and membership), while the snapshot owns
 * visual state (container visibility, pane/tab ordering, active selections
 * and layout). Matching first by tab/pane ids and then by PTY id lets a
 * refresh become idempotent even while the backend is still catching up with
 * a spawn or placement command.
 */
export function mergeWorkspaceSnapshot(
  input: readonly Workspace[] | unknown,
  previous: WorkspaceSnapshotV2 | null | undefined,
  options: SnapshotMergeOptions = {},
): WorkspaceSnapshotV2 {
  const incoming = migrateLegacyWorkspaces(input, options);
  if (!previous) {
    return normalizeSnapshotV2(incoming);
  }

  const old = normalizeSnapshotV2(previous);
  const merge = createSnapshotMerge(incoming, old, options);
  mergeIncomingTabs(merge);
  retainOrphanTabs(merge);
  for (const [paneId, pane] of merge.finalPanesById) finalizeMergedPane(merge, paneId, pane);
  const finalPanes = [...merge.finalPanesById.values()];
  const { projects: finalProjects, containers: finalContainers } = mergeProjects(merge, finalPanes);
  assignPaneContainers(finalContainers, finalPanes);

  const finalProjectIds = new Set(finalProjects.map((project) => project.id));
  const groups = old.groups.map((group) => ({
    ...group,
    projectIds: group.projectIds.filter((projectId) => finalProjectIds.has(projectId)),
  }));
  const activeSelection = selectMergedActiveIds(merge, {
    projects: finalProjects,
    containers: finalContainers,
    panes: finalPanes,
  });
  const allContainerIds = new Set(finalContainers.map((container) => container.id));

  return normalizeSnapshotV2({
    ...old,
    version: DOMAIN_SNAPSHOT_VERSION,
    projects: finalProjects,
    groups,
    containers: finalContainers,
    panes: finalPanes,
    tabs: merge.finalTabs,
    orphanedTabIds: merge.finalTabs.filter((tab) => tab.orphaned).map((tab) => tab.id),
    activeProjectId: activeSelection.activeProjectId,
    activeGroupId: old.activeGroupId && groups.some((group) => group.id === old.activeGroupId)
      ? old.activeGroupId
      : null,
    activeContainerId: activeSelection.activeContainerId,
    activePaneId: activeSelection.activePaneId,
    activeTabId: activeSelection.activeTabId,
    layout: mergeLayout(old.layout, incoming.layout, allContainerIds, incoming.layout),
  });
}
