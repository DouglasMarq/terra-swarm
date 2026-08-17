import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeShellState,
  SHELL_STATE_VERSION,
  useShellStore,
} from "./shellStore";

afterEach(() => {
  useShellStore.getState().reset();
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem("terra-shell-state");
  }
});

describe("shell store", () => {
  it("keeps back/forward history and truncates the forward branch", () => {
    const store = useShellStore.getState();
    store.navigate("workbench", "workspace-a");
    store.navigate("fleet");
    expect(useShellStore.getState().activeSurface).toBe("fleet");

    store.goBack();
    expect(useShellStore.getState()).toMatchObject({
      activeSurface: "workbench",
      activeWorkspaceId: "workspace-a",
    });
    store.goForward();
    expect(useShellStore.getState().activeSurface).toBe("fleet");

    store.goBack();
    store.navigate("events");
    store.goForward();
    expect(useShellStore.getState().activeSurface).toBe("events");
    expect(useShellStore.getState().historyIndex).toBe(
      useShellStore.getState().history.length - 1,
    );
  });

  it("closes an active workspace tab without losing its reopen record", () => {
    const store = useShellStore.getState();
    store.openWorkspaceTab({ id: "workspace-a", workspaceId: "workspace-a", label: "Alpha" });
    store.openWorkspaceTab({ id: "workspace-b", workspaceId: "workspace-b", label: "Beta" });
    store.selectWorkspaceTab("workspace-a");
    store.closeWorkspaceTab("workspace-a");

    expect(useShellStore.getState().workspaceTabs.map((tab) => tab.workspaceId)).toEqual([
      "workspace-b",
    ]);
    expect(useShellStore.getState().recentlyClosedTabs[0]).toMatchObject({
      workspaceId: "workspace-a",
      label: "Alpha",
    });
    expect(useShellStore.getState().activeSurface).toBe("home");

    const historyBeforeReopen = useShellStore.getState().history.length;
    expect(store.reopenWorkspaceTab("workspace-a")).toBe(true);
    expect(useShellStore.getState().history.length).toBe(historyBeforeReopen + 1);
    expect(useShellStore.getState().workspaceTabs.map((tab) => tab.workspaceId)).toContain(
      "workspace-a",
    );
    expect(useShellStore.getState()).toMatchObject({
      activeSurface: "workbench",
      activeWorkspaceId: "workspace-a",
    });
    expect(useShellStore.getState().recentlyClosedTabs).toEqual([]);
  });

  it("reorders workspace tabs durably without letting refreshes append them", () => {
    const store = useShellStore.getState();
    store.openWorkspaceTab({ id: "workspace-a", workspaceId: "workspace-a", label: "Alpha" });
    store.openWorkspaceTab({ id: "workspace-b", workspaceId: "workspace-b", label: "Beta" });
    store.openWorkspaceTab({ id: "workspace-c", workspaceId: "workspace-c", label: "Gamma" });

    store.reorderWorkspaceTabs(["workspace-c", "workspace-a", "unknown"]);
    expect(useShellStore.getState().workspaceTabs.map((tab) => tab.workspaceId)).toEqual([
      "workspace-c",
      "workspace-a",
      "workspace-b",
    ]);

    store.openWorkspaceTab({
      id: "workspace-a",
      workspaceId: "workspace-a",
      label: "Alpha renamed",
      state: "busy",
    });
    expect(useShellStore.getState().workspaceTabs.map((tab) => tab.workspaceId)).toEqual([
      "workspace-c",
      "workspace-a",
      "workspace-b",
    ]);
    expect(useShellStore.getState().workspaceTabs[1]).toMatchObject({
      label: "Alpha renamed",
      state: "busy",
    });
  });

  it("normalizes versioned persisted data and drops malformed entries", () => {
    const normalized = normalizeShellState({
      version: 0,
      activeSurface: "unknown",
      activeWorkspaceId: " workspace-a ",
      dock: { open: true, activeTab: "voice" },
      workspaceTabs: [
        { id: "workspace-a", workspaceId: "workspace-a", label: " Alpha " },
        { id: "workspace-a-duplicate", workspaceId: "workspace-a", label: "Duplicate" },
        { id: "", workspaceId: "bad", label: "Bad" },
      ],
      history: [
        { id: "h1", surface: "home", workspaceId: null, at: 1 },
        { id: "h2", surface: "workbench", workspaceId: "workspace-a", at: 2 },
      ],
      historyIndex: 99,
    });

    expect(normalized.version).toBe(SHELL_STATE_VERSION);
    expect(normalized.activeSurface).toBe("home");
    expect(normalized.activeWorkspaceId).toBe("workspace-a");
    expect(normalized.dock).toEqual({ open: true, activeTab: "voice" });
    expect(normalized.workspaceTabs).toHaveLength(1);
    expect(normalized.workspaceTabs[0]).toMatchObject({
      workspaceId: "workspace-a",
      label: "Alpha",
    });
    expect(normalized.historyIndex).toBe(1);
  });

  it("opens the dock when a dock tab is selected", () => {
    const store = useShellStore.getState();
    store.setDockOpen(false);
    store.setDockTab("context");
    expect(useShellStore.getState().dock).toEqual({ open: true, activeTab: "context" });
  });

  it("normalizes and persists navigator disclosure and shell panel layout", () => {
    const normalized = normalizeShellState({
      navigatorCollapsedIds: [" group-a ", "", "group-a", 4],
      panelLayout: { navigator: 24, content: 76, dock: 999, invalid: "x" },
    });
    expect(normalized.navigatorCollapsedIds).toEqual(["group-a"]);
    expect(normalized.panelLayout).toEqual({ navigator: 24, content: 76, dock: 100 });

    const store = useShellStore.getState();
    store.setNavigatorCollapsedIds(["group-a", " group-b ", "group-a"]);
    store.setPanelLayout({ navigator: 22, content: 58, dock: 20 });
    store.setPanelLayout({ navigator: 25, content: 75 });
    expect(useShellStore.getState()).toMatchObject({
      navigatorCollapsedIds: ["group-a", "group-b"],
      panelLayout: { navigator: 25, content: 75, dock: 20 },
    });
  });
});
