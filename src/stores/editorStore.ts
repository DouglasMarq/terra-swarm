import { create } from "zustand";

export interface EditorTarget {
  workspaceId: string;
  /** Workspace-relative path. */
  path: string;
}

interface EditorState {
  target: EditorTarget | null;
  open: (target: EditorTarget) => void;
  close: () => void;
}

/** Which file the built-in editor shows. */
export const useEditorStore = create<EditorState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));
