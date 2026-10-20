import { describe, expect, it } from "vitest";
import { fillPrompt, useLibraryStore } from "./libraryStore";

describe("prompt library", () => {
  it("starts with defaults, then adds, edits and deletes", () => {
    const store = useLibraryStore.getState();
    expect(store.prompts.length).toBeGreaterThan(0);
    const added = store.savePrompt({ title: "", body: "Fix the flaky login test please now" });
    expect(added.title).toBe("Fix the flaky login test please");
    useLibraryStore.getState().savePrompt({ id: added.id, title: "Flaky", body: "x" });
    expect(useLibraryStore.getState().prompts.find((prompt) => prompt.id === added.id)?.title).toBe("Flaky");
    useLibraryStore.getState().deletePrompt(added.id);
    expect(useLibraryStore.getState().prompts.some((prompt) => prompt.id === added.id)).toBe(false);
  });

  it("fills the project placeholder", () => {
    expect(fillPrompt("Review {project} now", { project: "api" })).toBe("Review api now");
    expect(fillPrompt("Review {project}", {})).toBe("Review this project");
  });
});
