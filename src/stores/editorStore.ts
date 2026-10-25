import { create } from "zustand";

export interface EditorTarget {
  workspaceId: string;
  path: string;
}

interface EditorState {
  target: EditorTarget | null;
  open: (target: EditorTarget) => void;
  close: () => void;
}

export const useEditorStore = create<EditorState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));
