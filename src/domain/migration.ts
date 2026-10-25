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
  const workspaces = migrationWorkspaceRows(input);
  const layout = layoutFor(options);
  const projects: Project[] = [];
  const groups: Group[] = [];
  const containers: WorkspaceContainer[] = [];
  const panes: Pane[] = [];
  const tabs: TerminalTab[] = [];
  const orphanedTabIds: string[] = [];
  const usedProjectIds = new Set<string>();
  const usedContainerIds = new Set<string>();
  const usedPaneIds = new Set<string>();
  const usedTabIds = new Set<string>();
  const usedPtyIds = new Set<string>();

  workspaces.forEach((rawWorkspace, workspaceIndex) => {
    const rawWorkspaceId = readString(rawWorkspace.id);
    const projectId = uniqueId(
      rawWorkspaceId,
      `project-${workspaceIndex + 1}`,
      usedProjectIds,
    );
    const projectName = readString(rawWorkspace.name) || `Project ${workspaceIndex + 1}`;
    const projectCwd = readString(rawWorkspace.cwd);
    const workspaceGroupId = readString(rawWorkspace.groupId) || readString(rawWorkspace.group_id);
    const workspaceLayout = normalizeLayout(
      rawWorkspace.layout ?? {
        mode: readString(rawWorkspace.layoutMode) || layout.mode,
      },
      layout,
    );
    const rawPaneRows = workspacePaneRows(rawWorkspace);
    const rawContainerRows = readArray(rawWorkspace.containers).map(asRecord);
    const project: Project = {
      id: projectId,
      name: projectName,
      cwd: projectCwd,
      groupId: workspaceGroupId || null,
      paneIds: [],
      containerIds: [],
      activePaneId: null,
      activeContainerId: null,
      layout: cloneLayout(workspaceLayout),
      collapsed: Boolean(rawWorkspace.collapsed),
    };
    projects.push(project);

    const sourceContainerRows = rawContainerRows.length > 0 ? rawContainerRows : [{}];
    const sourceContainerIds = new Map<string, string>();
    const containersForProject: WorkspaceContainer[] = sourceContainerRows.map(
      (rawContainer, containerIndex): WorkspaceContainer => {
        const sourceId = readString(rawContainer.id);
        const containerId = uniqueId(
          sourceId || `container-${projectId}`,
          `container-${projectId}-${containerIndex + 1}`,
          usedContainerIds,
        );
        if (sourceId) sourceContainerIds.set(sourceId, containerId);
        const containerLayout = normalizeLayout(rawContainer.layout, workspaceLayout);
        const visible = rawContainer.visible !== false && rawContainer.closed !== true;
        return {
          id: containerId,
          projectId,
          paneIds: [],
          layout: containerLayout,
          activePaneId: null,
          internalLayout: readString(rawContainer.internalLayout) || undefined,
          size: readFiniteNumber(rawContainer.size) ?? undefined,
          visible,
          collapsed: Boolean(rawContainer.collapsed),
          closed: !visible,
          fullscreen: Boolean(rawContainer.fullscreen),
        };
      },
    );
    containers.push(...containersForProject);
    project.containerIds.push(...containersForProject.map((container) => container.id));
    project.activeContainerId =
      sourceContainerIds.get(readString(rawWorkspace.activeContainerId)) ||
      containersForProject[0]?.id ||
      null;

    const rawTerminals = readArray(rawWorkspace.terminals);
    const paneIdsBySource = new Map<string, string>();
    const tabIdsBySource = new Map<string, string>();
    const paneActiveTabBySource = new Map<string, string>();
    const paneContainerBySource = new Map<string, string>();
    const paneLayoutBySource = new Map<string, WorkspaceLayout>();
    for (const rawPane of rawPaneRows) {
      const sourcePaneId = readString(rawPane.id);
      const sourceActiveTabId = readString(rawPane.activeTabId) || readString(rawPane.active_tab_id);
      if (sourcePaneId && sourceActiveTabId) {
        paneActiveTabBySource.set(sourcePaneId, sourceActiveTabId);
      }
      if (sourcePaneId) {
        const sourceContainerId =
          readString(rawPane.containerId) || readString(rawPane.container_id);
        const mappedContainerId = sourceContainerIds.get(sourceContainerId);
        const containingContainer = sourceContainerRows.find((rawContainer) =>
          readArray(rawContainer.paneIds).some((paneId) => readString(paneId) === sourcePaneId),
        );
        const containingId = containingContainer
          ? sourceContainerIds.get(readString(containingContainer.id))
          : undefined;
        paneContainerBySource.set(
          sourcePaneId,
          mappedContainerId || containingId || containersForProject[0]?.id || "",
        );
        paneLayoutBySource.set(sourcePaneId, normalizeLayout(rawPane.layout, workspaceLayout));
      }
    }
    rawTerminals.forEach((rawTerminal, terminalIndex) => {
      const terminal = asRecord(rawTerminal);
      const rawMeta = terminalMeta(terminal, `legacy-terminal-${workspaceIndex + 1}-${terminalIndex + 1}`);
      const rawTerminalId = readString(terminal.id) || readString(asRecord(terminal.meta).id);
      const hasUniquePtyId = rawTerminalId.length > 0 && !usedPtyIds.has(rawTerminalId);
      const ptyId = hasUniquePtyId ? rawTerminalId : null;
      if (ptyId) usedPtyIds.add(ptyId);

      const nestedPlacement = placementFromNestedPane(rawWorkspace, rawTerminalId, rawMeta.tabId ?? "");
      const sourcePaneId = rawMeta.paneId || nestedPlacement?.paneId || "";
      const sourceTabId = rawMeta.tabId || nestedPlacement?.tabId || "";
      const paneId =
        (sourcePaneId && paneIdsBySource.get(sourcePaneId)) ||
        uniqueId(
          sourcePaneId,
          `pane-${projectId}-${terminalIndex + 1}`,
          usedPaneIds,
        );
      if (sourcePaneId) paneIdsBySource.set(sourcePaneId, paneId);
      const tabId =
        (sourceTabId && tabIdsBySource.get(sourceTabId)) ||
        uniqueId(
          sourceTabId,
          `tab-${projectId}-${terminalIndex + 1}`,
          usedTabIds,
        );
      if (sourceTabId) tabIdsBySource.set(sourceTabId, tabId);
      const paneContainerId =
        (sourcePaneId && paneContainerBySource.get(sourcePaneId)) ||
        containersForProject[0]?.id ||
        "";
      const orphaned = !hasUniquePtyId;
      const tab = {
        id: tabId,
        paneId,
        ptyId,
        command: rawMeta.command,
        cwd: projectCwd,
        width: rawMeta.width,
        title: rawMeta.command || "Terminal",
        ...(rawMeta.suspended !== undefined ? { suspended: rawMeta.suspended } : {}),
        ...(rawMeta.groupId ? { groupId: rawMeta.groupId } : {}),
        ...(sourcePaneId ? { placementExplicit: true } : {}),
        ...(rawTerminalId && !hasUniquePtyId ? { legacyTerminalId: rawTerminalId } : {}),
        ...(rawWorkspaceId ? { legacyWorkspaceId: rawWorkspaceId } : {}),
        orphaned,
      } as TerminalTab;
      if (!project.groupId && rawMeta.groupId) project.groupId = rawMeta.groupId;
      let pane = panes.find((candidate) => candidate.id === paneId);
      if (!pane) {
        pane = {
          id: paneId,
          projectId,
          containerId: paneContainerId,
          tabIds: [],
          activeTabId: null,
          layout: cloneLayout(
            (sourcePaneId && paneLayoutBySource.get(sourcePaneId)) || workspaceLayout,
          ),
        };
        panes.push(pane);
        project.paneIds.push(paneId);
        const container = containersForProject.find(
          (candidate) => candidate.id === paneContainerId,
        );
        container?.paneIds.push(paneId);
      }
      pane.tabIds.push(tabId);
      pane.activeTabId ??= tabId;
      tabs.push(tab);
      project.activePaneId ??= paneId;
      if (orphaned) orphanedTabIds.push(tabId);
    });

    const requestedActivePaneId = readString(rawWorkspace.activePaneId) || readString(rawWorkspace.active_pane_id);
    if (requestedActivePaneId && paneIdsBySource.has(requestedActivePaneId)) {
      project.activePaneId = paneIdsBySource.get(requestedActivePaneId) ?? project.activePaneId;
    }
    for (const [sourcePaneId, sourceActiveTabId] of paneActiveTabBySource) {
      const paneId = paneIdsBySource.get(sourcePaneId);
      const tabId = tabIdsBySource.get(sourceActiveTabId);
      const pane = panes.find((candidate) => candidate.id === paneId);
      if (pane && tabId && pane.tabIds.includes(tabId)) pane.activeTabId = tabId;
    }
    for (const rawPane of rawPaneRows) {
      const sourcePaneId = readString(rawPane.id);
      const paneId = paneIdsBySource.get(sourcePaneId);
      const pane = panes.find((candidate) => candidate.id === paneId);
      if (!pane) continue;
      const tabOrder = readArray(rawPane.tabs)
        .map((rawTab) => tabIdsBySource.get(readString(asRecord(rawTab).id)))
        .filter((tabId): tabId is string => Boolean(tabId));
      if (tabOrder.length > 0) {
        pane.tabIds = uniqueStrings([...tabOrder, ...pane.tabIds]);
      }
    }
    for (const [index, rawContainer] of sourceContainerRows.entries()) {
      const target = containersForProject[index];
      if (!target) continue;
      const paneOrder = readArray(rawContainer.paneIds)
        .map((rawPaneId) => paneIdsBySource.get(readString(rawPaneId)))
        .filter((paneId): paneId is string => Boolean(paneId));
      if (paneOrder.length > 0) {
        target.paneIds = uniqueStrings([...paneOrder, ...target.paneIds]);
        target.layout = mergeWorkspaceLayout(
          target.layout,
          { ...target.layout, itemIds: target.paneIds },
          new Set(target.paneIds),
          workspaceLayout,
        );
      }
      const sourceActivePaneId =
        readString(rawContainer.activePaneId) || readString(rawContainer.active_pane_id);
      target.activePaneId =
        (sourceActivePaneId && paneIdsBySource.get(sourceActivePaneId)) ||
        target.paneIds[0] ||
        null;
    }
  });

  const firstProject = projects[0] ?? null;
  const firstContainer = containers[0] ?? null;
  const firstPane = panes[0] ?? null;
  const firstTab = tabs[0] ?? null;
  return {
    version: DOMAIN_SNAPSHOT_VERSION,
    projects,
    groups,
    containers,
    panes,
    tabs,
    orphanedTabIds: uniqueStrings(orphanedTabIds),
    activeProjectId: firstProject?.id ?? null,
    activeGroupId: null,
    activeContainerId: firstContainer?.id ?? null,
    activePaneId: firstPane?.id ?? null,
    activeTabId: firstTab?.id ?? null,
    layout: cloneLayout(layout),
  };
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
  const oldProjectById = new Map(old.projects.map((project) => [project.id, project]));
  const oldPaneById = new Map(old.panes.map((pane) => [pane.id, pane]));
  const oldTabById = new Map(old.tabs.map((tab) => [tab.id, tab]));
  const oldTabByPty = new Map<string, TerminalTab>();
  for (const tab of old.tabs) {
    if (tab.ptyId && !oldTabByPty.has(tab.ptyId)) oldTabByPty.set(tab.ptyId, tab);
  }

  const incomingProjectById = new Map(incoming.projects.map((project) => [project.id, project]));
  const incomingPaneById = new Map(incoming.panes.map((pane) => [pane.id, pane]));
  const incomingTabById = new Map(incoming.tabs.map((tab) => [tab.id, tab]));
  const usedPaneIds = new Set<string>();
  const usedTabIds = new Set<string>();
  const finalTabs: TerminalTab[] = [];
  const finalPanesById = new Map<string, Pane>();
  const finalTabIdByIncomingId = new Map<string, string>();
  const finalPaneIdByIncomingId = new Map<string, string>();
  const finalPaneIdByOldId = new Map<string, string>();
  const finalTabIdByOldId = new Map<string, string>();

  const ensurePane = (
    incomingPane: Pane,
    projectId: string,
    containerId: string,
    preferredId: string,
    oldPane: Pane | null,
  ): Pane => {
    const existing = finalPanesById.get(preferredId);
    if (existing) return existing;
    const id = uniqueStableId(preferredId, incomingPane.id, usedPaneIds);
    const pane: Pane = {
      ...(oldPane ?? incomingPane),
      id,
      projectId,
      containerId,
      tabIds: [],
      activeTabId: null,
      layout: mergeLayout(
        oldPane?.layout,
        incomingPane.layout,
        new Set<string>(),
        incoming.layout,
      ),
    };
    finalPanesById.set(id, pane);
    return pane;
  };

  for (const incomingProject of incoming.projects) {
    for (const incomingPaneId of incomingProject.paneIds) {
      const incomingPane = incomingPaneById.get(incomingPaneId);
      if (!incomingPane) continue;
      const incomingTabs = incomingPane.tabIds
        .map((tabId) => incomingTabById.get(tabId))
        .filter((tab): tab is TerminalTab => Boolean(tab));
      for (const incomingTab of incomingTabs) {
        const oldTab = findOldTab(incomingTab, oldTabById, oldTabByPty);
        const incomingRuntime = runtimeTab(incomingTab);
        const oldRuntime = oldTab ? runtimeTab(oldTab) : null;
        const incomingPlacementIsExplicit = incomingRuntime.placementExplicit === true;
        const oldPane = oldTab?.paneId ? oldPaneById.get(oldTab.paneId) ?? null : null;
        const directOldPane = oldPaneById.get(incomingPane.id) ?? null;
        const preferredPaneId =
          (incomingPlacementIsExplicit && incomingPane.id) ||
          (oldPane?.projectId === incomingProject.id ? oldPane.id : null) ||
          (directOldPane?.projectId === incomingProject.id ? directOldPane.id : null) ||
          incomingPane.id;
        const finalPane = ensurePane(
          incomingPane,
          incomingProject.id,
          "",
          preferredPaneId,
          incomingPlacementIsExplicit ? directOldPane : oldPane,
        );
        finalPaneIdByIncomingId.set(incomingPane.id, finalPane.id);
        if (oldPane) finalPaneIdByOldId.set(oldPane.id, finalPane.id);
        if (directOldPane) finalPaneIdByOldId.set(directOldPane.id, finalPane.id);

        const preferredTabId = oldTab?.id ?? incomingTab.id;
        const finalTabId = uniqueStableId(preferredTabId, incomingTab.id, usedTabIds);
        finalTabIdByIncomingId.set(incomingTab.id, finalTabId);
        if (oldTab) finalTabIdByOldId.set(oldTab.id, finalTabId);
        const tab: TerminalTab = {
          ...incomingTab,
          id: finalTabId,
          paneId: finalPane.id,
          orphaned: incomingTab.orphaned,
          ...(oldRuntime?.suspended !== undefined && incomingRuntime.suspended === undefined
            ? { suspended: oldRuntime.suspended }
            : {}),
          ...(oldRuntime?.groupId !== undefined && incomingRuntime.groupId === undefined
            ? { groupId: oldRuntime.groupId }
            : {}),
        } as TerminalTab;
        finalTabs.push(tab);
        finalPane.tabIds.push(finalTabId);
      }
    }
  }

  // Orphan tabs have no live PTY identity. Retain them as recoverable records;
  // a tab with an identity absent from the authoritative backend projection is
  // stale and is intentionally not reintroduced after a refresh.
  for (const oldTab of old.tabs) {
    if (oldTab.ptyId || finalTabIdByOldId.has(oldTab.id)) continue;
    const oldRuntime = runtimeTab(oldTab);
    const orphan: TerminalTab = {
      ...oldTab,
      id: uniqueStableId(oldTab.id, `orphan-tab-${finalTabs.length + 1}`, usedTabIds),
      orphaned: true,
      ...(oldRuntime.suspended !== undefined ? { suspended: oldRuntime.suspended } : {}),
    } as TerminalTab;
    finalTabs.push(orphan);
    if (orphan.paneId) {
      const pane = finalPanesById.get(orphan.paneId);
      if (pane && !pane.tabIds.includes(orphan.id)) pane.tabIds.push(orphan.id);
    }
  }

  const finalTabsById = new Map(finalTabs.map((tab) => [tab.id, tab]));
  const finalPanes: Pane[] = [];
  for (const [paneId, pane] of finalPanesById) {
    const incomingPane = incomingPaneById.get(
      [...finalPaneIdByIncomingId.entries()].find(([, finalId]) => finalId === paneId)?.[0] ?? "",
    );
    const oldPane = oldPaneById.get(paneId);
    const validTabIds = new Set(finalTabs.filter((tab) => tab.paneId === paneId).map((tab) => tab.id));
    const oldActiveTab = oldPane?.activeTabId
      ? finalTabIdByOldId.get(oldPane.activeTabId) ?? oldPane.activeTabId
      : null;
    const incomingActiveTab = incomingPane?.activeTabId
      ? finalTabIdByIncomingId.get(incomingPane.activeTabId) ?? incomingPane.activeTabId
      : null;
    pane.tabIds = uniqueStrings([
      ...(oldPane?.tabIds ?? []).map((tabId) => finalTabIdByOldId.get(tabId) ?? tabId),
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
      incoming.layout,
    );
    finalPanes.push(pane);
  }

  const finalPanesByProject = new Map<string, Pane[]>();
  for (const pane of finalPanes) {
    const projectId = pane.projectId;
    if (!projectId || !incomingProjectById.has(projectId)) continue;
    const list = finalPanesByProject.get(projectId) ?? [];
    list.push(pane);
    finalPanesByProject.set(projectId, list);
  }

  const finalContainers: WorkspaceContainer[] = [];
  const finalProjects: Project[] = [];
  for (const incomingProject of incoming.projects) {
    const oldProject = oldProjectById.get(incomingProject.id);
    const projectPanes = finalPanesByProject.get(incomingProject.id) ?? [];
    const oldContainers = old.containers.filter((container) => container.projectId === incomingProject.id);
    const incomingContainers = incoming.containers.filter(
      (container) => container.projectId === incomingProject.id,
    );
    const containersForProject: WorkspaceContainer[] = [];
    const validProjectPaneIds = new Set(projectPanes.map((pane) => pane.id));
    const resolvePaneId = (paneId: string): string =>
      finalPaneIdByIncomingId.get(paneId) ?? finalPaneIdByOldId.get(paneId) ?? paneId;
    const orderedContainerIds = uniqueStrings([
      ...oldContainers.map((container) => container.id),
      ...incomingContainers.map((container) => container.id),
      `container-${incomingProject.id}`,
    ]);
    const assignedPaneIds = new Set<string>();
    for (const [containerIndex, containerId] of orderedContainerIds.entries()) {
      const oldContainer = oldContainers.find((container) => container.id === containerId);
      const incomingContainer = incomingContainers.find(
        (container) => container.id === containerId,
      );
      const declaredPaneIds = uniqueStrings([
        ...(oldContainer?.paneIds ?? []).map(resolvePaneId),
        ...(incomingContainer?.paneIds ?? []).map(resolvePaneId),
      ]).filter((paneId) => validProjectPaneIds.has(paneId) && !assignedPaneIds.has(paneId));
      const paneIds =
        containerIndex === 0
          ? uniqueStrings([
              ...declaredPaneIds,
              ...projectPanes
                .map((pane) => pane.id)
                .filter((paneId) => !assignedPaneIds.has(paneId)),
            ])
          : declaredPaneIds;
      paneIds.forEach((paneId) => assignedPaneIds.add(paneId));
      const base = oldContainer ?? incomingContainer ?? {
        id: containerId,
        projectId: incomingProject.id,
        paneIds: [],
        layout: incoming.layout,
        visible: true,
        collapsed: false,
        closed: false,
        fullscreen: false,
      };
      const container: WorkspaceContainer = {
        ...base,
        id: containerId,
        projectId: incomingProject.id,
        paneIds,
        activePaneId:
          base.activePaneId && paneIds.includes(base.activePaneId)
            ? base.activePaneId
            : (paneIds[0] ?? null),
        layout: mergeLayout(
          oldContainer?.layout,
          incomingContainer?.layout,
          new Set(paneIds),
          incoming.layout,
        ),
      };
      const requestedVisibility = options.containerVisibility?.[container.id];
      if (requestedVisibility !== undefined) {
        container.visible = requestedVisibility;
        container.closed = !requestedVisibility;
      }
      for (const paneId of paneIds) {
        const pane = projectPanes.find((candidate) => candidate.id === paneId);
        if (pane) pane.containerId = container.id;
      }
      containersForProject.push(container);
    }
    for (const container of containersForProject) finalContainers.push(container);

    const paneIds = projectPanes.map((pane) => pane.id);
    const containerIds = containersForProject.map((container) => container.id);
    const oldActivePaneId = oldProject?.activePaneId;
    const activePaneId =
      (oldActivePaneId && paneIds.includes(oldActivePaneId) ? oldActivePaneId : null) ||
      (incomingProject.activePaneId &&
      finalPaneIdByIncomingId.get(incomingProject.activePaneId) &&
      paneIds.includes(finalPaneIdByIncomingId.get(incomingProject.activePaneId) as string)
        ? finalPaneIdByIncomingId.get(incomingProject.activePaneId) as string
        : null) ||
      paneIds[0] ||
      null;
    const activeContainerId =
      (oldProject?.activeContainerId && containerIds.includes(oldProject.activeContainerId)
        ? oldProject.activeContainerId
        : null) ||
      containerIds[0] ||
      null;
    finalProjects.push({
      ...incomingProject,
      paneIds,
      containerIds,
      activePaneId,
      activeContainerId,
      layout: mergeLayout(
        oldProject?.layout,
        incomingProject.layout,
        new Set([...paneIds, ...containerIds]),
        incoming.layout,
      ),
    });
  }

  const finalProjectIds = new Set(finalProjects.map((project) => project.id));
  const groups = old.groups.map((group) => ({
    ...group,
    projectIds: group.projectIds.filter((projectId) => finalProjectIds.has(projectId)),
  }));
  const finalProjectById = new Map(finalProjects.map((project) => [project.id, project]));
  for (const project of finalProjects) {
    const sourceProject = incomingProjectById.get(project.id);
    if (sourceProject?.groupId !== undefined) project.groupId = sourceProject.groupId;
  }
  const activeProjectId =
    (old.activeProjectId && finalProjectIds.has(old.activeProjectId) ? old.activeProjectId : null) ||
    finalProjects[0]?.id ||
    null;
  const activeProject = activeProjectId ? finalProjectById.get(activeProjectId) ?? null : null;
  const allPaneIds = new Set(finalPanes.map((pane) => pane.id));
  const allContainerIds = new Set(finalContainers.map((container) => container.id));
  const activeContainerId =
    (old.activeContainerId && allContainerIds.has(old.activeContainerId) ? old.activeContainerId : null) ||
    activeProject?.activeContainerId ||
    finalContainers[0]?.id ||
    null;
  const activePaneId =
    (old.activePaneId && allPaneIds.has(old.activePaneId) ? old.activePaneId : null) ||
    activeProject?.activePaneId ||
    finalPanes[0]?.id ||
    null;
  const activePane = finalPanes.find((pane) => pane.id === activePaneId) ?? null;
  const activeTabId =
    (old.activeTabId && finalTabsById.has(old.activeTabId) &&
    activePane?.tabIds.includes(old.activeTabId)
      ? old.activeTabId
      : null) ||
    activePane?.activeTabId ||
    null;

  return normalizeSnapshotV2({
    ...old,
    version: DOMAIN_SNAPSHOT_VERSION,
    projects: finalProjects,
    groups,
    containers: finalContainers,
    panes: finalPanes,
    tabs: finalTabs,
    orphanedTabIds: finalTabs.filter((tab) => tab.orphaned).map((tab) => tab.id),
    activeProjectId,
    activeGroupId: old.activeGroupId && groups.some((group) => group.id === old.activeGroupId)
      ? old.activeGroupId
      : null,
    activeContainerId,
    activePaneId,
    activeTabId,
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

