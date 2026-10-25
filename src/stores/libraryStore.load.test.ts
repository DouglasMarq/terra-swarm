// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "terra-prompt-library";

async function loadPrompts(stored: string | null) {
  if (stored !== null) localStorage.setItem(STORAGE_KEY, stored);
  vi.resetModules();
  const module = await import("./libraryStore");
  return module.useLibraryStore.getState().prompts;
}

describe("prompt library loading", () => {
  afterEach(() => localStorage.clear());

  it("Given saved prompts with malformed entries, when the library loads, then only well-formed prompts are kept", async () => {
    const stored = JSON.stringify([
      { id: "kept", title: "Review", body: "Review the diff" },
      null,
      { id: 7, title: "Bad id", body: "x" },
      { id: "no-body", title: "Missing body" },
    ]);

    expect(await loadPrompts(stored)).toEqual([{ id: "kept", title: "Review", body: "Review the diff" }]);
  });

  it.each([
    ["not an array", JSON.stringify({ id: "x" })],
    ["corrupted", "{oops"],
  ])("Given a saved library that is %s, when it loads, then the default prompts are used", async (...[, stored]) => {
    const prompts = await loadPrompts(stored);

    expect(prompts.map((prompt) => prompt.id)).toEqual(["review-diff", "write-tests", "plan-goal"]);
  });

  it("Given the library store, when opening and closing a dialog, then the open dialog follows", async () => {
    vi.resetModules();
    const { useLibraryStore } = await import("./libraryStore");

    useLibraryStore.getState().openDialog("team");
    expect(useLibraryStore.getState().dialog).toBe("team");
    useLibraryStore.getState().closeDialog();
    expect(useLibraryStore.getState().dialog).toBeNull();
  });
});
