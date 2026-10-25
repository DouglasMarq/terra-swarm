import type { Dispatch, SetStateAction } from "react";
import { api } from "../api";
import type { Workspace } from "../domain/workspace.model";
import { GRID_COL_OPTIONS, usePreferencesStore } from "../stores/preferencesStore";

const FULL_WIDTH_PERCENT = 100;

interface GridLayoutOptions {
  workspaces: readonly Workspace[];
  setWorkspaces: Dispatch<SetStateAction<Workspace[]>>;
  refresh: () => Promise<void>;
}

function isGridColumnOption(cols: number): boolean {
  return GRID_COL_OPTIONS.some((option) => option === cols);
}

export function useGridLayout({ workspaces, setWorkspaces, refresh }: GridLayoutOptions) {
  return async (cols: number) => {
    if (!isGridColumnOption(cols)) return;
    usePreferencesStore.getState().setGridCols(cols);
    const basis = Math.floor(FULL_WIDTH_PERCENT / cols);
    const targets = workspaces.flatMap((workspace) =>
      workspace.terminals.map((terminal) => ({ wsId: workspace.id, id: terminal.id })),
    );
    setWorkspaces((prev) =>
      prev.map((workspace) => ({
        ...workspace,
        terminals: workspace.terminals.map((terminal) => ({ ...terminal, width: basis })),
      })),
    );
    await Promise.all(
      targets.map(({ wsId, id }) =>
        api.setTerminalWidth(wsId, id, basis).catch((error) => console.warn(`failed to resize terminal ${id}:`, error)),
      ),
    );
    await refresh();
  };
}
