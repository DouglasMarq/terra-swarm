import type { Group, Pane, Project, TerminalTab, WorkspaceContainer, WorkspaceLayout, WorkspaceSnapshotV2 } from "../workspace.model";
import { asRecord } from "../../lib/records/records";
import { uniqueStrings } from "../../lib/collections/uniqueStrings";
import { DOMAIN_SNAPSHOT_VERSION, readArray, readFiniteNumber, readString, uniqueId, type ActiveSelection, type RecordLike, type RuntimeTab } from "./snapshotReaders";
import { normalizeLayout, restrictLayoutItems } from "./workspaceLayout";
import { migrateLegacyWorkspaces } from "./legacyMigration";

interface IdRow {
  id: string;
  sourceId: string;
  raw: RecordLike;
}

function rowsFor(value: unknown, prefix: string): IdRow[] {
  const used = new Set<string>();
  return readArray(value).map((entry, index) => {
    const raw = asRecord(entry);
    const sourceId = readString(raw.id);
    const id = uniqueId(sourceId, `${prefix}-${index + 1}`, used);
    return { id, sourceId, raw };
  });
}

function idMap(rows: readonly IdRow[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.sourceId && !map.has(row.sourceId)) map.set(row.sourceId, row.id);
  }
  return map;
}

function resolveId(value: unknown, map: Map<string, string>): string | null {
  const source = readString(value);
  return source ? (map.get(source) ?? null) : null;
}

function resolveIds(value: unknown, map: Map<string, string>): string[] {
  return uniqueStrings(
    readArray(value)
      .map((item) => resolveId(item, map))
      .filter((item): item is string => item !== null),
  );
}

function rawTabsFromSnapshot(source: RecordLike): unknown[] {
  return Array.isArray(source.tabs) ? source.tabs : readArray(source.terminalTabs);
}

interface SnapshotRows {
  projects: IdRow[];
  groups: IdRow[];
  containers: IdRow[];
  panes: IdRow[];
  tabs: IdRow[];
}

interface SnapshotIdMaps {
  projectIds: Map<string, string>;
  groupIds: Map<string, string>;
  containerIds: Map<string, string>;
  paneIds: Map<string, string>;
  tabIds: Map<string, string>;
}

interface SnapshotEntities {
  projects: Project[];
  groups: Group[];
  containers: WorkspaceContainer[];
  panes: Pane[];
  tabs: TerminalTab[];
}

interface SnapshotIndex {
  projectById: Map<string, Project>;
  containerById: Map<string, WorkspaceContainer>;
  paneById: Map<string, Pane>;
  tabById: Map<string, TerminalTab>;
}

interface IndexedSnapshot {
  entities: SnapshotEntities;
  index: SnapshotIndex;
}

interface TabReadContext {
  ids: SnapshotIdMaps;
  sourceOrphanedTabIds: ReadonlySet<string>;
}

function snapshotRows(source: RecordLike): SnapshotRows {
  return {
    projects: rowsFor(source.projects, "project"),
    groups: rowsFor(source.groups, "group"),
    containers: rowsFor(source.containers, "container"),
    panes: rowsFor(source.panes, "pane"),
    tabs: rowsFor(rawTabsFromSnapshot(source), "tab"),
  };
}

function snapshotIdMaps(rows: SnapshotRows): SnapshotIdMaps {
  return {
    projectIds: idMap(rows.projects),
    groupIds: idMap(rows.groups),
    containerIds: idMap(rows.containers),
    paneIds: idMap(rows.panes),
    tabIds: idMap(rows.tabs),
  };
}

function readSnapshotProject({ id, raw }: IdRow, ids: SnapshotIdMaps, fallbackLayout: WorkspaceLayout): Project {
  return {
    id,
    name: readString(raw.name) || id,
    cwd: readString(raw.cwd),
    groupId: resolveId(raw.groupId, ids.groupIds),
    paneIds: resolveIds(raw.paneIds, ids.paneIds),
    containerIds: resolveIds(raw.containerIds, ids.containerIds),
    activePaneId: resolveId(raw.activePaneId, ids.paneIds),
    activeContainerId: resolveId(raw.activeContainerId, ids.containerIds),
    layout: normalizeLayout(raw.layout, fallbackLayout),
    collapsed: Boolean(raw.collapsed),
    ...(Boolean(raw.archived) ? { archived: true } : {}),
  };
}

function readSnapshotGroup({ id, raw }: IdRow, ids: SnapshotIdMaps, fallbackLayout: WorkspaceLayout): Group {
  const parentGroupId = resolveId(raw.parentGroupId, ids.groupIds);
  return {
    id,
    name: readString(raw.name) || id,
    projectIds: resolveIds(raw.projectIds, ids.projectIds),
    parentGroupId: parentGroupId === id ? null : parentGroupId,
    collapsed: Boolean(raw.collapsed),
    suspended: Boolean(raw.suspended),
    layout: normalizeLayout(raw.layout, fallbackLayout),
  };
}

function readSnapshotContainer(
  { id, raw }: IdRow,
  ids: SnapshotIdMaps,
  fallbackLayout: WorkspaceLayout,
): WorkspaceContainer {
  const isClosed = raw.closed === true || raw.visible === false;
  return {
    id,
    projectId: resolveId(raw.projectId, ids.projectIds),
    paneIds: resolveIds(raw.paneIds, ids.paneIds),
    layout: normalizeLayout(raw.layout, fallbackLayout),
    activePaneId: resolveId(raw.activePaneId, ids.paneIds),
    internalLayout: readString(raw.internalLayout) || undefined,
    size: readFiniteNumber(raw.size) ?? undefined,
    visible: !isClosed,
    collapsed: Boolean(raw.collapsed),
    closed: isClosed,
    fullscreen: Boolean(raw.fullscreen),
  };
}

function readSnapshotPane({ id, raw }: IdRow, ids: SnapshotIdMaps, fallbackLayout: WorkspaceLayout): Pane {
  return {
    id,
    projectId: resolveId(raw.projectId, ids.projectIds),
    containerId: resolveId(raw.containerId, ids.containerIds),
    tabIds: resolveIds(raw.tabIds, ids.tabIds),
    activeTabId: resolveId(raw.activeTabId, ids.tabIds),
    layout: normalizeLayout(raw.layout, fallbackLayout),
  };
}

function claimPtyId(raw: RecordLike, usedPtyIds: Set<string>): string | null {
  const nestedMeta = asRecord(raw.meta);
  const ptySource =
    readString(raw.ptyId) || readString(raw.terminalId) || readString(nestedMeta.id);
  const hasUniquePtyId = ptySource.length > 0 && !usedPtyIds.has(ptySource);
  const ptyId = hasUniquePtyId ? ptySource : null;
  if (ptyId) usedPtyIds.add(ptyId);
  return ptyId;
}

function readSnapshotTab({ id, sourceId, raw }: IdRow, ptyId: string | null, context: TabReadContext): RuntimeTab {
  const nestedMeta = asRecord(raw.meta);
  const paneId = resolveId(raw.paneId, context.ids.paneIds);
  const isOrphaned =
    paneId === null ||
    ptyId === null ||
    raw.orphaned === true ||
    context.sourceOrphanedTabIds.has(id);
  return {
    id,
    paneId,
    ptyId,
    command: readString(raw.command) || readString(nestedMeta.command),
    cwd: readString(raw.cwd),
    width: readFiniteNumber(raw.width ?? nestedMeta.width),
    title: readString(raw.title) || readString(raw.name) || readString(raw.command) || "Terminal",
    ...(sourceId && sourceId !== id ? { legacyTerminalId: sourceId } : {}),
    ...(readString(raw.legacyTerminalId)
      ? { legacyTerminalId: readString(raw.legacyTerminalId) }
      : {}),
    ...(readString(raw.legacyWorkspaceId)
      ? { legacyWorkspaceId: readString(raw.legacyWorkspaceId) }
      : {}),
    ...(readString(raw.groupId) ? { groupId: readString(raw.groupId) } : {}),
    ...(raw.suspended === true ? { suspended: true } : {}),
    orphaned: isOrphaned,
  };
}

function readSnapshotTabs(rows: readonly IdRow[], context: TabReadContext): TerminalTab[] {
  const usedPtyIds = new Set<string>();
  return rows.map((row) => readSnapshotTab(row, claimPtyId(row.raw, usedPtyIds), context));
}

function readSnapshotEntities(rows: SnapshotRows, ids: SnapshotIdMaps, source: RecordLike): SnapshotEntities {
  const fallbackLayout = normalizeLayout(source.layout);
  const sourceOrphanedTabIds = new Set(resolveIds(source.orphanedTabIds, ids.tabIds));
  return {
    projects: rows.projects.map((row) => readSnapshotProject(row, ids, fallbackLayout)),
    groups: rows.groups.map((row) => readSnapshotGroup(row, ids, fallbackLayout)),
    containers: rows.containers.map((row) => readSnapshotContainer(row, ids, fallbackLayout)),
    panes: rows.panes.map((row) => readSnapshotPane(row, ids, fallbackLayout)),
    tabs: readSnapshotTabs(rows.tabs, { ids, sourceOrphanedTabIds }),
  };
}

function indexSnapshotEntities(entities: SnapshotEntities): SnapshotIndex {
  return {
    projectById: new Map(entities.projects.map((project) => [project.id, project])),
    containerById: new Map(entities.containers.map((container) => [container.id, container])),
    paneById: new Map(entities.panes.map((pane) => [pane.id, pane])),
    tabById: new Map(entities.tabs.map((tab) => [tab.id, tab])),
  };
}

// A pane can be recovered from either side of a malformed reference. The
// first deterministic owner wins, and all other references are deduplicated.
function repairContainerPanes(containers: readonly WorkspaceContainer[], index: SnapshotIndex): void {
  for (const container of containers) {
    const validPaneIds: string[] = [];
    for (const paneId of container.paneIds) {
      const pane = index.paneById.get(paneId);
      if (!pane || validPaneIds.includes(paneId)) continue;
      if (pane.containerId && pane.containerId !== container.id) continue;
      pane.containerId = container.id;
      if (!pane.projectId && container.projectId) pane.projectId = container.projectId;
      validPaneIds.push(paneId);
    }
    container.paneIds = validPaneIds;
    container.activePaneId =
      container.activePaneId && validPaneIds.includes(container.activePaneId)
        ? container.activePaneId
        : (validPaneIds[0] ?? null);
  }
}

function attachPanesToContainers(panes: readonly Pane[], index: SnapshotIndex): void {
  for (const pane of panes) {
    if (!pane.containerId) continue;
    const container = index.containerById.get(pane.containerId);
    if (container && !container.paneIds.includes(pane.id)) {
      container.paneIds.push(pane.id);
      if (!pane.projectId && container.projectId) pane.projectId = container.projectId;
    }
  }
}

function repairPaneTabs(panes: readonly Pane[], index: SnapshotIndex): void {
  for (const pane of panes) {
    const validTabIds: string[] = [];
    for (const tabId of pane.tabIds) {
      const tab = index.tabById.get(tabId);
      if (!tab || validTabIds.includes(tabId)) continue;
      if (tab.paneId && tab.paneId !== pane.id) continue;
      tab.paneId = pane.id;
      validTabIds.push(tabId);
    }
    pane.tabIds = validTabIds;
  }
}

function attachTabsToPanes(tabs: readonly TerminalTab[], index: SnapshotIndex): void {
  for (const tab of tabs) {
    if (!tab.paneId) continue;
    const pane = index.paneById.get(tab.paneId);
    if (pane && !pane.tabIds.includes(tab.id)) pane.tabIds.push(tab.id);
  }
}

// Infer ownership from project/container references when a pane lost its
// direct project id. This keeps a valid terminal reachable by group selectors.
function repairProjectOwnership(snapshot: IndexedSnapshot): void {
  const { entities, index } = snapshot;
  for (const project of entities.projects) {
    const validPaneIds = project.paneIds.filter((paneId) => index.paneById.has(paneId));
    for (const pane of entities.panes) {
      if (!pane.projectId && project.paneIds.includes(pane.id)) pane.projectId = project.id;
      if (pane.projectId === project.id && !validPaneIds.includes(pane.id)) validPaneIds.push(pane.id);
    }
    project.paneIds = validPaneIds;

    const validContainerIds = project.containerIds.filter((containerId) => {
      const container = index.containerById.get(containerId);
      return container?.projectId === project.id;
    });
    for (const container of entities.containers) {
      if (container.projectId === project.id && !validContainerIds.includes(container.id)) {
        validContainerIds.push(container.id);
      }
    }
    project.containerIds = validContainerIds;
  }
}

function repairActiveIds(entities: SnapshotEntities): void {
  for (const project of entities.projects) {
    project.activePaneId =
      project.activePaneId && project.paneIds.includes(project.activePaneId)
        ? project.activePaneId
        : (project.paneIds[0] ?? null);
    project.activeContainerId =
      project.activeContainerId && project.containerIds.includes(project.activeContainerId)
        ? project.activeContainerId
        : (project.containerIds[0] ?? null);
  }
  for (const pane of entities.panes) {
    pane.activeTabId =
      pane.activeTabId && pane.tabIds.includes(pane.activeTabId)
        ? pane.activeTabId
        : (pane.tabIds[0] ?? null);
  }
}

function orphanUnownedPaneTabs(panes: readonly Pane[], index: SnapshotIndex): void {
  for (const pane of panes) {
    if (pane.projectId) continue;
    for (const tabId of pane.tabIds) {
      const tab = index.tabById.get(tabId);
      if (tab) tab.orphaned = true;
    }
  }
}

function restrictEntityLayouts(entities: SnapshotEntities): void {
  for (const project of entities.projects) {
    project.layout = restrictLayoutItems(
      project.layout,
      new Set([...project.paneIds, ...project.containerIds]),
    );
  }
  for (const group of entities.groups) {
    group.layout = restrictLayoutItems(group.layout, new Set(group.projectIds));
  }
  for (const container of entities.containers) {
    container.layout = restrictLayoutItems(container.layout, new Set(container.paneIds));
  }
  for (const pane of entities.panes) {
    pane.layout = restrictLayoutItems(pane.layout, new Set(pane.tabIds));
  }
}

function repairSnapshotReferences(snapshot: IndexedSnapshot): void {
  const { entities, index } = snapshot;
  repairContainerPanes(entities.containers, index);
  attachPanesToContainers(entities.panes, index);
  repairPaneTabs(entities.panes, index);
  attachTabsToPanes(entities.tabs, index);
  repairProjectOwnership(snapshot);
  repairActiveIds(entities);
  orphanUnownedPaneTabs(entities.panes, index);
  restrictEntityLayouts(entities);
}

function selectSnapshotActiveIds(
  source: RecordLike,
  ids: SnapshotIdMaps,
  snapshot: IndexedSnapshot,
): ActiveSelection {
  const { projectById, containerById, paneById, tabById } = snapshot.index;
  const projectId = resolveId(source.activeProjectId, ids.projectIds);
  const activeProject = projectById.get(projectId ?? "") ?? snapshot.entities.projects[0] ?? null;
  const activeContainerId = resolveId(source.activeContainerId, ids.containerIds);
  const activeContainer =
    (activeContainerId &&
      containerById.get(activeContainerId)?.projectId === activeProject?.id &&
      containerById.get(activeContainerId)) ||
    (activeProject?.activeContainerId
      ? containerById.get(activeProject.activeContainerId)
      : undefined) ||
    (activeProject?.containerIds[0] ? containerById.get(activeProject.containerIds[0]) : undefined) ||
    null;
  const activePaneId = resolveId(source.activePaneId, ids.paneIds);
  const activePane =
    (activePaneId && paneById.get(activePaneId)?.projectId === activeProject?.id
      ? paneById.get(activePaneId)
      : undefined) ||
    (activeContainer?.paneIds[0] ? paneById.get(activeContainer.paneIds[0]) : undefined) ||
    (activeProject?.activePaneId ? paneById.get(activeProject.activePaneId) : undefined) ||
    null;
  const activeTabId = resolveId(source.activeTabId, ids.tabIds);
  const activeTab =
    (activeTabId && activePane?.tabIds.includes(activeTabId) ? tabById.get(activeTabId) : undefined) ||
    (activePane?.activeTabId ? tabById.get(activePane.activeTabId) : undefined) ||
    null;
  return {
    activeProjectId: activeProject?.id ?? null,
    activeContainerId: activeContainer?.id ?? null,
    activePaneId: activePane?.id ?? null,
    activeTabId: activeTab?.id ?? null,
  };
}

function normalizeSnapshotObject(source: RecordLike): WorkspaceSnapshotV2 {
  const rows = snapshotRows(source);
  const ids = snapshotIdMaps(rows);
  const entities = readSnapshotEntities(rows, ids, source);
  const snapshot: IndexedSnapshot = { entities, index: indexSnapshotEntities(entities) };
  repairSnapshotReferences(snapshot);
  const activeSelection = selectSnapshotActiveIds(source, ids, snapshot);
  const allContainerIds = new Set(entities.containers.map((container) => container.id));

  return {
    version: DOMAIN_SNAPSHOT_VERSION,
    ...entities,
    orphanedTabIds: entities.tabs.filter((tab) => tab.orphaned).map((tab) => tab.id),
    activeProjectId: activeSelection.activeProjectId,
    activeGroupId: resolveId(source.activeGroupId, ids.groupIds),
    activeContainerId: activeSelection.activeContainerId,
    activePaneId: activeSelection.activePaneId,
    activeTabId: activeSelection.activeTabId,
    layout: restrictLayoutItems(normalizeLayout(source.layout), allContainerIds),
  };
}

/**
 * Repairs an existing v2 snapshot. Invalid references are removed from
 * indexes, while their terminal tabs remain available as explicit orphans.
 */
export function normalizeSnapshotV2(value: unknown): WorkspaceSnapshotV2 {
  if (Array.isArray(value)) return migrateLegacyWorkspaces(value);
  return normalizeSnapshotObject(asRecord(value));
}
