import { create } from "zustand";
import { t } from "../i18n";

export interface SavedPrompt {
  id: string;
  title: string;
  body: string;
}

const STORAGE_KEY = "terra-prompt-library";

/** Starting points in the user's language; they can edit or delete them. */
function defaultPrompts(): SavedPrompt[] {
  return [
    { id: "review-diff", title: t("library.defaults.reviewTitle"), body: t("library.defaults.reviewBody") },
    { id: "write-tests", title: t("library.defaults.testsTitle"), body: t("library.defaults.testsBody") },
    { id: "plan-goal", title: t("library.defaults.planTitle"), body: t("library.defaults.planBody") },
  ];
}

function load(): SavedPrompt[] {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultPrompts();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaultPrompts();
    return parsed.filter(
      (item): item is SavedPrompt =>
        Boolean(item) && typeof item.id === "string" && typeof item.title === "string" && typeof item.body === "string",
    );
  } catch {
    return defaultPrompts();
  }
}

function persist(prompts: readonly SavedPrompt[]) {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, JSON.stringify(prompts));
  } catch {
    // Private mode or full storage: the library still works for this session.
  }
}

/** `{project}` becomes the active project's name. */
export function fillPrompt(body: string, values: { project?: string | null }): string {
  return body.replace(/\{project\}/g, values.project?.trim() || "this project");
}

export type LibraryDialog = "prompts" | "team" | null;

interface LibraryState {
  prompts: SavedPrompt[];
  dialog: LibraryDialog;
  openDialog: (dialog: Exclude<LibraryDialog, null>) => void;
  closeDialog: () => void;
  savePrompt: (prompt: { id?: string; title: string; body: string }) => SavedPrompt;
  deletePrompt: (id: string) => void;
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  prompts: load(),
  dialog: null,
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null }),
  savePrompt: ({ id, title, body }) => {
    const saved: SavedPrompt = {
      id: id ?? `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      title: title.trim() || body.trim().split(/\s+/).slice(0, 6).join(" ") || "Prompt",
      body,
    };
    const exists = get().prompts.some((prompt) => prompt.id === saved.id);
    const prompts = exists ? get().prompts.map((prompt) => (prompt.id === saved.id ? saved : prompt)) : [...get().prompts, saved];
    persist(prompts);
    set({ prompts });
    return saved;
  },
  deletePrompt: (id) => {
    const prompts = get().prompts.filter((prompt) => prompt.id !== id);
    persist(prompts);
    set({ prompts });
  },
}));
