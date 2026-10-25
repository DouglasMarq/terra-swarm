import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { FULL_PERCENT } from "../lib/math/percent";
import { safeStorage } from "../lib/storage/safeStorage";

export const SHELL_STORAGE_KEY = "terra-shell-state";
export const SHELL_STATE_VERSION = 4;
const MAX_HISTORY_ENTRIES = 100;
const MAX_RECENTLY_CLOSED_TABS = 20;
const ENTRY_ID_RADIX = 36;
const ENTRY_ID_RANDOM_END = 7;

export type ShellPanelLayout = Record<string, number>;

export type ShellSurface =
  | "workbench"
  | "fleet"
  | "board"
  | "settings";

export type DockTab = "inspector" | "tasks" | "preview";

export interface ShellWorkspaceTab {
  id: string;
  label: string;
  workspaceId: string;
  state?: "ready" | "busy" | "attention" | "paused";
  isPinned?: boolean;
}

export interface ShellHistoryEntry {
  id: string;
  surface: ShellSurface;
  workspaceId: string | null;
  at: number;
}

export interface ShellDockState {
  isOpen: boolean;
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
  panelLayout: ShellPanelLayout | null;
  navigatorCollapsedIds: string[];
  isSidebarCollapsed: boolean;
}

export interface ShellState extends ShellStateData {
  navigate: (surface: ShellSurface, workspaceId?: string | null) => void;
  goBack: () => void;
  goForward: () => void;
  setDockOpen: (isOpen: boolean) => void;
  toggleDock: () => void;
  setDockTab: (tab: DockTab) => void;
  openWorkspaceTab: (tab: ShellWorkspaceTab) => void;
  closeWorkspaceTab: (workspaceId: string) => void;
  reopenWorkspaceTab: (workspaceId?: string) => void;
  selectWorkspaceTab: (workspaceId: string) => void;
  reorderWorkspaceTabs: (workspaceIds: readonly string[]) => void;
  setPanelLayout: (layout: ShellPanelLayout) => void;
  setNavigatorCollapsedIds: (ids: readonly string[]) => void;
  setSidebarCollapsed: (isCollapsed: boolean) => void;
  toggleSidebar: () => void;
  reset: () => void;
}

const DEFAULT_DOCK: ShellDockState = {
  isOpen: false,
  activeTab: "inspector",
};

const DEFAULT_SURFACE: ShellSurface = "workbench";

const SURFACES: readonly ShellSurface[] = [
  "workbench",
  "fleet",
  "board",
  "settings",
];

const LEGACY_SURFACES: Readonly<Record<string, ShellSurface>> = {
  home: "workbench",
  events: "fleet",
};

const DOCK_TABS: readonly DockTab[] = ["inspector", "tasks", "preview"];

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
    .map(([id, size]) => [id, Math.max(0, Math.min(FULL_PERCENT, size))] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

type LegacyShellWorkspaceTab = Partial<ShellWorkspaceTab> & { pinned?: unknown };

type LegacyShellDockState = Partial<ShellDockState> & { open?: unknown };

type LegacyShellStateData = Partial<ShellStateData> & { sidebarCollapsed?: unknown };

function normalizeTab(value: unknown): ShellWorkspaceTab | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as LegacyShellWorkspaceTab;
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
    ...((candidate.isPinned ?? candidate.pinned) === true ? { isPinned: true } : {}),
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
    id: `${surface}:${workspaceId ?? "none"}:${Date.now()}:${Math.random().toString(ENTRY_ID_RADIX).slice(2, ENTRY_ID_RANDOM_END)}`,
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
    isSidebarCollapsed: false,
  };
}

export function normalizeShellState(value: unknown): ShellStateData {
  const fallback = initialData();
  if (!value || typeof value !== "object") return fallback;
  const candidate = value as LegacyShellStateData;
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
    .slice(0, MAX_RECENTLY_CLOSED_TABS);
  const history = (Array.isArray(candidate.history) ? candidate.history : [])
    .map(normalizeHistoryEntry)
    .filter((entry): entry is ShellHistoryEntry => entry !== null)
    .slice(-MAX_HISTORY_ENTRIES);
  const safeHistory = history.length > 0 ? history : fallback.history;
  const requestedIndex = typeof candidate.historyIndex === "number"
    ? Math.floor(candidate.historyIndex)
    : safeHistory.length - 1;
  const historyIndex = Math.max(0, Math.min(requestedIndex, safeHistory.length - 1));
  const current = safeHistory[historyIndex] ?? fallback.history[0];
  const requestedWorkspace = cleanId(candidate.activeWorkspaceId);
  const activeWorkspaceId = requestedWorkspace ?? current.workspaceId;
  const dockCandidate: LegacyShellDockState = candidate.dock && typeof candidate.dock === "object"
    ? candidate.dock
    : DEFAULT_DOCK;
  const dock: ShellDockState = {
    isOpen: (dockCandidate.isOpen ?? dockCandidate.open) === true,
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
    isSidebarCollapsed: (candidate.isSidebarCollapsed ?? candidate.sidebarCollapsed) === true,
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

      setDockOpen: (isOpen) => set((state) => ({ dock: { ...state.dock, isOpen } })),

      toggleDock: () =>
        set((state) => ({ dock: { ...state.dock, isOpen: !state.dock.isOpen } })),

      setDockTab: (activeTab) =>
        set((state) => ({
          dock: { activeTab, isOpen: true },
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
          ].slice(0, MAX_RECENTLY_CLOSED_TABS);
          if (state.activeWorkspaceId !== id) return { workspaceTabs, recentlyClosedTabs };
          const fallbackEntry = state.history
            .slice(0, state.historyIndex)
            .reverse()
            .find((entry) => entry.workspaceId !== id) ??
            newHistoryEntry("workbench", null);
          const history = [...state.history, fallbackEntry].slice(-MAX_HISTORY_ENTRIES);
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
        if (!tab) return;
        set((state) => ({
          workspaceTabs: [...state.workspaceTabs, tab],
          recentlyClosedTabs: state.recentlyClosedTabs.filter(
            (item) => item.workspaceId !== tab.workspaceId,
          ),
        }));
        get().navigate("workbench", tab.workspaceId);
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
        set((state) => ({ panelLayout: { ...(state.panelLayout ?? {}), ...normalized } }));
      },

      setNavigatorCollapsedIds: (ids) => {
        set({
          navigatorCollapsedIds: [...new Set(ids.map(cleanId).filter((id): id is string => id !== null))],
        });
      },

      setSidebarCollapsed: (isSidebarCollapsed) => set({ isSidebarCollapsed }),

      toggleSidebar: () => set((state) => ({ isSidebarCollapsed: !state.isSidebarCollapsed })),

      reset: () => set(initialData()),
    }),
    {
      name: SHELL_STORAGE_KEY,
      version: SHELL_STATE_VERSION,
      storage: createJSONStorage(() => safeStorage),
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
        isSidebarCollapsed: state.isSidebarCollapsed,
      }),
      migrate: (persistedState) => normalizeShellState(persistedState),
    },
  ),
);

export type { ShellStateData as PersistedShellState };
