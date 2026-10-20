import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export const SHELL_STORAGE_KEY = "terra-shell-state";
export const SHELL_STATE_VERSION = 3;
/** Back/forward navigation entries kept. */
const MAX_HISTORY_ENTRIES = 100;

export type ShellPanelLayout = Record<string, number>;

export type ShellSurface =
  | "workbench"
  | "fleet"
  | "board"
  | "settings";

/** The right dock hosts the agent inspector, the shared tasks and the dev server preview. */
export type DockTab = "inspector" | "tasks" | "preview";

export interface ShellWorkspaceTab {
  id: string;
  label: string;
  workspaceId: string;
  /** A visual hint used by the chrome; it does not control the PTY lifecycle. */
  state?: "ready" | "busy" | "attention" | "paused";
  pinned?: boolean;
}

export interface ShellHistoryEntry {
  id: string;
  surface: ShellSurface;
  workspaceId: string | null;
  at: number;
}

export interface ShellDockState {
  open: boolean;
  activeTab: DockTab;
}

export interface ShellStateData {
  version: typeof SHELL_STATE_VERSION;
  activeSurface: ShellSurface;
  activeWorkspaceId: string | null;
  dock: ShellDockState;
  workspaceTabs: ShellWorkspaceTab[];
  recentlyClosedTabs: ShellWorkspaceTab[];
  history: ShellHistoryEntry[];
  historyIndex: number;
  /** Last desktop navigator/content/dock proportions reported by the shell. */
  panelLayout: ShellPanelLayout | null;
  /** Durable disclosure state for the hierarchical Navigator. */
  navigatorCollapsedIds: string[];
  /** The sidebar collapses to a 56px rail of project initials and agent dots. */
  sidebarCollapsed: boolean;
}

export interface ShellState extends ShellStateData {
  navigate: (surface: ShellSurface, workspaceId?: string | null) => void;
  goBack: () => void;
  goForward: () => void;
  setDockOpen: (open: boolean) => void;
  toggleDock: () => void;
  setDockTab: (tab: DockTab) => void;
  openWorkspaceTab: (tab: ShellWorkspaceTab) => void;
  closeWorkspaceTab: (workspaceId: string) => void;
  reopenWorkspaceTab: (workspaceId?: string) => boolean;
  selectWorkspaceTab: (workspaceId: string) => void;
  /** Reorders the visual workspace strip without affecting workspace lifecycle. */
  reorderWorkspaceTabs: (workspaceIds: readonly string[]) => void;
  setPanelLayout: (layout: ShellPanelLayout) => void;
  setNavigatorCollapsedIds: (ids: readonly string[]) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  reset: () => void;
}

const DEFAULT_DOCK: ShellDockState = {
  open: false,
  activeTab: "inspector",
};

const DEFAULT_SURFACE: ShellSurface = "workbench";

const SURFACES: readonly ShellSurface[] = [
  "workbench",
  "fleet",
  "board",
  "settings",
];

/** v2 surfaces that v3 folded into others: Home into the Workbench, Events into the Fleet. */
const LEGACY_SURFACES: Readonly<Record<string, ShellSurface>> = {
  home: "workbench",
  events: "fleet",
};

const DOCK_TABS: readonly DockTab[] = ["inspector", "tasks", "preview"];

const NOOP_STORAGE: Storage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
  clear: () => undefined,
  key: () => null,
  length: 0,
};

function storage(): Storage {
  return typeof localStorage === "undefined" ? NOOP_STORAGE : localStorage;
}

function isSurface(value: unknown): value is ShellSurface {
  return typeof value === "string" && SURFACES.includes(value as ShellSurface);
}

function toSurface(value: unknown): ShellSurface | null {
  if (isSurface(value)) return value;
  return typeof value === "string" ? LEGACY_SURFACES[value] ?? null : null;
}

function isDockTab(value: unknown): value is DockTab {
  return typeof value === "string" && DOCK_TABS.includes(value as DockTab);
}

function cleanId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizePanelLayout(value: unknown): ShellPanelLayout | null {
  if (!value || typeof value !== "object") return null;
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([id, size]) => [cleanId(id), size] as const)
    .filter((entry): entry is readonly [string, number] =>
      entry[0] !== null && typeof entry[1] === "number" && Number.isFinite(entry[1]),
    )
    .map(([id, size]) => [id, Math.max(0, Math.min(100, size))] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function normalizeTab(value: unknown): ShellWorkspaceTab | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ShellWorkspaceTab>;
  const id = cleanId(candidate.id);
  const workspaceId = cleanId(candidate.workspaceId ?? candidate.id);
  if (!id || !workspaceId) return null;
  const label = typeof candidate.label === "string" && candidate.label.trim()
    ? candidate.label.trim()
    : workspaceId;
  const state = ["ready", "busy", "attention", "paused"].includes(
    candidate.state ?? "",
  )
    ? candidate.state
    : undefined;
  return {
    id,
    workspaceId,
    label,
    ...(state ? { state } : {}),
    ...(candidate.pinned === true ? { pinned: true } : {}),
  };
}

function normalizeHistoryEntry(value: unknown, index: number): ShellHistoryEntry | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ShellHistoryEntry>;
  const surface = toSurface(candidate.surface);
  if (!surface) return null;
  const id = cleanId(candidate.id) ?? `history-${index}`;
  const workspaceId = cleanId(candidate.workspaceId);
  const at = typeof candidate.at === "number" && Number.isFinite(candidate.at)
    ? candidate.at
    : index;
  return { id, surface, workspaceId, at };
}

function newHistoryEntry(
  surface: ShellSurface,
  workspaceId: string | null,
): ShellHistoryEntry {
  return {
    id: `${surface}:${workspaceId ?? "none"}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
    surface,
    workspaceId,
    at: Date.now(),
  };
}

function initialData(): ShellStateData {
  const first = newHistoryEntry(DEFAULT_SURFACE, null);
  return {
    version: SHELL_STATE_VERSION,
    activeSurface: DEFAULT_SURFACE,
    activeWorkspaceId: null,
    dock: { ...DEFAULT_DOCK },
    workspaceTabs: [],
    recentlyClosedTabs: [],
    history: [first],
    historyIndex: 0,
    panelLayout: null,
    navigatorCollapsedIds: [],
    sidebarCollapsed: false,
  };
}

/**
 * Keep persisted shell state deliberately small and defensive. The shell can
 * be mounted before the backend has returned its workspace list, so unknown
 * workspace ids are retained as navigation history but never manufacture a
 * terminal or project.
 */
export function normalizeShellState(value: unknown): ShellStateData {
  const fallback = initialData();
  if (!value || typeof value !== "object") return fallback;
  const candidate = value as Partial<ShellStateData>;
  const activeSurface = toSurface(candidate.activeSurface) ?? fallback.activeSurface;
  const rawTabs = Array.isArray(candidate.workspaceTabs)
    ? candidate.workspaceTabs
    : [];
  const workspaceTabs = rawTabs
    .map(normalizeTab)
    .filter((tab): tab is ShellWorkspaceTab => tab !== null)
    .filter((tab, index, all) => all.findIndex((other) => other.workspaceId === tab.workspaceId) === index);
  const rawClosed = Array.isArray(candidate.recentlyClosedTabs)
    ? candidate.recentlyClosedTabs
    : [];
  const openWorkspaceIds = new Set(workspaceTabs.map((tab) => tab.workspaceId));
  const recentlyClosedTabs = rawClosed
    .map(normalizeTab)
    .filter((tab): tab is ShellWorkspaceTab => tab !== null)
    .filter((tab, index, all) =>
      !openWorkspaceIds.has(tab.workspaceId) &&
      all.findIndex((other) => other.workspaceId === tab.workspaceId) === index,
    )
    .slice(0, 20);
  const history = (Array.isArray(candidate.history) ? candidate.history : [])
    .map(normalizeHistoryEntry)
    .filter((entry): entry is ShellHistoryEntry => entry !== null)
    .slice(-100);
  const safeHistory = history.length > 0 ? history : fallback.history;
  const requestedIndex = typeof candidate.historyIndex === "number"
    ? Math.floor(candidate.historyIndex)
    : safeHistory.length - 1;
  const historyIndex = Math.max(0, Math.min(requestedIndex, safeHistory.length - 1));
  const current = safeHistory[historyIndex] ?? fallback.history[0];
  const requestedWorkspace = cleanId(candidate.activeWorkspaceId);
  const activeWorkspaceId = requestedWorkspace ?? current.workspaceId;
  const dockCandidate = candidate.dock && typeof candidate.dock === "object"
    ? candidate.dock
    : DEFAULT_DOCK;
  const dock: ShellDockState = {
    open: dockCandidate.open === true,
    activeTab: isDockTab(dockCandidate.activeTab)
      ? dockCandidate.activeTab
      : DEFAULT_DOCK.activeTab,
  };
  const panelLayout = normalizePanelLayout(candidate.panelLayout ?? (candidate as { layout?: unknown }).layout);
  const navigatorCollapsedIds = Array.isArray(candidate.navigatorCollapsedIds)
    ? [...new Set(candidate.navigatorCollapsedIds.map(cleanId).filter((id): id is string => id !== null))]
    : [];
  return {
    version: SHELL_STATE_VERSION,
    activeSurface,
    activeWorkspaceId,
    dock,
    workspaceTabs,
    recentlyClosedTabs,
    history: safeHistory,
    historyIndex,
    panelLayout,
    navigatorCollapsedIds,
    sidebarCollapsed: candidate.sidebarCollapsed === true,
  };
}

function currentEntry(state: ShellStateData): ShellHistoryEntry {
  return state.history[state.historyIndex] ?? {
    ...newHistoryEntry(state.activeSurface, state.activeWorkspaceId),
  };
}

const initial = initialData();

export const useShellStore = create<ShellState>()(
  persist(
    (set, get) => ({
      ...initial,

      navigate: (surface, workspaceId = null) => {
        const safeWorkspaceId = cleanId(workspaceId);
        set((state) => {
          const current = currentEntry(state);
          if (
            current.surface === surface &&
            current.workspaceId === safeWorkspaceId
          ) {
            return {
              activeSurface: surface,
              activeWorkspaceId: safeWorkspaceId,
            };
          }
          const branch = state.history.slice(0, state.historyIndex + 1);
          const nextEntry = newHistoryEntry(surface, safeWorkspaceId);
          return {
            activeSurface: surface,
            activeWorkspaceId: safeWorkspaceId,
            history: [...branch, nextEntry].slice(-MAX_HISTORY_ENTRIES),
            historyIndex: Math.min(branch.length, MAX_HISTORY_ENTRIES - 1),
          };
        });
      },

      goBack: () => {
        set((state) => {
          if (state.historyIndex <= 0) return state;
          const nextIndex = state.historyIndex - 1;
          const entry = state.history[nextIndex];
          return {
            historyIndex: nextIndex,
            activeSurface: entry.surface,
            activeWorkspaceId: entry.workspaceId,
          };
        });
      },

      goForward: () => {
        set((state) => {
          if (state.historyIndex >= state.history.length - 1) return state;
          const nextIndex = state.historyIndex + 1;
          const entry = state.history[nextIndex];
          return {
            historyIndex: nextIndex,
            activeSurface: entry.surface,
            activeWorkspaceId: entry.workspaceId,
          };
        });
      },

      setDockOpen: (open) => set((state) => ({ dock: { ...state.dock, open } })),

      toggleDock: () =>
        set((state) => ({ dock: { ...state.dock, open: !state.dock.open } })),

      setDockTab: (activeTab) =>
        set((state) => ({
          dock: { activeTab, open: true },
          activeSurface: state.activeSurface,
        })),

      openWorkspaceTab: (tab) => {
        const normalized = normalizeTab(tab);
        if (!normalized) return;
        set((state) => {
          const existingIndex = state.workspaceTabs.findIndex(
            (item) => item.workspaceId === normalized.workspaceId,
          );
          const workspaceTabs = existingIndex < 0
            ? [...state.workspaceTabs, normalized]
            : state.workspaceTabs.map((item, index) =>
                index === existingIndex ? normalized : item,
              );
          const recentlyClosedTabs = state.recentlyClosedTabs.filter(
            (item) => item.workspaceId !== normalized.workspaceId,
          );
          return { workspaceTabs, recentlyClosedTabs };
        });
      },

      closeWorkspaceTab: (workspaceId) => {
        const id = cleanId(workspaceId);
        if (!id) return;
        set((state) => {
          const tab = state.workspaceTabs.find((item) => item.workspaceId === id);
          if (!tab) return state;
          const workspaceTabs = state.workspaceTabs.filter((item) => item.workspaceId !== id);
          const recentlyClosedTabs = [
            tab,
            ...state.recentlyClosedTabs.filter((item) => item.workspaceId !== id),
          ].slice(0, 20);
          if (state.activeWorkspaceId !== id) return { workspaceTabs, recentlyClosedTabs };
          const fallbackEntry = state.history
            .slice(0, state.historyIndex)
            .reverse()
            .find((entry) => entry.workspaceId !== id) ??
            newHistoryEntry("workbench", null);
          const history = [...state.history, fallbackEntry].slice(-100);
          return {
            workspaceTabs,
            recentlyClosedTabs,
            activeSurface: fallbackEntry.surface,
            activeWorkspaceId: fallbackEntry.workspaceId,
            history,
            historyIndex: history.length - 1,
          };
        });
      },

      reopenWorkspaceTab: (workspaceId) => {
        const id = cleanId(workspaceId);
        const tab = get().recentlyClosedTabs.find((item) =>
          id ? item.workspaceId === id : true,
        );
        if (!tab) return false;
        set((state) => ({
          workspaceTabs: [...state.workspaceTabs, tab],
          recentlyClosedTabs: state.recentlyClosedTabs.filter(
            (item) => item.workspaceId !== tab.workspaceId,
          ),
        }));
        get().navigate("workbench", tab.workspaceId);
        return true;
      },

      selectWorkspaceTab: (workspaceId) => {
        const tab = get().workspaceTabs.find((item) => item.workspaceId === workspaceId);
        if (!tab) return;
        get().navigate("workbench", tab.workspaceId);
      },

      reorderWorkspaceTabs: (workspaceIds) => {
        set((state) => {
          const currentIds = state.workspaceTabs.map((tab) => tab.workspaceId);
          const allowed = new Set(currentIds);
          const requested = workspaceIds
            .map(cleanId)
            .filter((id): id is string => id !== null && allowed.has(id));
          const orderedIds = [...new Set([...requested, ...currentIds])];
          if (orderedIds.every((id, index) => id === currentIds[index])) return state;
          const byWorkspaceId = new Map(
            state.workspaceTabs.map((tab) => [tab.workspaceId, tab]),
          );
          return {
            workspaceTabs: orderedIds
              .map((id) => byWorkspaceId.get(id))
              .filter((tab): tab is ShellWorkspaceTab => tab !== undefined),
          };
        });
      },

      setPanelLayout: (layout) => {
        const normalized = normalizePanelLayout(layout);
        if (!normalized) return;
        // A closed desktop dock yields a two-panel callback. Keep its last
        // known size so reopening the dock restores the full three-panel
        // composition instead of falling back to defaults.
        set((state) => ({ panelLayout: { ...(state.panelLayout ?? {}), ...normalized } }));
      },

      setNavigatorCollapsedIds: (ids) => {
        set({
          navigatorCollapsedIds: [...new Set(ids.map(cleanId).filter((id): id is string => id !== null))],
        });
      },

      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),

      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

      reset: () => set(initialData()),
    }),
    {
      name: SHELL_STORAGE_KEY,
      version: SHELL_STATE_VERSION,
      storage: createJSONStorage(storage),
      partialize: (state) => ({
        version: SHELL_STATE_VERSION,
        activeSurface: state.activeSurface,
        activeWorkspaceId: state.activeWorkspaceId,
        dock: state.dock,
        workspaceTabs: state.workspaceTabs,
        recentlyClosedTabs: state.recentlyClosedTabs,
        history: state.history,
        historyIndex: state.historyIndex,
        panelLayout: state.panelLayout,
        navigatorCollapsedIds: state.navigatorCollapsedIds,
        sidebarCollapsed: state.sidebarCollapsed,
      }),
      migrate: (persistedState) => normalizeShellState(persistedState),
    },
  ),
);

export type { ShellStateData as PersistedShellState };
