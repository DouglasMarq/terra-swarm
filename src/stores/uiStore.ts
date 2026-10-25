import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

const UI_STORAGE_KEY = "terra-ui-selection";

type UiState = {
  activeId: string | null;
  expandedId: string | null;
  focusedId: string | null;
  setActiveId: (
    id: string | null | ((current: string | null) => string | null),
  ) => void;
  setExpandedId: (
    id: string | null | ((current: string | null) => string | null),
  ) => void;
  setFocusedId: (
    id: string | null | ((current: string | null) => string | null),
  ) => void;
};

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      activeId: null,
      expandedId: null,
      focusedId: null,
      setActiveId: (value) =>
        set((state) => ({
          activeId: typeof value === "function" ? value(state.activeId) : value,
        })),
      setExpandedId: (value) =>
        set((state) => ({
          expandedId: typeof value === "function" ? value(state.expandedId) : value,
        })),
      setFocusedId: (value) =>
        set((state) => ({
          focusedId: typeof value === "function" ? value(state.focusedId) : value,
        })),
    }),
    {
      name: UI_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ activeId, expandedId, focusedId }) => ({
        activeId,
        expandedId,
        focusedId,
      }),
    },
  ),
);

export type { UiState };
