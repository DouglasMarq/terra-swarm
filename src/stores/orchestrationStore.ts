import { t } from "../i18n";
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
  /** Visual detachments are durable UI state; they never imply PTY death. */
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

function persist(
  containerVisibility: Record<string, boolean>,
  flags: FeatureFlags,
  snapshot: WorkspaceSnapshotV2 | null,
  detachedTerminalIds: readonly string[] = [],
): void {
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
    ...(patch.visible === undefined ? {} : { visible: patch.visible, closed: !patch.visible }),
    ...(patch.closed === undefined ? {} : { closed: patch.closed, visible: !patch.closed }),
    ...(patch.collapsed === undefined ? {} : { collapsed: patch.collapsed }),
    ...(patch.fullscreen === undefined ? {} : { fullscreen: patch.fullscreen }),
    ...(patch.internalLayout === undefined ? {} : { internalLayout: patch.internalLayout }),
    ...(patch.size === undefined ? {} : { size: patch.size }),
    ...(patch.activePaneId === undefined && !patch.clearActivePane
      ? {}
      : { activePaneId: patch.clearActivePane ? null : patch.activePaneId ?? null }),
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
  /** The normalized v2 domain snapshot derived from the legacy API. */
  snapshot: WorkspaceSnapshotV2 | null;
  /** Convenience projection for sidebar and command handlers. */
  groups: Group[];
  /** `false` means the visual container is hidden, never that its PTYs died. */
  containerVisibility: Record<string, boolean>;
  /** Terminal ids hidden from the visual tab strip while their PTYs continue. */
  detachedTerminalIds: string[];
  flags: FeatureFlags;
  hydrated: boolean;
  /** Last rejected durable layout command, surfaced once by the shell. */
  persistenceError: OrchestrationPersistenceError | null;
  sync: (workspaces: readonly Workspace[], groups?: readonly WorkspaceGroup[]) => void;
  hydrate: (workspaces: readonly Workspace[], groups?: readonly WorkspaceGroup[]) => void;
  syncWorkspaces: (workspaces: readonly Workspace[], groups?: readonly WorkspaceGroup[]) => void;
  setFeatureFlag: (id: FeatureFlagId, enabled: boolean) => void;
  setFlag: (id: FeatureFlagId, enabled: boolean) => void;
  setFeatureFlags: (flags: Partial<FeatureFlags>) => void;
  setContainerVisible: (containerId: string, visible: boolean) => void;
  setContainerVisibility: (containerId: string, visible: boolean) => void;
  openContainer: (containerId: string) => void;
  closeContainer: (containerId: string) => void;
  toggleContainer: (containerId: string) => void;
  setContainerState: (containerId: string, patch: WorkspaceContainerPatch) => void;
  setContainerCollapsed: (containerId: string, collapsed: boolean) => void;
  setContainerFullscreen: (containerId: string, fullscreen: boolean) => void;
  setContainerActivePane: (containerId: string, paneId: string | null) => void;
  setContainerInternalLayout: (containerId: string, internalLayout: string) => void;
  reorderContainers: (projectId: string, order: string[]) => void;
  reorderPanes: (containerId: string, order: string[]) => void;
  reorderTabs: (paneId: string, order: string[]) => void;
  movePane: (paneId: string, toContainerId: string, index?: number | null) => void;
  setWorkspaceLayout: (projectId: string, layout: WorkspaceLayout) => void;
  setWorkspaceCollapsed: (projectId: string, collapsed: boolean) => void;
  setGroupSuspended: (groupId: string, suspended: boolean) => void;
  setProjectGroup: (projectId: string, groupId: string | null) => void;
  setActivePane: (paneId: string | null) => void;
  clearPersistenceError: () => void;
  setTerminalDetached: (terminalId: string, detached: boolean) => void;
  detachTerminal: (terminalId: string) => void;
  reattachTerminal: (terminalId: string) => void;
  reset: () => void;
};

const emptyState = (): Pick<OrchestrationState, "snapshot" | "groups" | "containerVisibility" | "detachedTerminalIds" | "flags" | "hydrated" | "persistenceError"> => ({
  snapshot: null,
  groups: [],
  containerVisibility: {},
  detachedTerminalIds: [],
  flags: { ...DEFAULT_FEATURE_FLAGS },
  hydrated: false,
  persistenceError: null,
});

export const useOrchestrationStore = create<OrchestrationState>((set, get) => {
  const reportPersistenceError = (operation: string, error: unknown): void => {
    set({
      persistenceError: {
        operation,
        message: errorMessage(error, t("system.persistFailed")),
        at: Date.now(),
      },
    });
  };

  const { persistCommand, markNewerProjection } = createPersistenceEngine({
    read: () => get(),
    apply: (projection) => {
      persist(projection.containerVisibility, get().flags, projection.snapshot, projection.detachedTerminalIds);
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
    hydrated: persisted.snapshot !== null,
    persistenceError: null,

    sync: (workspaces, sourceGroups = []) => {
    // An explicit backend refresh is already authoritative. Any rejection
    // from a command issued before it must not replace this newer projection.
    markNewerProjection();
    const state = get();
    const derived = deriveSnapshot(
      workspaces,
      sourceGroups,
      state.containerVisibility,
      state.snapshot,
    );
    const terminalIds = new Set(
      workspaces.flatMap((workspace) => workspace.terminals.map((terminal) => terminal.id)),
    );
    const detachedTerminalIds = state.detachedTerminalIds.filter((id) => terminalIds.has(id));
    const knownContainerIds = new Set(derived.snapshot.containers.map((container) => container.id));
    const containerVisibility: Record<string, boolean> = {};
    for (const [id, visible] of Object.entries(state.containerVisibility)) {
      if (knownContainerIds.has(id)) containerVisibility[id] = visible;
    }
    for (const container of derived.snapshot.containers) {
      containerVisibility[container.id] = container.visible;
    }
    persist(containerVisibility, state.flags, derived.snapshot, detachedTerminalIds);
    set({
      snapshot: derived.snapshot,
      groups: derived.groups,
      containerVisibility,
      detachedTerminalIds,
      hydrated: true,
    });
  },

  hydrate: (workspaces, sourceGroups = []) =>
    get().sync(workspaces, sourceGroups),

  syncWorkspaces: (workspaces, sourceGroups = []) =>
    get().sync(workspaces, sourceGroups),

    setFeatureFlag: (id, enabled) => {
    if (!FEATURE_FLAG_IDS.includes(id)) return;
    markNewerProjection();
    const flags = { ...get().flags, [id]: enabled };
    persist(get().containerVisibility, flags, get().snapshot, get().detachedTerminalIds);
    set({ flags });
  },

  setFlag: (id, enabled) => get().setFeatureFlag(id, enabled),

  setFeatureFlags: (partial) => {
    markNewerProjection();
    const flags = normalizeFeatureFlags({ ...get().flags, ...partial });
    persist(get().containerVisibility, flags, get().snapshot, get().detachedTerminalIds);
    set({ flags });
  },

  setContainerVisible: (containerId, visible) => {
    const containerVisibility = {
      ...get().containerVisibility,
      [containerId]: visible,
    };
    const snapshot = updateSnapshotContainerState(get().snapshot, containerId, {
      visible,
      closed: !visible,
    });
    const container = snapshot?.containers.find((candidate) => candidate.id === containerId);
    if (container?.projectId) {
      persistCommand(
        workspaceApi.setWorkspaceContainerState(container.projectId, containerId, {
          visible,
          closed: !visible,
        }),
        "container visibility",
        [`container:${containerId}`],
      );
    } else {
      markNewerProjection();
    }
    persist(containerVisibility, get().flags, snapshot, get().detachedTerminalIds);
    set({ containerVisibility, snapshot });
  },

  setContainerVisibility: (containerId, visible) =>
    get().setContainerVisible(containerId, visible),

  openContainer: (containerId) => get().setContainerVisible(containerId, true),
  closeContainer: (containerId) => get().setContainerVisible(containerId, false),
  toggleContainer: (containerId) => {
    const visible = get().containerVisibility[containerId] ?? true;
    get().setContainerVisible(containerId, !visible);
  },

  setContainerState: (containerId, patch) => {
    const current = get().snapshot;
    const container = current?.containers.find((candidate) => candidate.id === containerId);
    const projectId = container?.projectId ?? null;
    const normalizedPatch: WorkspaceContainerPatch = {
      ...patch,
      ...(patch.activePaneId === null
        ? { activePaneId: undefined, clearActivePane: true }
        : {}),
    };
    let snapshot = updateSnapshotContainerState(current, containerId, patch);
    if (snapshot && projectId && (patch.activePaneId !== undefined || patch.clearActivePane)) {
      const activePaneId = patch.clearActivePane ? null : patch.activePaneId ?? null;
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
    if (patch.visible !== undefined) containerVisibility[containerId] = patch.visible;
    if (patch.closed !== undefined) containerVisibility[containerId] = !patch.closed;
    if (projectId) {
      const targets = [`container:${containerId}`];
      if (patch.activePaneId !== undefined || patch.clearActivePane) {
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
    persist(containerVisibility, get().flags, snapshot, get().detachedTerminalIds);
    set({ containerVisibility, snapshot });
  },

  setContainerCollapsed: (containerId, collapsed) =>
    get().setContainerState(containerId, { collapsed }),

  setContainerFullscreen: (containerId, fullscreen) =>
    get().setContainerState(containerId, { fullscreen }),

  setContainerActivePane: (containerId, paneId) =>
    get().setContainerState(containerId, {
      activePaneId: paneId,
      ...(paneId === null ? { clearActivePane: true } : {}),
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
    persist(get().containerVisibility, get().flags, snapshot, get().detachedTerminalIds);
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
    persist(get().containerVisibility, get().flags, snapshot, get().detachedTerminalIds);
    set({ snapshot });
  },

  reorderTabs: (paneId, order) => {
    const current = get().snapshot;
    const pane = current?.panes.find((candidate) => candidate.id === paneId);
    if (!current || !pane) return;
    const snapshot = updateSnapshotPaneTabs(current, paneId, order);
    if (!snapshot || snapshot === current) return;
    markNewerProjection();
    // There is no separate PTY mutation for a visual tab order. The v2
    // snapshot is the durable frontend projection, and `persist` keeps this
    // order through backend refreshes via mergeWorkspaceSnapshot.
    persist(get().containerVisibility, get().flags, snapshot, get().detachedTerminalIds);
    set({ snapshot });
  },

  movePane: (paneId, toContainerId, index) => {
    const current = get().snapshot;
    const pane = current?.panes.find((candidate) => candidate.id === paneId);
    const target = current?.containers.find((candidate) => candidate.id === toContainerId);
    const source = current?.containers.find((candidate) =>
      candidate.id === pane?.containerId || candidate.paneIds.includes(paneId),
    );
    // Pane moves are project-scoped. Reject a stale/forged cross-project
    // destination before constructing optimistic state or issuing IPC.
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
      workspaceApi.moveWorkspacePane(target.projectId, paneId, toContainerId, index),
      "pane move",
      [
        `pane:${paneId}`,
        `container:${source.id}:panes`,
        `container:${toContainerId}:panes`,
        `project:${target.projectId}`,
      ],
    );
    persist(get().containerVisibility, get().flags, snapshot, get().detachedTerminalIds);
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
    persist(get().containerVisibility, get().flags, snapshot, get().detachedTerminalIds);
    set({ snapshot });
  },

  setWorkspaceCollapsed: (projectId, collapsed) => {
    const snapshot = get().snapshot;
    if (!snapshot) return;
    const next = {
      ...snapshot,
      projects: snapshot.projects.map((project) =>
        project.id === projectId ? { ...project, collapsed } : project,
      ),
    };
    persistCommand(
      workspaceApi.setWorkspaceCollapsed(projectId, collapsed),
      "workspace collapsed",
      [`project:${projectId}`],
    );
    persist(get().containerVisibility, get().flags, next, get().detachedTerminalIds);
    set({ snapshot: next });
  },

  setGroupSuspended: (groupId, suspended) => {
    markNewerProjection();
    const snapshot = patchGroup(get().snapshot, groupId, { suspended });
    persist(get().containerVisibility, get().flags, snapshot, get().detachedTerminalIds);
    set({
      snapshot,
      groups: get().groups.map((group) =>
        group.id === groupId ? { ...group, suspended } : group,
      ),
    });
  },

  setProjectGroup: (projectId, groupId) => {
    markNewerProjection();
    const snapshot = patchProjectGroup(get().snapshot, projectId, groupId);
    persist(get().containerVisibility, get().flags, snapshot, get().detachedTerminalIds);
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
    persist(get().containerVisibility, get().flags, next, get().detachedTerminalIds);
    set({ snapshot: next });
  },

  clearPersistenceError: () => set({ persistenceError: null }),

  setTerminalDetached: (terminalId, detached) => {
    const normalized = terminalId.trim();
    if (!normalized) return;
    const current = get().detachedTerminalIds;
    const next = detached
      ? [...new Set([...current, normalized])]
      : current.filter((id) => id !== normalized);
    if (next.length === current.length && next.every((id, index) => id === current[index])) return;
    markNewerProjection();
    persist(get().containerVisibility, get().flags, get().snapshot, next);
    set({ detachedTerminalIds: next });
  },

  detachTerminal: (terminalId) => get().setTerminalDetached(terminalId, true),
  reattachTerminal: (terminalId) => get().setTerminalDetached(terminalId, false),

  reset: () => {
    // Reset is a newer local projection; pending failures must not restore
    // the state that existed before the reset.
    markNewerProjection();
    const next = emptyState();
    persist(next.containerVisibility, next.flags, next.snapshot);
    set(next);
  },
  };
});

