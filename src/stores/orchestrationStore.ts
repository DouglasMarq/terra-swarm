import { translateNow } from "../i18n";
import { errorMessage } from "../lib/errors/errorMessage";
import { asRecord } from "../lib/records/records";
import { uniqueStrings } from "../lib/collections/uniqueStrings";
import { storageGet, storageSet } from "../lib/storage/safeStorage";
import { create } from "zustand";
import type { Group, Workspace, WorkspaceContainerPatch, WorkspaceContainer, WorkspaceLayout, WorkspaceGroup, WorkspaceSnapshotV2 } from "../domain/workspace.model";
import { normalizeLayout } from "../domain/migration/workspaceLayout";
import { normalizeSnapshotV2 } from "../domain/migration/snapshotNormalize";
import { deriveSnapshot } from "../domain/workspaceProjection";
import { createPersistenceEngine } from "./orchestrationPersistence";
import {
  DEFAULT_FEATURE_FLAGS,
  FEATURE_FLAG_IDS,
  type FeatureFlagId,
  type FeatureFlags,
  normalizeFeatureFlags,
} from "../lib/features/featureFlags";
import { workspaceApi } from "../lib/tauri/workspace";

export interface OrchestrationPersistenceError {
  operation: string;
  message: string;
  at: number;
}

export const ORCHESTRATION_STORAGE_KEY = "orchestration-state-v1";

type PersistedOrchestrationState = {
  version: 1;
  containerVisibility: Record<string, boolean>;
  flags: FeatureFlags;
  detachedTerminalIds?: string[];
  snapshot?: WorkspaceSnapshotV2 | null;
};

function readPersisted(): Pick<
  PersistedOrchestrationState,
  "containerVisibility" | "flags" | "snapshot" | "detachedTerminalIds"
> {
  const raw = storageGet(ORCHESTRATION_STORAGE_KEY);
  if (!raw) {
    return {
      containerVisibility: {},
      flags: { ...DEFAULT_FEATURE_FLAGS },
      detachedTerminalIds: [],
      snapshot: null,
    };
  }
  try {
    const parsed = asRecord(JSON.parse(raw) as unknown);
    const visibility: Record<string, boolean> = {};
    const rawVisibility = asRecord(parsed.containerVisibility);
    for (const [id, value] of Object.entries(rawVisibility)) {
      if (id && typeof value === "boolean") visibility[id] = value;
    }
    const snapshotValue = parsed.snapshot;
    return {
      containerVisibility: visibility,
      flags: normalizeFeatureFlags(parsed.flags),
      detachedTerminalIds: Array.isArray(parsed.detachedTerminalIds)
        ? parsed.detachedTerminalIds.filter(
            (id): id is string => typeof id === "string" && id.trim().length > 0,
          )
        : [],
      snapshot:
        snapshotValue && typeof snapshotValue === "object"
          ? normalizeSnapshotV2(snapshotValue)
          : null,
    };
  } catch {
    return {
      containerVisibility: {},
      flags: { ...DEFAULT_FEATURE_FLAGS },
      detachedTerminalIds: [],
      snapshot: null,
    };
  }
}

const persisted = readPersisted();

interface PersistableOrchestration {
  containerVisibility: Record<string, boolean>;
  flags: FeatureFlags;
  snapshot: WorkspaceSnapshotV2 | null;
  detachedTerminalIds?: readonly string[];
}

function persist(state: PersistableOrchestration): void {
  const { containerVisibility, flags, snapshot, detachedTerminalIds = [] } = state;
  const value: PersistedOrchestrationState = {
    version: 1,
    containerVisibility: { ...containerVisibility },
    flags: { ...flags },
    detachedTerminalIds: [...new Set(detachedTerminalIds.filter(Boolean))],
    snapshot,
  };
  storageSet(ORCHESTRATION_STORAGE_KEY, JSON.stringify(value));
}

function updateSnapshotContainerState(
  snapshot: WorkspaceSnapshotV2 | null,
  containerId: string,
  patch: WorkspaceContainerPatch,
): WorkspaceSnapshotV2 | null {
  if (!snapshot) return snapshot;
  const container = snapshot.containers.find((candidate) => candidate.id === containerId);
  if (!container) return snapshot;
  const nextContainer: WorkspaceContainer = {
    ...container,
    ...(patch.isVisible === undefined ? {} : { isVisible: patch.isVisible, isClosed: !patch.isVisible }),
    ...(patch.isClosed === undefined ? {} : { isClosed: patch.isClosed, isVisible: !patch.isClosed }),
    ...(patch.isCollapsed === undefined ? {} : { isCollapsed: patch.isCollapsed }),
    ...(patch.isFullscreen === undefined ? {} : { isFullscreen: patch.isFullscreen }),
    ...(patch.internalLayout === undefined ? {} : { internalLayout: patch.internalLayout }),
    ...(patch.size === undefined ? {} : { size: patch.size }),
    ...(patch.activePaneId === undefined && !patch.shouldClearActivePane
      ? {}
      : { activePaneId: patch.shouldClearActivePane ? null : patch.activePaneId ?? null }),
    ...(patch.layout === undefined ? {} : { layout: normalizeLayout(patch.layout) }),
  };
  return {
    ...snapshot,
    containers: snapshot.containers.map((candidate) =>
      candidate.id === containerId ? nextContainer : candidate,
    ),
  };
}

function updateSnapshotPaneTabs(
  snapshot: WorkspaceSnapshotV2 | null,
  paneId: string,
  order: readonly string[],
): WorkspaceSnapshotV2 | null {
  if (!snapshot) return snapshot;
  const pane = snapshot.panes.find((candidate) => candidate.id === paneId);
  if (!pane) return snapshot;
  const allowed = new Set(pane.tabIds);
  const sortedTabIds = uniqueStrings([...order, ...pane.tabIds]).filter((id) => allowed.has(id));
  return {
    ...snapshot,
    panes: snapshot.panes.map((candidate) =>
      candidate.id === paneId
        ? {
            ...candidate,
            tabIds: sortedTabIds,
            layout: { ...candidate.layout, itemIds: sortedTabIds },
          }
        : candidate,
    ),
  };
}

function updateSnapshotWorkspaceLayout(
  snapshot: WorkspaceSnapshotV2 | null,
  projectId: string,
  layout: WorkspaceLayout,
): WorkspaceSnapshotV2 | null {
  if (!snapshot) return snapshot;
  const normalized = normalizeLayout(layout);
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) =>
      project.id === projectId ? { ...project, layout: normalized } : project,
    ),
    layout: snapshot.activeProjectId === projectId ? normalized : snapshot.layout,
  };
}

function patchGroup(
  snapshot: WorkspaceSnapshotV2 | null,
  groupId: string,
  update: Partial<Group>,
): WorkspaceSnapshotV2 | null {
  if (!snapshot) return snapshot;
  return {
    ...snapshot,
    groups: snapshot.groups.map((group) =>
      group.id === groupId ? { ...group, ...update } : group,
    ),
  };
}

function patchProjectGroup(
  snapshot: WorkspaceSnapshotV2 | null,
  projectId: string,
  groupId: string | null,
): WorkspaceSnapshotV2 | null {
  if (!snapshot) return snapshot;
  const groups = snapshot.groups.map((group) => ({
    ...group,
    projectIds:
      group.id === groupId
        ? uniqueStrings([...group.projectIds, projectId])
        : group.projectIds.filter((id) => id !== projectId),
  }));
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) =>
      project.id === projectId ? { ...project, groupId } : project,
    ),
    groups,
  };
}

export type OrchestrationState = {
  snapshot: WorkspaceSnapshotV2 | null;
  groups: Group[];
  containerVisibility: Record<string, boolean>;
  detachedTerminalIds: string[];
  flags: FeatureFlags;
  isHydrated: boolean;
  persistenceError: OrchestrationPersistenceError | null;
  sync: (workspaces: readonly Workspace[], groups?: readonly WorkspaceGroup[]) => void;
  hydrate: (workspaces: readonly Workspace[], groups?: readonly WorkspaceGroup[]) => void;
  syncWorkspaces: (workspaces: readonly Workspace[], groups?: readonly WorkspaceGroup[]) => void;
  setFeatureFlag: (id: FeatureFlagId, isEnabled: boolean) => void;
  setFlag: (id: FeatureFlagId, isEnabled: boolean) => void;
  setFeatureFlags: (flags: Partial<FeatureFlags>) => void;
  setContainerVisible: (containerId: string, isVisible: boolean) => void;
  setContainerVisibility: (containerId: string, isVisible: boolean) => void;
  openContainer: (containerId: string) => void;
  closeContainer: (containerId: string) => void;
  toggleContainer: (containerId: string) => void;
  setContainerState: (containerId: string, patch: WorkspaceContainerPatch) => void;
  setContainerCollapsed: (containerId: string, isCollapsed: boolean) => void;
  setContainerFullscreen: (containerId: string, isFullscreen: boolean) => void;
  setContainerActivePane: (containerId: string, paneId: string | null) => void;
  setContainerInternalLayout: (containerId: string, internalLayout: string) => void;
  reorderContainers: (projectId: string, order: string[]) => void;
  reorderPanes: (containerId: string, order: string[]) => void;
  reorderTabs: (paneId: string, order: string[]) => void;
  movePane: (paneId: string, toContainerId: string, index?: number | null) => void;
  setWorkspaceLayout: (projectId: string, layout: WorkspaceLayout) => void;
  setWorkspaceCollapsed: (projectId: string, isCollapsed: boolean) => void;
  setGroupSuspended: (groupId: string, isSuspended: boolean) => void;
  setProjectGroup: (projectId: string, groupId: string | null) => void;
  setActivePane: (paneId: string | null) => void;
  clearPersistenceError: () => void;
  setTerminalDetached: (terminalId: string, isDetached: boolean) => void;
  detachTerminal: (terminalId: string) => void;
  reattachTerminal: (terminalId: string) => void;
  reset: () => void;
};

const emptyState = (): Pick<OrchestrationState, "snapshot" | "groups" | "containerVisibility" | "detachedTerminalIds" | "flags" | "isHydrated" | "persistenceError"> => ({
  snapshot: null,
  groups: [],
  containerVisibility: {},
  detachedTerminalIds: [],
  flags: { ...DEFAULT_FEATURE_FLAGS },
  isHydrated: false,
  persistenceError: null,
});

export const useOrchestrationStore = create<OrchestrationState>((set, get) => {
  const reportPersistenceError = (operation: string, error: unknown): void => {
    set({
      persistenceError: {
        operation,
        message: errorMessage(error, translateNow("system.persistFailed")),
        at: Date.now(),
      },
    });
  };

  const { persistCommand, markNewerProjection } = createPersistenceEngine({
    read: () => get(),
    apply: (projection) => {
      persist({ containerVisibility: projection.containerVisibility, flags: get().flags, snapshot: projection.snapshot, detachedTerminalIds: projection.detachedTerminalIds });
      set(projection);
    },
    reportError: reportPersistenceError,
  });

  return {
    snapshot: persisted.snapshot ?? null,
    groups: persisted.snapshot?.groups ?? [],
    containerVisibility: persisted.containerVisibility,
    detachedTerminalIds: [...new Set(persisted.detachedTerminalIds ?? [])],
    flags: persisted.flags,
    isHydrated: persisted.snapshot !== null,
    persistenceError: null,

    sync: (workspaces, sourceGroups = []) => {
    markNewerProjection();
    const state = get();
    const derived = deriveSnapshot(
      { workspaces, groups: sourceGroups },
      state.containerVisibility,
      state.snapshot,
    );
    const terminalIds = new Set(
      workspaces.flatMap((workspace) => workspace.terminals.map((terminal) => terminal.id)),
    );
    const detachedTerminalIds = state.detachedTerminalIds.filter((id) => terminalIds.has(id));
    const knownContainerIds = new Set(derived.snapshot.containers.map((container) => container.id));
    const containerVisibility: Record<string, boolean> = {};
    for (const [id, isVisible] of Object.entries(state.containerVisibility)) {
      if (knownContainerIds.has(id)) containerVisibility[id] = isVisible;
    }
    for (const container of derived.snapshot.containers) {
      containerVisibility[container.id] = container.isVisible;
    }
    persist({ containerVisibility, flags: state.flags, snapshot: derived.snapshot, detachedTerminalIds });
    set({
      snapshot: derived.snapshot,
      groups: derived.groups,
      containerVisibility,
      detachedTerminalIds,
      isHydrated: true,
    });
  },

  hydrate: (workspaces, sourceGroups = []) =>
    get().sync(workspaces, sourceGroups),

  syncWorkspaces: (workspaces, sourceGroups = []) =>
    get().sync(workspaces, sourceGroups),

    setFeatureFlag: (id, isEnabled) => {
    if (!FEATURE_FLAG_IDS.includes(id)) return;
    markNewerProjection();
    const flags = { ...get().flags, [id]: isEnabled };
    persist({ ...get(), flags });
    set({ flags });
  },

  setFlag: (id, isEnabled) => get().setFeatureFlag(id, isEnabled),

  setFeatureFlags: (partial) => {
    markNewerProjection();
    const flags = normalizeFeatureFlags({ ...get().flags, ...partial });
    persist({ ...get(), flags });
    set({ flags });
  },

  setContainerVisible: (containerId, isVisible) => {
    const containerVisibility = {
      ...get().containerVisibility,
      [containerId]: isVisible,
    };
    const snapshot = updateSnapshotContainerState(get().snapshot, containerId, {
      isVisible,
      isClosed: !isVisible,
    });
    const container = snapshot?.containers.find((candidate) => candidate.id === containerId);
    if (container?.projectId) {
      persistCommand(
        workspaceApi.setWorkspaceContainerState(container.projectId, containerId, {
          isVisible,
          isClosed: !isVisible,
        }),
        "container visibility",
        [`container:${containerId}`],
      );
    } else {
      markNewerProjection();
    }
    persist({ ...get(), containerVisibility, snapshot });
    set({ containerVisibility, snapshot });
  },

  setContainerVisibility: (containerId, isVisible) =>
    get().setContainerVisible(containerId, isVisible),

  openContainer: (containerId) => get().setContainerVisible(containerId, true),
  closeContainer: (containerId) => get().setContainerVisible(containerId, false),
  toggleContainer: (containerId) => {
    const isVisible = get().containerVisibility[containerId] ?? true;
    get().setContainerVisible(containerId, !isVisible);
  },

  setContainerState: (containerId, patch) => {
    const current = get().snapshot;
    const container = current?.containers.find((candidate) => candidate.id === containerId);
    const projectId = container?.projectId ?? null;
    const normalizedPatch: WorkspaceContainerPatch = {
      ...patch,
      ...(patch.activePaneId === null
        ? { activePaneId: undefined, shouldClearActivePane: true }
        : {}),
    };
    let snapshot = updateSnapshotContainerState(current, containerId, patch);
    if (snapshot && projectId && (patch.activePaneId !== undefined || patch.shouldClearActivePane)) {
      const activePaneId = patch.shouldClearActivePane ? null : patch.activePaneId ?? null;
      snapshot = {
        ...snapshot,
        activeProjectId: projectId,
        activeContainerId: containerId,
        activePaneId,
        projects: snapshot.projects.map((project) =>
          project.id === projectId
            ? { ...project, activeContainerId: containerId, activePaneId }
            : project,
        ),
      };
    }
    const containerVisibility = { ...get().containerVisibility };
    if (patch.isVisible !== undefined) containerVisibility[containerId] = patch.isVisible;
    if (patch.isClosed !== undefined) containerVisibility[containerId] = !patch.isClosed;
    if (projectId) {
      const targets = [`container:${containerId}`];
      if (patch.activePaneId !== undefined || patch.shouldClearActivePane) {
        targets.push("active-pane", `project:${projectId}`);
      }
      persistCommand(
        workspaceApi.setWorkspaceContainerState(projectId, containerId, normalizedPatch),
        "container state",
        targets,
      );
    } else {
      markNewerProjection();
    }
    persist({ ...get(), containerVisibility, snapshot });
    set({ containerVisibility, snapshot });
  },

  setContainerCollapsed: (containerId, isCollapsed) =>
    get().setContainerState(containerId, { isCollapsed }),

  setContainerFullscreen: (containerId, isFullscreen) =>
    get().setContainerState(containerId, { isFullscreen }),

  setContainerActivePane: (containerId, paneId) =>
    get().setContainerState(containerId, {
      activePaneId: paneId,
      ...(paneId === null ? { shouldClearActivePane: true } : {}),
    }),

  setContainerInternalLayout: (containerId, internalLayout) =>
    get().setContainerState(containerId, { internalLayout }),

  reorderContainers: (projectId, order) => {
    const current = get().snapshot;
    if (!current) return;
    const project = current.projects.find((candidate) => candidate.id === projectId);
    if (!project) return;
    const allowed = new Set(project.containerIds);
    const requested = order.filter((id) => allowed.has(id));
    const sortedIds = [...new Set([...requested, ...project.containerIds])].filter((id) =>
      allowed.has(id),
    );
    const positions = current.containers
      .map((container, index) => (allowed.has(container.id) ? index : -1))
      .filter((index) => index >= 0);
    const nextContainers = [...current.containers];
    positions.forEach((position, index) => {
      const replacement = current.containers.find(
        (container) => container.id === sortedIds[index],
      );
      if (replacement) nextContainers[position] = replacement;
    });
    const nextProject = { ...project, containerIds: sortedIds };
    const snapshot = {
      ...current,
      containers: nextContainers,
      projects: current.projects.map((candidate) =>
        candidate.id === projectId ? nextProject : candidate,
      ),
    };
    persistCommand(
      workspaceApi.reorderWorkspaceContainers(projectId, sortedIds),
      "container order",
      [`project:${projectId}:containers`],
    );
    persist({ ...get(), snapshot });
    set({ snapshot });
  },

  reorderPanes: (containerId, order) => {
    const current = get().snapshot;
    const container = current?.containers.find((candidate) => candidate.id === containerId);
    if (!current || !container || !container.projectId) return;
    const sortedPaneIds = [...new Set([...order, ...container.paneIds])].filter((id) =>
      container.paneIds.includes(id),
    );
    const snapshot = {
      ...current,
      containers: current.containers.map((candidate) =>
        candidate.id === containerId
          ? {
              ...candidate,
              paneIds: sortedPaneIds,
              layout: { ...candidate.layout, itemIds: sortedPaneIds },
            }
          : candidate,
      ),
    };
    persistCommand(
      workspaceApi.reorderWorkspacePanes(container.projectId, containerId, sortedPaneIds),
      "pane order",
      [`container:${containerId}:panes`],
    );
    persist({ ...get(), snapshot });
    set({ snapshot });
  },

  reorderTabs: (paneId, order) => {
    const current = get().snapshot;
    const pane = current?.panes.find((candidate) => candidate.id === paneId);
    if (!current || !pane) return;
    const snapshot = updateSnapshotPaneTabs(current, paneId, order);
    if (!snapshot || snapshot === current) return;
    markNewerProjection();
    persist({ ...get(), snapshot });
    set({ snapshot });
  },

  movePane: (paneId, toContainerId, index) => {
    const current = get().snapshot;
    const pane = current?.panes.find((candidate) => candidate.id === paneId);
    const target = current?.containers.find((candidate) => candidate.id === toContainerId);
    const source = current?.containers.find((candidate) =>
      candidate.id === pane?.containerId || candidate.paneIds.includes(paneId),
    );
    if (
      !current ||
      !pane ||
      !source ||
      !source.projectId ||
      !target ||
      !target.projectId ||
      source.projectId !== target.projectId
    ) return;
    const nextContainers = current.containers.map((container) => {
      const paneIds = container.paneIds.filter((id) => id !== paneId);
      if (container.id !== toContainerId) return { ...container, paneIds };
      const insertion = Math.max(0, Math.min(index ?? paneIds.length, paneIds.length));
      paneIds.splice(insertion, 0, paneId);
      return { ...container, paneIds, layout: { ...container.layout, itemIds: paneIds } };
    });
    const snapshot = {
      ...current,
      containers: nextContainers,
      panes: current.panes.map((candidate) =>
        candidate.id === paneId ? { ...candidate, containerId: toContainerId } : candidate,
      ),
    };
    persistCommand(
      workspaceApi.moveWorkspacePane({ workspaceId: target.projectId, paneId, toContainerId, index }),
      "pane move",
      [
        `pane:${paneId}`,
        `container:${source.id}:panes`,
        `container:${toContainerId}:panes`,
        `project:${target.projectId}`,
      ],
    );
    persist({ ...get(), snapshot });
    set({ snapshot });
  },

  setWorkspaceLayout: (projectId, layout) => {
    const snapshot = updateSnapshotWorkspaceLayout(get().snapshot, projectId, layout);
    if (!snapshot) return;
    persistCommand(
      workspaceApi.setWorkspaceLayout(projectId, normalizeLayout(layout)),
      "workspace layout",
      [`project:${projectId}`],
    );
    persist({ ...get(), snapshot });
    set({ snapshot });
  },

  setWorkspaceCollapsed: (projectId, isCollapsed) => {
    const snapshot = get().snapshot;
    if (!snapshot) return;
    const next = {
      ...snapshot,
      projects: snapshot.projects.map((project) =>
        project.id === projectId ? { ...project, isCollapsed } : project,
      ),
    };
    persistCommand(
      workspaceApi.setWorkspaceCollapsed(projectId, isCollapsed),
      "workspace collapsed",
      [`project:${projectId}`],
    );
    persist({ ...get(), snapshot: next });
    set({ snapshot: next });
  },

  setGroupSuspended: (groupId, isSuspended) => {
    markNewerProjection();
    const snapshot = patchGroup(get().snapshot, groupId, { isSuspended });
    persist({ ...get(), snapshot });
    set({
      snapshot,
      groups: get().groups.map((group) =>
        group.id === groupId ? { ...group, isSuspended } : group,
      ),
    });
  },

  setProjectGroup: (projectId, groupId) => {
    markNewerProjection();
    const snapshot = patchProjectGroup(get().snapshot, projectId, groupId);
    persist({ ...get(), snapshot });
    set({
      snapshot,
      groups: snapshot?.groups ?? get().groups,
    });
  },

  setActivePane: (paneId) => {
    const snapshot = get().snapshot;
    if (!snapshot) return;
    const activePane = snapshot.panes.find((pane) => pane.id === paneId) ?? null;
    const activeContainer = activePane
      ? snapshot.containers.find(
          (container) =>
            container.id === activePane.containerId || container.paneIds.includes(activePane.id),
        )
      : null;
    const next = {
      ...snapshot,
      activePaneId: activePane?.id ?? null,
      activeProjectId: activePane?.projectId ?? snapshot.activeProjectId,
      activeContainerId: activeContainer?.id ?? snapshot.activeContainerId,
      projects: snapshot.projects.map((project) =>
        project.id === activePane?.projectId
          ? {
              ...project,
              activePaneId: activePane.id ?? null,
              activeContainerId: activeContainer?.id ?? project.activeContainerId,
            }
          : project,
      ),
    };
    if (activePane?.projectId) {
      persistCommand(
        workspaceApi.setActivePane({
          workspaceId: activePane.projectId,
          paneId: activePane?.id ?? null,
        }),
        "active pane",
        ["active-pane", `project:${activePane.projectId}`],
      );
    } else {
      markNewerProjection();
    }
    persist({ ...get(), snapshot: next });
    set({ snapshot: next });
  },

  clearPersistenceError: () => set({ persistenceError: null }),

  setTerminalDetached: (terminalId, isDetached) => {
    const normalized = terminalId.trim();
    if (!normalized) return;
    const current = get().detachedTerminalIds;
    const next = isDetached
      ? [...new Set([...current, normalized])]
      : current.filter((id) => id !== normalized);
    if (next.length === current.length && next.every((id, index) => id === current[index])) return;
    markNewerProjection();
    persist({ ...get(), detachedTerminalIds: next });
    set({ detachedTerminalIds: next });
  },

  detachTerminal: (terminalId) => get().setTerminalDetached(terminalId, true),
  reattachTerminal: (terminalId) => get().setTerminalDetached(terminalId, false),

  reset: () => {
    markNewerProjection();
    const next = emptyState();
    persist({ containerVisibility: next.containerVisibility, flags: next.flags, snapshot: next.snapshot });
    set(next);
  },
  };
});

