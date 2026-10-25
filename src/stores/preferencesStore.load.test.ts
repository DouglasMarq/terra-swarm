// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

async function loadStore() {
  vi.resetModules();
  return import("./preferencesStore");
}

afterEach(() => {
  localStorage.clear();
});

describe("preferences loaded from storage", () => {
  it("Given a shortcut saved with the old modifier names, when the store loads, then its modifiers survive under the new names", async () => {
    localStorage.setItem("hotkeys", JSON.stringify({
      newWorkspace: { key: "y", meta: false, shift: true, ctrl: true, alt: false },
    }));

    const { usePreferencesStore } = await loadStore();

    expect(usePreferencesStore.getState().hotkeys.newWorkspace).toEqual({
      key: "y",
      hasMeta: false,
      hasShift: true,
      hasCtrl: true,
      hasAlt: false,
    });
  });

  it("Given a stored shortcut and a malformed one, when the store loads, then the valid one is kept and the other falls back to the default", async () => {
    const custom = { key: "y", hasMeta: false, hasShift: true, hasCtrl: true, hasAlt: false };
    localStorage.setItem("hotkeys", JSON.stringify({ newWorkspace: custom, newTerminal: { key: "", hasMeta: true } }));

    const { usePreferencesStore, DEFAULT_HOTKEYS } = await loadStore();

    expect(usePreferencesStore.getState().hotkeys.newWorkspace).toEqual(custom);
    expect(usePreferencesStore.getState().hotkeys.newTerminal).toEqual(DEFAULT_HOTKEYS.newTerminal);
  });

  it("Given corrupted shortcut storage, when the store loads, then every shortcut is the default", async () => {
    localStorage.setItem("hotkeys", "{not json");

    const { usePreferencesStore, DEFAULT_HOTKEYS } = await loadStore();

    expect(usePreferencesStore.getState().hotkeys).toEqual(DEFAULT_HOTKEYS);
  });

  it("Given shortcut storage that is not an object, when the store loads, then every shortcut is the default", async () => {
    localStorage.setItem("hotkeys", "42");

    const { usePreferencesStore, DEFAULT_HOTKEYS } = await loadStore();

    expect(usePreferencesStore.getState().hotkeys).toEqual(DEFAULT_HOTKEYS);
  });

  it("Given a stored grid width inside and outside the allowed range, when the store loads, then only the allowed one is used", async () => {
    localStorage.setItem("gridCols", "5");
    const allowed = await loadStore();
    expect(allowed.usePreferencesStore.getState().gridCols).toBe(5);
    expect(allowed.GRID_COL_OPTIONS).toEqual([2, 3, 4, 5, 6, 7, 8]);

    localStorage.setItem("gridCols", "12");
    const rejected = await loadStore();
    expect(rejected.usePreferencesStore.getState().gridCols).toBe(2);
  });

  it("Given a stored font size outside the allowed range, when the store loads, then the default size is used", async () => {
    localStorage.setItem("termFontSize", "99");

    const { usePreferencesStore } = await loadStore();

    expect(usePreferencesStore.getState().fontSize).toBe(13);
  });
});
