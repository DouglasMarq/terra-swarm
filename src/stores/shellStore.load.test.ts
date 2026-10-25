// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

const SHELL_STORAGE_KEY = "terra-shell-state";
const PREVIOUS_SHELL_STATE_VERSION = 3;

async function loadStore() {
  vi.resetModules();
  return import("./shellStore");
}

afterEach(() => {
  localStorage.clear();
});

describe("shell state loaded from storage", () => {
  it("Given a shell state saved with the old flag names, when the store loads, then the sidebar, dock and pinned tab flags survive", async () => {
    localStorage.setItem(SHELL_STORAGE_KEY, JSON.stringify({
      version: PREVIOUS_SHELL_STATE_VERSION,
      state: {
        version: PREVIOUS_SHELL_STATE_VERSION,
        activeSurface: "workbench",
        activeWorkspaceId: "workspace-a",
        dock: { open: true, activeTab: "tasks" },
        workspaceTabs: [{ id: "workspace-a", workspaceId: "workspace-a", label: "Alpha", pinned: true }],
        sidebarCollapsed: true,
      },
    }));

    const { useShellStore, SHELL_STATE_VERSION } = await loadStore();
    const state = useShellStore.getState();

    expect(state.version).toBe(SHELL_STATE_VERSION);
    expect(state.isSidebarCollapsed).toBe(true);
    expect(state.dock).toEqual({ isOpen: true, activeTab: "tasks" });
    expect(state.workspaceTabs[0]).toMatchObject({ workspaceId: "workspace-a", isPinned: true });
    expect(state.workspaceTabs[0]).not.toHaveProperty("pinned");
  });
});
