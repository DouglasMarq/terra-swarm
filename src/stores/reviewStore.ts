import { create } from "zustand";

export interface ReviewTarget {
  workspaceId: string;
  terminalId: string;
  label: string;
}

interface ReviewState {
  target: ReviewTarget | null;
  open: (target: ReviewTarget) => void;
  close: () => void;
}

export const useReviewStore = create<ReviewState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));
