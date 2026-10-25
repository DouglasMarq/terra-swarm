import type { TerminalMeta } from "../terminal.model";
import type { Group, Pane, Project, TerminalTab, Workspace, WorkspaceContainer, WorkspaceLayout, WorkspaceSnapshotV2 } from "../workspace.model";
import { asRecord } from "../../lib/records/records";
import { uniqueStrings } from "../../lib/collections/uniqueStrings";
import { DOMAIN_SNAPSHOT_VERSION, readArray, readFiniteNumber, readFlag, readString, uniqueId, type RecordLike, type RuntimeTab } from "./snapshotReaders";
import { DEFAULT_WORKSPACE_LAYOUT, cloneLayout, mergeWorkspaceLayout, normalizeLayout } from "./workspaceLayout";

export interface LegacyMigrationOptions {
  defaultLayout?: Partial<WorkspaceLayout>;
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
  const rawSuspended = readFlag(raw, "isSuspended", "suspended") ?? readFlag(nestedMeta, "isSuspended", "suspended");
  return {
    id,
    command,
    width,
    ...(paneId ? { paneId } : {}),
    ...(tabId ? { tabId } : {}),
    ...(groupId ? { groupId } : {}),
    ...(rawSuspended !== undefined
      ? { isSuspended: rawSuspended === true || rawSuspended === 1 }
      : {}),
  };
}

function migrationWorkspaceRows(input: unknown): RecordLike[] {
  return readArray(input).map(asRecord);
}

function workspacePaneRows(rawWorkspace: RecordLike): RecordLike[] {
  return readArray(rawWorkspace.panes).map(asRecord);
}

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
  const isVisible =
    readFlag(rawContainer, "isVisible", "visible") !== false && readFlag(rawContainer, "isClosed", "closed") !== true;
  return {
    id: containerId,
    projectId: owner.projectId,
    paneIds: [],
    layout: normalizeLayout(rawContainer.layout, owner.layout),
    activePaneId: null,
    internalLayout: readString(rawContainer.internalLayout) || undefined,
    size: readFiniteNumber(rawContainer.size) ?? undefined,
    isVisible,
    isCollapsed: Boolean(readFlag(rawContainer, "isCollapsed", "collapsed")),
    isClosed: !isVisible,
    isFullscreen: Boolean(readFlag(rawContainer, "isFullscreen", "fullscreen")),
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
    isCollapsed: Boolean(readFlag(rawWorkspace, "isCollapsed", "collapsed")),
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
    ...(meta.isSuspended !== undefined ? { isSuspended: meta.isSuspended } : {}),
    ...(meta.groupId ? { groupId: meta.groupId } : {}),
    ...(terminal.sourcePaneId ? { isPlacementExplicit: true } : {}),
    ...(terminal.rawId && terminal.ptyId === null ? { legacyTerminalId: terminal.rawId } : {}),
    ...(workspace.rawId ? { legacyWorkspaceId: workspace.rawId } : {}),
    isOrphaned: terminal.ptyId === null,
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
  if (tab.isOrphaned) state.orphanedTabIds.push(tabId);
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
        { previous: target.layout, incoming: { ...target.layout, itemIds: target.paneIds } },
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

export const migrateWorkspacesToSnapshotV2 = migrateLegacyWorkspaces;
