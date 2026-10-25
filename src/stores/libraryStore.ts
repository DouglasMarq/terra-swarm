import { create } from "zustand";
import { translateNow } from "../i18n";
import { storageGet, storageSet } from "../lib/storage/safeStorage";
import { promptTitle, type SavedPrompt } from "../domain/prompts";

const ID_RADIX = 36;
const RANDOM_ID_END = 6;

const STORAGE_KEY = "terra-prompt-library";

function defaultPrompts(): SavedPrompt[] {
  return [
    { id: "review-diff", title: translateNow("library.defaults.reviewTitle"), body: translateNow("library.defaults.reviewBody") },
    { id: "write-tests", title: translateNow("library.defaults.testsTitle"), body: translateNow("library.defaults.testsBody") },
    { id: "plan-goal", title: translateNow("library.defaults.planTitle"), body: translateNow("library.defaults.planBody") },
  ];
}

function load(): SavedPrompt[] {
  try {
    const raw = storageGet(STORAGE_KEY);
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
  storageSet(STORAGE_KEY, JSON.stringify(prompts));
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
      id: id ?? `p-${Date.now().toString(ID_RADIX)}-${Math.random().toString(ID_RADIX).slice(2, RANDOM_ID_END)}`,
      title: promptTitle(title, body),
      body,
    };
    const isExisting = get().prompts.some((prompt) => prompt.id === saved.id);
    const prompts = isExisting ? get().prompts.map((prompt) => (prompt.id === saved.id ? saved : prompt)) : [...get().prompts, saved];
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
