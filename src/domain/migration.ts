import type { TerminalMeta } from "./terminal.model";
import type { Group, LayoutMode, Pane, Project, TerminalTab, Workspace, WorkspaceContainer, WorkspaceLayout, WorkspaceSnapshotV2 } from "./workspace.model";
import { asRecord, type UnknownRecord } from "../lib/records/records";
import { uniqueStrings } from "../lib/collections/uniqueStrings";

const DOMAIN_SNAPSHOT_VERSION = 2 as const;

export const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayout = {
  mode: "auto",
  itemIds: [],
};

export interface LegacyMigrationOptions {
  /** A layout is cloned for each migrated entity, so callers can mutate safely. */
  defaultLayout?: Partial<WorkspaceLayout>;
}

type RecordLike = UnknownRecord;

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function uniqueId(preferred: string, fallback: string, used: Set<string>): string {
  const base = preferred || fallback;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function cloneLayout(layout: WorkspaceLayout): WorkspaceLayout {
  return {
    mode: layout.mode,
    ...(layout.columns === undefined ? {} : { columns: layout.columns }),
    ...(layout.rows === undefined ? {} : { rows: layout.rows }),
    ...(layout.itemIds === undefined ? {} : { itemIds: [...layout.itemIds] }),
    ...(layout.sizes === undefined ? {} : { sizes: { ...layout.sizes } }),
    ...(layout.metadata === undefined ? {} : { metadata: { ...layout.metadata } }),
  };
}

function restrictLayoutItems(layout: WorkspaceLayout, validIds: ReadonlySet<string>): WorkspaceLayout {
  return {
    ...cloneLayout(layout),
    itemIds: (layout.itemIds ?? []).filter((itemId) => validIds.has(itemId)),
  };
}

function isLayoutMode(value: unknown): value is LayoutMode {
  return (
    value === "auto" ||
    value === "grid" ||
    value === "horizontal" ||
    value === "vertical" ||
    value === "stack" ||
    value === "spotlight"
  );
}

export function normalizeLayout(
  value: unknown,
  fallback: WorkspaceLayout = DEFAULT_WORKSPACE_LAYOUT,
): WorkspaceLayout {
  const raw = asRecord(value);
  const mode = isLayoutMode(raw.mode) ? raw.mode : fallback.mode;
  const columns = readFiniteNumber(raw.columns);
  const rows = readFiniteNumber(raw.rows);
  const itemIds = uniqueStrings(readArray(raw.itemIds).map(readString));
  const sizes: Record<string, number> = {};
  const rawSizes = asRecord(raw.sizes);
  for (const [id, rawSize] of Object.entries(rawSizes)) {
    const size = readFiniteNumber(rawSize);
    if (id && size !== null && size > 0) sizes[id] = size;
  }
  const metadata = asRecord(raw.metadata);

  return {
    mode,
    ...(columns !== null && columns > 0 ? { columns: Math.max(1, Math.round(columns)) } : {}),
    ...(rows !== null && rows > 0 ? { rows: Math.max(1, Math.round(rows)) } : {}),
    ...(itemIds.length > 0 ? { itemIds } : { itemIds: [] }),
    ...(Object.keys(sizes).length > 0 ? { sizes } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata: { ...metadata } } : {}),
  };
}

function layoutFor(options: LegacyMigrationOptions): WorkspaceLayout {
  const raw = options.defaultLayout ?? {};
  return normalizeLayout({ ...DEFAULT_WORKSPACE_LAYOUT, ...raw });
}

function terminalMeta(raw: RecordLike, fallbackId: string): TerminalMeta {
  const nestedMeta = asRecord(raw.meta);
  const id = readString(raw.id) || readString(nestedMeta.id) || fallbackId;
  const command = readString(raw.command) || readString(nestedMeta.command);
  const width = readFiniteNumber(raw.width ?? nestedMeta.width);
  const paneId = readString(raw.paneId) || readString(raw.pane_id) || readString(nestedMeta.paneId);
  const tabId = readString(raw.tabId) || readString(raw.tab_id) || readString(nestedMeta.tabId);
  const groupId = readString(raw.groupId) || readString(raw.group_id) || readString(nestedMeta.groupId);
  const rawSuspended = raw.suspended ?? nestedMeta.suspended;
  return {
    id,
    command,
    width,
    ...(paneId ? { paneId } : {}),
    ...(tabId ? { tabId } : {}),
    ...(groupId ? { groupId } : {}),
    ...(rawSuspended !== undefined
      ? { suspended: rawSuspended === true || rawSuspended === 1 }
      : {}),
  };
}

function migrationWorkspaceRows(input: unknown): RecordLike[] {
  return readArray(input).map(asRecord);
}

function workspacePaneRows(rawWorkspace: RecordLike): RecordLike[] {
  return readArray(rawWorkspace.panes).map(asRecord);
}

/**
 * Older workspace stores sometimes persisted placement only in the nested
 * pane/tab records. Resolve it before falling back to the terminal metadata
 * fields. This keeps migration compatible with both representations without
 * making the nested records a second source of truth.
 */
function placementFromNestedPane(
  rawWorkspace: RecordLike,
  terminalId: string,
  terminalTabId = "",
): { paneId: string; tabId: string } | null {
  if (!terminalId && !terminalTabId) return null;
  for (const rawPane of workspacePaneRows(rawWorkspace)) {
    const paneId = readString(rawPane.id);
    if (!paneId) continue;
    for (const rawTab of readArray(rawPane.tabs).map(asRecord)) {
      const ptyId =
        readString(rawTab.ptyId) ||
        readString(rawTab.pty_id) ||
        readString(rawTab.sessionId) ||
        readString(rawTab.session_id);
      const nestedTabId = readString(rawTab.id);
      if (ptyId !== terminalId && nestedTabId !== terminalTabId) continue;
      return { paneId, tabId: nestedTabId };
    }
  }
  return null;
}

interface LegacyMigrationState {
  layout: WorkspaceLayout;
  projects: Project[];
  groups: Group[];
  containers: WorkspaceContainer[];
  panes: Pane[];
  tabs: TerminalTab[];
  orphanedTabIds: string[];
  usedProjectIds: Set<string>;
  usedContainerIds: Set<string>;
  usedPaneIds: Set<string>;
  usedTabIds: Set<string>;
  usedPtyIds: Set<string>;
}

interface WorkspaceMigration {
  raw: RecordLike;
  index: number;
  rawId: string;
  project: Project;
  layout: WorkspaceLayout;
  paneRows: RecordLike[];
  containerRows: RecordLike[];
  containers: WorkspaceContainer[];
  containerIdsBySource: Map<string, string>;
  paneIdsBySource: Map<string, string>;
  tabIdsBySource: Map<string, string>;
  paneActiveTabBySource: Map<string, string>;
  paneContainerBySource: Map<string, string>;
  paneLayoutBySource: Map<string, WorkspaceLayout>;
}

interface LegacyTerminal {
  index: number;
  meta: TerminalMeta;
  rawId: string;
  ptyId: string | null;
  sourcePaneId: string;
  sourceTabId: string;
}

interface IndexedValue {
  value: unknown;
  index: number;
}

interface ContainerOwner {
  projectId: string;
  layout: WorkspaceLayout;
  idsBySource: Map<string, string>;
}

function createLegacyMigrationState(layout: WorkspaceLayout): LegacyMigrationState {
  return {
    layout,
    projects: [],
    groups: [],
    containers: [],
    panes: [],
    tabs: [],
    orphanedTabIds: [],
    usedProjectIds: new Set<string>(),
    usedContainerIds: new Set<string>(),
    usedPaneIds: new Set<string>(),
    usedTabIds: new Set<string>(),
    usedPtyIds: new Set<string>(),
  };
}

function legacyWorkspaceLayout(rawWorkspace: RecordLike, layout: WorkspaceLayout): WorkspaceLayout {
  return normalizeLayout(
    rawWorkspace.layout ?? {
      mode: readString(rawWorkspace.layoutMode) || layout.mode,
    },
    layout,
  );
}

function legacyContainer(rawContainer: RecordLike, containerId: string, owner: ContainerOwner): WorkspaceContainer {
  const visible = rawContainer.visible !== false && rawContainer.closed !== true;
  return {
    id: containerId,
    projectId: owner.projectId,
    paneIds: [],
    layout: normalizeLayout(rawContainer.layout, owner.layout),
    activePaneId: null,
    internalLayout: readString(rawContainer.internalLayout) || undefined,
    size: readFiniteNumber(rawContainer.size) ?? undefined,
    visible,
    collapsed: Boolean(rawContainer.collapsed),
    closed: !visible,
    fullscreen: Boolean(rawContainer.fullscreen),
  };
}

function legacyContainers(
  state: LegacyMigrationState,
  containerRows: readonly RecordLike[],
  owner: ContainerOwner,
): WorkspaceContainer[] {
  return containerRows.map((rawContainer, containerIndex) => {
    const sourceId = readString(rawContainer.id);
    const containerId = uniqueId(
      sourceId || `container-${owner.projectId}`,
      `container-${owner.projectId}-${containerIndex + 1}`,
      state.usedContainerIds,
    );
    if (sourceId) owner.idsBySource.set(sourceId, containerId);
    return legacyContainer(rawContainer, containerId, owner);
  });
}

function startWorkspaceMigration(
  state: LegacyMigrationState,
  rawWorkspace: RecordLike,
  workspaceIndex: number,
): WorkspaceMigration {
  const rawId = readString(rawWorkspace.id);
  const projectId = uniqueId(rawId, `project-${workspaceIndex + 1}`, state.usedProjectIds);
  const layout = legacyWorkspaceLayout(rawWorkspace, state.layout);
  const rawContainerRows = readArray(rawWorkspace.containers).map(asRecord);
  const containerRows = rawContainerRows.length > 0 ? rawContainerRows : [{}];
  const containerIdsBySource = new Map<string, string>();
  const containers = legacyContainers(state, containerRows, { projectId, layout, idsBySource: containerIdsBySource });
  const workspaceGroupId = readString(rawWorkspace.groupId) || readString(rawWorkspace.group_id);
  const project: Project = {
    id: projectId,
    name: readString(rawWorkspace.name) || `Project ${workspaceIndex + 1}`,
    cwd: readString(rawWorkspace.cwd),
    groupId: workspaceGroupId || null,
    paneIds: [],
    containerIds: containers.map((container) => container.id),
    activePaneId: null,
    activeContainerId:
      containerIdsBySource.get(readString(rawWorkspace.activeContainerId)) || containers[0]?.id || null,
    layout: cloneLayout(layout),
    collapsed: Boolean(rawWorkspace.collapsed),
  };
  return {
    raw: rawWorkspace,
    index: workspaceIndex,
    rawId,
    project,
    layout,
    paneRows: workspacePaneRows(rawWorkspace),
    containerRows,
    containers,
    containerIdsBySource,
    paneIdsBySource: new Map<string, string>(),
    tabIdsBySource: new Map<string, string>(),
    paneActiveTabBySource: new Map<string, string>(),
    paneContainerBySource: new Map<string, string>(),
    paneLayoutBySource: new Map<string, WorkspaceLayout>(),
  };
}

function sourcePaneContainerId(workspace: WorkspaceMigration, rawPane: RecordLike, sourcePaneId: string): string {
  const sourceContainerId = readString(rawPane.containerId) || readString(rawPane.container_id);
  const mappedContainerId = workspace.containerIdsBySource.get(sourceContainerId);
  const containingContainer = workspace.containerRows.find((rawContainer) =>
    readArray(rawContainer.paneIds).some((paneId) => readString(paneId) === sourcePaneId),
  );
  const containingId = containingContainer
    ? workspace.containerIdsBySource.get(readString(containingContainer.id))
    : undefined;
  return mappedContainerId || containingId || workspace.containers[0]?.id || "";
}

function indexSourcePanes(workspace: WorkspaceMigration): void {
  for (const rawPane of workspace.paneRows) {
    const sourcePaneId = readString(rawPane.id);
    const sourceActiveTabId = readString(rawPane.activeTabId) || readString(rawPane.active_tab_id);
    if (sourcePaneId && sourceActiveTabId) {
      workspace.paneActiveTabBySource.set(sourcePaneId, sourceActiveTabId);
    }
    if (!sourcePaneId) continue;
    workspace.paneContainerBySource.set(sourcePaneId, sourcePaneContainerId(workspace, rawPane, sourcePaneId));
    workspace.paneLayoutBySource.set(sourcePaneId, normalizeLayout(rawPane.layout, workspace.layout));
  }
}

function claimLegacyTerminal(
  state: LegacyMigrationState,
  workspace: WorkspaceMigration,
  row: IndexedValue,
): LegacyTerminal {
  const terminal = asRecord(row.value);
  const meta = terminalMeta(terminal, `legacy-terminal-${workspace.index + 1}-${row.index + 1}`);
  const rawId = readString(terminal.id) || readString(asRecord(terminal.meta).id);
  const ptyId = rawId.length > 0 && !state.usedPtyIds.has(rawId) ? rawId : null;
  if (ptyId) state.usedPtyIds.add(ptyId);
  const nestedPlacement = placementFromNestedPane(workspace.raw, rawId, meta.tabId ?? "");
  return {
    index: row.index,
    meta,
    rawId,
    ptyId,
    sourcePaneId: meta.paneId || nestedPlacement?.paneId || "",
    sourceTabId: meta.tabId || nestedPlacement?.tabId || "",
  };
}

function claimLegacyPaneId(
  state: LegacyMigrationState,
  workspace: WorkspaceMigration,
  terminal: LegacyTerminal,
): string {
  const { sourcePaneId } = terminal;
  const paneId =
    (sourcePaneId && workspace.paneIdsBySource.get(sourcePaneId)) ||
    uniqueId(sourcePaneId, `pane-${workspace.project.id}-${terminal.index + 1}`, state.usedPaneIds);
  if (sourcePaneId) workspace.paneIdsBySource.set(sourcePaneId, paneId);
  return paneId;
}

function claimLegacyTabId(
  state: LegacyMigrationState,
  workspace: WorkspaceMigration,
  terminal: LegacyTerminal,
): string {
  const { sourceTabId } = terminal;
  const tabId =
    (sourceTabId && workspace.tabIdsBySource.get(sourceTabId)) ||
    uniqueId(sourceTabId, `tab-${workspace.project.id}-${terminal.index + 1}`, state.usedTabIds);
  if (sourceTabId) workspace.tabIdsBySource.set(sourceTabId, tabId);
  return tabId;
}

function legacyTab(
  workspace: WorkspaceMigration,
  terminal: LegacyTerminal,
  placement: { paneId: string; tabId: string },
): RuntimeTab {
  const { meta } = terminal;
  return {
    id: placement.tabId,
    paneId: placement.paneId,
    ptyId: terminal.ptyId,
    command: meta.command,
    cwd: workspace.project.cwd,
    width: meta.width,
    title: meta.command || "Terminal",
    ...(meta.suspended !== undefined ? { suspended: meta.suspended } : {}),
    ...(meta.groupId ? { groupId: meta.groupId } : {}),
    ...(terminal.sourcePaneId ? { placementExplicit: true } : {}),
    ...(terminal.rawId && terminal.ptyId === null ? { legacyTerminalId: terminal.rawId } : {}),
    ...(workspace.rawId ? { legacyWorkspaceId: workspace.rawId } : {}),
    orphaned: terminal.ptyId === null,
  };
}

function legacyPaneFor(
  state: LegacyMigrationState,
  workspace: WorkspaceMigration,
  placement: { paneId: string; sourcePaneId: string; containerId: string },
): Pane {
  const existing = state.panes.find((candidate) => candidate.id === placement.paneId);
  if (existing) return existing;
  const pane: Pane = {
    id: placement.paneId,
    projectId: workspace.project.id,
    containerId: placement.containerId,
    tabIds: [],
    activeTabId: null,
    layout: cloneLayout(
      (placement.sourcePaneId && workspace.paneLayoutBySource.get(placement.sourcePaneId)) || workspace.layout,
    ),
  };
  state.panes.push(pane);
  workspace.project.paneIds.push(pane.id);
  workspace.containers.find((candidate) => candidate.id === placement.containerId)?.paneIds.push(pane.id);
  return pane;
}

function migrateLegacyTerminal(
  state: LegacyMigrationState,
  workspace: WorkspaceMigration,
  row: IndexedValue,
): void {
  const terminal = claimLegacyTerminal(state, workspace, row);
  const paneId = claimLegacyPaneId(state, workspace, terminal);
  const tabId = claimLegacyTabId(state, workspace, terminal);
  const containerId =
    (terminal.sourcePaneId && workspace.paneContainerBySource.get(terminal.sourcePaneId)) ||
    workspace.containers[0]?.id ||
    "";
  const tab = legacyTab(workspace, terminal, { paneId, tabId });
  if (!workspace.project.groupId && terminal.meta.groupId) workspace.project.groupId = terminal.meta.groupId;
  const pane = legacyPaneFor(state, workspace, { paneId, sourcePaneId: terminal.sourcePaneId, containerId });
  pane.tabIds.push(tabId);
  pane.activeTabId ??= tabId;
  state.tabs.push(tab);
  workspace.project.activePaneId ??= paneId;
  if (tab.orphaned) state.orphanedTabIds.push(tabId);
}

function applyRequestedActivePane(workspace: WorkspaceMigration): void {
  const requestedActivePaneId = readString(workspace.raw.activePaneId) || readString(workspace.raw.active_pane_id);
  if (!requestedActivePaneId || !workspace.paneIdsBySource.has(requestedActivePaneId)) return;
  workspace.project.activePaneId = workspace.paneIdsBySource.get(requestedActivePaneId) ?? workspace.project.activePaneId;
}

function applySourceActiveTabs(state: LegacyMigrationState, workspace: WorkspaceMigration): void {
  for (const [sourcePaneId, sourceActiveTabId] of workspace.paneActiveTabBySource) {
    const paneId = workspace.paneIdsBySource.get(sourcePaneId);
    const tabId = workspace.tabIdsBySource.get(sourceActiveTabId);
    const pane = state.panes.find((candidate) => candidate.id === paneId);
    if (pane && tabId && pane.tabIds.includes(tabId)) pane.activeTabId = tabId;
  }
}

function applySourceTabOrder(state: LegacyMigrationState, workspace: WorkspaceMigration): void {
  for (const rawPane of workspace.paneRows) {
    const paneId = workspace.paneIdsBySource.get(readString(rawPane.id));
    const pane = state.panes.find((candidate) => candidate.id === paneId);
    if (!pane) continue;
    const tabOrder = readArray(rawPane.tabs)
      .map((rawTab) => workspace.tabIdsBySource.get(readString(asRecord(rawTab).id)))
      .filter((tabId): tabId is string => Boolean(tabId));
    if (tabOrder.length > 0) {
      pane.tabIds = uniqueStrings([...tabOrder, ...pane.tabIds]);
    }
  }
}

function applySourceContainerOrder(workspace: WorkspaceMigration): void {
  for (const [index, rawContainer] of workspace.containerRows.entries()) {
    const target = workspace.containers[index];
    if (!target) continue;
    const paneOrder = readArray(rawContainer.paneIds)
      .map((rawPaneId) => workspace.paneIdsBySource.get(readString(rawPaneId)))
      .filter((paneId): paneId is string => Boolean(paneId));
    if (paneOrder.length > 0) {
      target.paneIds = uniqueStrings([...paneOrder, ...target.paneIds]);
      target.layout = mergeWorkspaceLayout(
        target.layout,
        { ...target.layout, itemIds: target.paneIds },
        new Set(target.paneIds),
        workspace.layout,
      );
    }
    const sourceActivePaneId =
      readString(rawContainer.activePaneId) || readString(rawContainer.active_pane_id);
    target.activePaneId =
      (sourceActivePaneId && workspace.paneIdsBySource.get(sourceActivePaneId)) ||
      target.paneIds[0] ||
      null;
  }
}

function migrateLegacyWorkspace(state: LegacyMigrationState, rawWorkspace: RecordLike, workspaceIndex: number): void {
  const workspace = startWorkspaceMigration(state, rawWorkspace, workspaceIndex);
  state.projects.push(workspace.project);
  state.containers.push(...workspace.containers);
  indexSourcePanes(workspace);
  readArray(rawWorkspace.terminals).forEach((value, index) => migrateLegacyTerminal(state, workspace, { value, index }));
  applyRequestedActivePane(workspace);
  applySourceActiveTabs(state, workspace);
  applySourceTabOrder(state, workspace);
  applySourceContainerOrder(workspace);
}

function legacySnapshot(state: LegacyMigrationState): WorkspaceSnapshotV2 {
  return {
    version: DOMAIN_SNAPSHOT_VERSION,
    projects: state.projects,
    groups: state.groups,
    containers: state.containers,
    panes: state.panes,
    tabs: state.tabs,
    orphanedTabIds: uniqueStrings(state.orphanedTabIds),
    activeProjectId: state.projects[0]?.id ?? null,
    activeGroupId: null,
    activeContainerId: state.containers[0]?.id ?? null,
    activePaneId: state.panes[0]?.id ?? null,
    activeTabId: state.tabs[0]?.id ?? null,
    layout: cloneLayout(state.layout),
  };
}

/**
 * Converts the pre-Onda-2 `Workspace[]` contract into normalized entities.
 *
 * IDs are kept where possible and generated IDs are derived only from array
 * position and the source identity. No clock/randomness is used, which makes
 * the migration safe to run repeatedly and easy to test or replay.
 */
export function migrateLegacyWorkspaces(
  input: readonly Workspace[] | unknown,
  options: LegacyMigrationOptions = {},
): WorkspaceSnapshotV2 {
  const state = createLegacyMigrationState(layoutFor(options));
  migrationWorkspaceRows(input).forEach((rawWorkspace, workspaceIndex) =>
    migrateLegacyWorkspace(state, rawWorkspace, workspaceIndex),
  );
  return legacySnapshot(state);
}

/** Portuguese-friendly alias used by callers that describe this as a migration. */
export const migrateWorkspacesToSnapshotV2 = migrateLegacyWorkspaces;

export interface SnapshotMergeOptions extends LegacyMigrationOptions {
  /** Visibility is UI state and therefore survives a backend refresh. */
  containerVisibility?: Readonly<Record<string, boolean>>;
}

type RuntimeTab = TerminalTab & {
  groupId?: string | null;
  suspended?: boolean;
  placementExplicit?: boolean;
};

function runtimeTab(tab: TerminalTab): RuntimeTab {
  return tab as RuntimeTab;
}

function mergeLayout(
  previous: WorkspaceLayout | undefined,
  incoming: WorkspaceLayout | undefined,
  validIds: ReadonlySet<string>,
  fallback: WorkspaceLayout,
): WorkspaceLayout {
  const previousLayout = normalizeLayout(previous, fallback);
  const incomingLayout = normalizeLayout(incoming, fallback);
  const itemIds = uniqueStrings([
    ...(previousLayout.itemIds ?? []),
    ...(incomingLayout.itemIds ?? []),
  ]).filter((id) => validIds.has(id));
  const sizes = {
    ...(incomingLayout.sizes ?? {}),
    ...(previousLayout.sizes ?? {}),
  };
  return restrictLayoutItems(
    {
      ...incomingLayout,
      ...previousLayout,
      itemIds,
      ...(Object.keys(sizes).length > 0 ? { sizes } : {}),
    },
    validIds,
  );
}

/** Shared layout merge primitive for the store's group projection. */
export function mergeWorkspaceLayout(
  previous: WorkspaceLayout | undefined,
  incoming: WorkspaceLayout | undefined,
  validIds: ReadonlySet<string>,
  fallback: WorkspaceLayout = DEFAULT_WORKSPACE_LAYOUT,
): WorkspaceLayout {
  return mergeLayout(previous, incoming, validIds, fallback);
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

interface ActiveSelection {
  activeProjectId: string | null;
  activeContainerId: string | null;
  activePaneId: string | null;
  activeTabId: string | null;
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
  for (const project of finalProjects) {
    const sourceProject = merge.incomingProjectById.get(project.id);
    if (sourceProject?.groupId !== undefined) project.groupId = sourceProject.groupId;
  }
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

function normalizeSnapshotObject(source: RecordLike): WorkspaceSnapshotV2 {
  const projectRows = rowsFor(source.projects, "project");
  const groupRows = rowsFor(source.groups, "group");
  const containerRows = rowsFor(source.containers, "container");
  const paneRows = rowsFor(source.panes, "pane");
  const tabRows = rowsFor(rawTabsFromSnapshot(source), "tab");
  const projectIds = idMap(projectRows);
  const groupIds = idMap(groupRows);
  const containerIds = idMap(containerRows);
  const paneIds = idMap(paneRows);
  const tabIds = idMap(tabRows);
  const sourceOrphanedTabIds = new Set(resolveIds(source.orphanedTabIds, tabIds));
  const fallbackLayout = normalizeLayout(source.layout);

  const projects: Project[] = projectRows.map(({ id, raw }) => ({
    id,
    name: readString(raw.name) || id,
    cwd: readString(raw.cwd),
    groupId: resolveId(raw.groupId, groupIds),
    paneIds: resolveIds(raw.paneIds, paneIds),
    containerIds: resolveIds(raw.containerIds, containerIds),
    activePaneId: resolveId(raw.activePaneId, paneIds),
    activeContainerId: resolveId(raw.activeContainerId, containerIds),
    layout: normalizeLayout(raw.layout, fallbackLayout),
    collapsed: Boolean(raw.collapsed),
    ...(Boolean(raw.archived) ? { archived: true } : {}),
  }));

  const groups: Group[] = groupRows.map(({ id, raw }) => {
    const parentGroupId = resolveId(raw.parentGroupId, groupIds);
    return {
      id,
      name: readString(raw.name) || id,
      projectIds: resolveIds(raw.projectIds, projectIds),
      parentGroupId: parentGroupId === id ? null : parentGroupId,
      collapsed: Boolean(raw.collapsed),
      suspended: Boolean(raw.suspended),
      layout: normalizeLayout(raw.layout, fallbackLayout),
    };
  });

  const containers: WorkspaceContainer[] = containerRows.map(({ id, raw }) => {
    const closed = raw.closed === true || raw.visible === false;
    return {
      id,
      projectId: resolveId(raw.projectId, projectIds),
      paneIds: resolveIds(raw.paneIds, paneIds),
      layout: normalizeLayout(raw.layout, fallbackLayout),
      activePaneId: resolveId(raw.activePaneId, paneIds),
      internalLayout: readString(raw.internalLayout) || undefined,
      size: readFiniteNumber(raw.size) ?? undefined,
      visible: !closed,
      collapsed: Boolean(raw.collapsed),
      closed,
      fullscreen: Boolean(raw.fullscreen),
    };
  });

  const panes: Pane[] = paneRows.map(({ id, raw }) => ({
    id,
    projectId: resolveId(raw.projectId, projectIds),
    containerId: resolveId(raw.containerId, containerIds),
    tabIds: resolveIds(raw.tabIds, tabIds),
    activeTabId: resolveId(raw.activeTabId, tabIds),
    layout: normalizeLayout(raw.layout, fallbackLayout),
  }));

  const usedPtyIds = new Set<string>();
  const tabs: TerminalTab[] = tabRows.map(({ id, sourceId, raw }) => {
    const nestedMeta = asRecord(raw.meta);
    const ptySource =
      readString(raw.ptyId) || readString(raw.terminalId) || readString(nestedMeta.id);
    const hasUniquePtyId = ptySource.length > 0 && !usedPtyIds.has(ptySource);
    const ptyId = hasUniquePtyId ? ptySource : null;
    if (ptyId) usedPtyIds.add(ptyId);
    const paneId = resolveId(raw.paneId, paneIds);
    const orphaned =
      paneId === null ||
      ptyId === null ||
      raw.orphaned === true ||
      sourceOrphanedTabIds.has(id);
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
      orphaned,
    };
  });

  const projectById = new Map(projects.map((project) => [project.id, project]));
  const containerById = new Map(containers.map((container) => [container.id, container]));
  const paneById = new Map(panes.map((pane) => [pane.id, pane]));
  const tabById = new Map(tabs.map((tab) => [tab.id, tab]));

  // A pane can be recovered from either side of a malformed reference. The
  // first deterministic owner wins, and all other references are deduplicated.
  for (const container of containers) {
    const validPaneIds: string[] = [];
    for (const paneId of container.paneIds) {
      const pane = paneById.get(paneId);
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
  for (const pane of panes) {
    if (pane.containerId) {
      const container = containerById.get(pane.containerId);
      if (container && !container.paneIds.includes(pane.id)) {
        container.paneIds.push(pane.id);
        if (!pane.projectId && container.projectId) pane.projectId = container.projectId;
      }
    }
  }

  for (const pane of panes) {
    const validTabIds: string[] = [];
    for (const tabId of pane.tabIds) {
      const tab = tabById.get(tabId);
      if (!tab || validTabIds.includes(tabId)) continue;
      if (tab.paneId && tab.paneId !== pane.id) continue;
      tab.paneId = pane.id;
      validTabIds.push(tabId);
    }
    pane.tabIds = validTabIds;
  }
  for (const tab of tabs) {
    if (tab.paneId) {
      const pane = paneById.get(tab.paneId);
      if (pane && !pane.tabIds.includes(tab.id)) pane.tabIds.push(tab.id);
    }
  }

  // Infer ownership from project/container references when a pane lost its
  // direct project id. This keeps a valid terminal reachable by group selectors.
  for (const project of projects) {
    const validPaneIds = project.paneIds.filter((paneId) => paneById.has(paneId));
    for (const pane of panes) {
      if (!pane.projectId && project.paneIds.includes(pane.id)) pane.projectId = project.id;
      if (pane.projectId === project.id && !validPaneIds.includes(pane.id)) validPaneIds.push(pane.id);
    }
    project.paneIds = validPaneIds;

    const validContainerIds = project.containerIds.filter((containerId) => {
      const container = containerById.get(containerId);
      return container?.projectId === project.id;
    });
    for (const container of containers) {
      if (container.projectId === project.id && !validContainerIds.includes(container.id)) {
        validContainerIds.push(container.id);
      }
    }
    project.containerIds = validContainerIds;
  }

  for (const project of projects) {
    project.activePaneId =
      project.activePaneId && project.paneIds.includes(project.activePaneId)
        ? project.activePaneId
        : (project.paneIds[0] ?? null);
    project.activeContainerId =
      project.activeContainerId && project.containerIds.includes(project.activeContainerId)
        ? project.activeContainerId
        : (project.containerIds[0] ?? null);
  }
  for (const pane of panes) {
    pane.activeTabId =
      pane.activeTabId && pane.tabIds.includes(pane.activeTabId)
        ? pane.activeTabId
        : (pane.tabIds[0] ?? null);
  }

  for (const pane of panes) {
    if (!pane.projectId) {
      for (const tabId of pane.tabIds) {
        const tab = tabById.get(tabId);
        if (tab) tab.orphaned = true;
      }
    }
  }

  const allContainerIds = new Set(containers.map((container) => container.id));
  for (const project of projects) {
    project.layout = restrictLayoutItems(
      project.layout,
      new Set([...project.paneIds, ...project.containerIds]),
    );
  }
  for (const group of groups) {
    group.layout = restrictLayoutItems(group.layout, new Set(group.projectIds));
  }
  for (const container of containers) {
    container.layout = restrictLayoutItems(container.layout, new Set(container.paneIds));
  }
  for (const pane of panes) {
    pane.layout = restrictLayoutItems(pane.layout, new Set(pane.tabIds));
  }

  const projectId = resolveId(source.activeProjectId, projectIds);
  const activeProject = projectById.get(projectId ?? "") ?? projects[0] ?? null;
  const activeContainerId = resolveId(source.activeContainerId, containerIds);
  const activeContainer =
    (activeContainerId &&
      containerById.get(activeContainerId)?.projectId === activeProject?.id &&
      containerById.get(activeContainerId)) ||
    (activeProject?.activeContainerId
      ? containerById.get(activeProject.activeContainerId)
      : undefined) ||
    (activeProject?.containerIds[0] ? containerById.get(activeProject.containerIds[0]) : undefined) ||
    null;
  const activePaneId = resolveId(source.activePaneId, paneIds);
  const activePane =
    (activePaneId && paneById.get(activePaneId)?.projectId === activeProject?.id
      ? paneById.get(activePaneId)
      : undefined) ||
    (activeContainer?.paneIds[0] ? paneById.get(activeContainer.paneIds[0]) : undefined) ||
    (activeProject?.activePaneId ? paneById.get(activeProject.activePaneId) : undefined) ||
    null;
  const activeTabId = resolveId(source.activeTabId, tabIds);
  const activeTab =
    (activeTabId && activePane?.tabIds.includes(activeTabId) ? tabById.get(activeTabId) : undefined) ||
    (activePane?.activeTabId ? tabById.get(activePane.activeTabId) : undefined) ||
    null;
  const activeGroupId = resolveId(source.activeGroupId, groupIds);

  return {
    version: DOMAIN_SNAPSHOT_VERSION,
    projects,
    groups,
    containers,
    panes,
    tabs,
    orphanedTabIds: tabs.filter((tab) => tab.orphaned).map((tab) => tab.id),
    activeProjectId: activeProject?.id ?? null,
    activeGroupId,
    activeContainerId: activeContainer?.id ?? null,
    activePaneId: activePane?.id ?? null,
    activeTabId: activeTab?.id ?? null,
    layout: restrictLayoutItems(fallbackLayout, allContainerIds),
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

