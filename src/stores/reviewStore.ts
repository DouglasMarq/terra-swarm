import { create } from "zustand";

export interface ReviewTarget {
  workspaceId: string;
  terminalId: string;
  /** How the agent is shown to the user. */
  label: string;
}

interface ReviewState {
  target: ReviewTarget | null;
  open: (target: ReviewTarget) => void;
  close: () => void;
}

/** Which isolated agent's changes the review dialog shows. */
export const useReviewStore = create<ReviewState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));
