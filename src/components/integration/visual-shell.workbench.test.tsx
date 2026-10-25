// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: {
    resizeTerminal: vi.fn(async () => undefined),
    writeTerminal: vi.fn(async () => undefined),
    terminalBacklog: vi.fn(async () => ""),
  },
}));

vi.mock("../../api", () => ({ api: mocks.api }));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
}));

vi.mock("../../lib/tauri/workspace", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/tauri/workspace")>();
  return {
    ...original,
    workspaceApi: {
      ...original.workspaceApi,
      setWorkspaceContainerState: vi.fn(async () => undefined),
      setWorkspaceLayout: vi.fn(async () => undefined),
      setActivePane: vi.fn(async () => undefined),
    },
  };
});

vi.mock("../../lib/tauri/fileDrop", () => ({
  onFileDrop: vi.fn(async () => vi.fn()),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    cols = 80;
    rows = 24;
    options: { fontSize: number } = { fontSize: 13 };
    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler() {}
    onData() {
      return { dispose() {} };
    }
    write(_data: string, callback?: () => void) {
      callback?.();
    }
    dispose() {}
    paste() {}
    focus() {}
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    proposeDimensions() {
      return { cols: 80, rows: 24 };
    }
    fit() {}
  },
}));

import type { Group, Workspace, WorkspaceContainer } from "../../domain/workspace.model";
import { useLocaleStore } from "../../i18n";
import { mcpApi } from "../../lib/tauri/mcp";
import { ptyApi } from "../../lib/tauri/pty";
import { useOrchestrationStore } from "../../stores/orchestrationStore";
import { useReviewStore } from "../../stores/reviewStore";
import { SHELL_STORAGE_KEY, useShellStore } from "../../stores/shellStore";
import { VisualShellSurface, type VisualShellSurfaceProps } from "./VisualShellSurface";

const workspace: Workspace = {
  id: "ws-api",
  name: "Terra API",
  cwd: "/tmp/terra-api",
  terminals: [
    { id: "term-codex", command: "codex", width: 120 },
    { id: "term-claude", command: "claude", width: 120 },
  ],
};

const group: Group = {
  id: "group-core",
  name: "Core",
  projectIds: [workspace.id],
  parentGroupId: null,
  isCollapsed: false,
  isSuspended: false,
  layout: { mode: "auto", itemIds: [workspace.id] },
};

function shellProps(overrides: Partial<VisualShellSurfaceProps> = {}): VisualShellSurfaceProps {
  return {
    workspaces: [workspace],
    groups: [group],
    agents: [{ id: "codex", label: "Codex", isAvailable: true }],
    snapshot: null,
    activeId: workspace.id,
    focusedId: "term-codex",
    expandedId: null,
    exited: {},
    notifications: {},
    contextUsage: {},
    titles: {},
    branches: {},
    notificationItems: [],
    detachedTerminalIds: [],
    appVersion: "2.0.0",
    fontSize: 13,
    isVoiceEnabled: false,
    voiceStatus: "idle",
    onFocus: vi.fn(),
    onSelectWorkspace: vi.fn(),
    onNewWorkspace: vi.fn(),
    onNewAgent: vi.fn(),
    onClearNotifications: vi.fn(),
    onMarkAllRead: vi.fn(),
    onClearAll: vi.fn(),
    onJumpToNotification: vi.fn(),
    onRestart: vi.fn(),
    onKill: vi.fn(),
    onDetach: vi.fn(),
    onReattach: vi.fn(),
    onToggleExpand: vi.fn(),
    onHideWorkspace: vi.fn(),
    onCreateGroup: vi.fn(),
    onCreateProject: vi.fn(),
    onRenameNode: vi.fn(),
    onSuspendGroup: vi.fn(),
    onResumeGroup: vi.fn(),
    onBatchStop: vi.fn(),
    onBatchResume: vi.fn(),
    onOpenSettings: vi.fn(),
    onToggleVoice: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  useLocaleStore.setState({ locale: "en" });
  localStorage.clear();
  useShellStore.getState().reset();
  useOrchestrationStore.getState().reset();
});

afterEach(() => {
  localStorage.removeItem(SHELL_STORAGE_KEY);
});

function Harness(props: VisualShellSurfaceProps) {
  const snapshot = useOrchestrationStore((state) => state.snapshot);
  return <VisualShellSurface {...props} snapshot={snapshot} />;
}

function containerOf(): WorkspaceContainer {
  const container = useOrchestrationStore.getState().snapshot?.containers[0];
  if (!container) throw new Error("the workspace has no container");
  return container;
}

function terminalPane(terminalId: string): HTMLElement {
  const pane = document.querySelector<HTMLElement>(`[data-term-id="${terminalId}"]`);
  if (!pane) throw new Error(`terminal ${terminalId} is not rendered`);
  return pane;
}

function mergeTabsIntoFirstPane(orphanTitle: string | null) {
  const snapshot = useOrchestrationStore.getState().snapshot;
  if (!snapshot) throw new Error("no snapshot to merge");
  const [first] = snapshot.panes;
  const tabs = snapshot.tabs.map((tab) => ({ ...tab, paneId: first.id }));
  const orphan = orphanTitle === null ? [] : [{ ...tabs[0], id: "tab-orphan", ptyId: null, title: orphanTitle, command: "" }];
  const allTabs = [...tabs, ...orphan];
  const tabIds = allTabs.map((tab) => tab.id);
  useOrchestrationStore.setState({
    snapshot: {
      ...snapshot,
      panes: [{ ...first, tabIds, activeTabId: tabIds[0] }],
      containers: snapshot.containers.map((container) => ({ ...container, paneIds: [first.id], activePaneId: first.id })),
      projects: snapshot.projects.map((project) => ({ ...project, paneIds: [first.id] })),
      tabs: allTabs,
    },
  });
}

async function openWorkbench(overrides: Partial<VisualShellSurfaceProps> = {}) {
  const props = shellProps(overrides);
  const user = userEvent.setup();
  render(<Harness {...props} />);
  await screen.findByRole("button", { name: "Collapse Terra API" });
  await waitFor(() => expect(document.querySelector("[data-term-id], .terra-orphan-tab")).not.toBeNull());
  return { props, user };
}

describe("VisualShellSurface workbench", () => {
  beforeEach(() => {
    useOrchestrationStore.getState().sync([workspace], []);
  });

  it("Given a synced workspace, when the workbench opens, then every agent gets its own pane", async () => {
    await openWorkbench();

    expect(screen.getByRole("region", { name: "Pane pane-ws-api-1" })).toContainElement(terminalPane("term-codex"));
    expect(screen.getByRole("region", { name: "Pane pane-ws-api-2" })).toContainElement(terminalPane("term-claude"));
    expect(screen.queryByRole("complementary", { name: "Pane tabs" })).not.toBeInTheDocument();
  });

  it("Given two panes, when the user clicks the second agent, then it is reattached, selected and its pane becomes active", async () => {
    const { props } = await openWorkbench();

    fireEvent.mouseDown(terminalPane("term-claude"));

    expect(props.onReattach).toHaveBeenCalledWith("term-claude");
    expect(props.onSelectWorkspace).toHaveBeenCalledWith("ws-api", "term-claude");
    expect(props.onFocus).toHaveBeenCalledWith("term-claude");
    expect(containerOf().activePaneId).toBe("pane-ws-api-2");
    expect(useShellStore.getState().activeWorkspaceId).toBe("ws-api");
  });

  it("Given a full-screen container, when collapsing it, then it leaves full screen and folds", async () => {
    const { user } = await openWorkbench();

    await user.click(screen.getByRole("button", { name: "Full screen Terra API" }));
    expect(containerOf().isFullscreen).toBe(true);
    await user.click(screen.getByRole("button", { name: "Collapse Terra API" }));

    expect(containerOf()).toMatchObject({ isCollapsed: true, isFullscreen: false });
    await user.click(screen.getByRole("button", { name: "Expand Terra API" }));
    expect(containerOf().isCollapsed).toBe(false);
  });

  it("Given the container header, when picking a grid size and the focus mode, then the layouts are stored", async () => {
    const { user } = await openWorkbench();

    await user.click(screen.getByRole("button", { name: "Grid size" }));
    await user.click(screen.getByRole("button", { name: "1 × 2" }));
    expect(containerOf().layout).toMatchObject({ columns: 1, rows: 2 });

    await user.click(within(screen.getByRole("group", { name: "Layout of Terra API" })).getByRole("button", { name: "Focus" }));
    expect(useOrchestrationStore.getState().snapshot?.projects[0].layout.mode).toBe("spotlight");
  });

  it("Given no container handler, when hiding the container, then its project is hidden", async () => {
    const { props, user } = await openWorkbench();

    await user.click(screen.getByRole("button", { name: "Hide Terra API" }));

    expect(props.onHideWorkspace).toHaveBeenCalledWith("ws-api");
  });

  it("Given a container handler, when hiding the container, then the container is hidden instead", async () => {
    const onHideContainer = vi.fn();
    const { props, user } = await openWorkbench({ onHideContainer });

    await user.click(screen.getByRole("button", { name: "Hide Terra API" }));

    expect(onHideContainer).toHaveBeenCalledWith("container-ws-api");
    expect(props.onHideWorkspace).not.toHaveBeenCalled();
  });

  it("Given the container header, when asking for a new agent, then it opens in the project", async () => {
    const { props, user } = await openWorkbench();

    await user.click(screen.getByRole("button", { name: /New agent/ }));

    expect(props.onNewAgent).toHaveBeenCalledWith("ws-api", null);
  });

  it("Given a quick new agent handler, when asking for a new agent, then the quick path is used", async () => {
    const onQuickNewAgent = vi.fn();
    const { props, user } = await openWorkbench({ onQuickNewAgent });

    await user.click(screen.getByRole("button", { name: /New agent/ }));

    expect(onQuickNewAgent).toHaveBeenCalledWith("ws-api");
    expect(props.onNewAgent).not.toHaveBeenCalled();
  });

  it("Given an agent pane, when maximizing it, then that agent expands", async () => {
    const { props, user } = await openWorkbench();

    await user.click(within(terminalPane("term-codex")).getByRole("button", { name: "Maximize" }));

    expect(props.onToggleExpand).toHaveBeenCalledWith("term-codex");
  });

  it("Given an expanded agent, when restoring it, then the grid comes back", async () => {
    const { props, user } = await openWorkbench({ expandedId: "term-codex" });

    await user.click(within(terminalPane("term-codex")).getByRole("button", { name: "Back to grid" }));

    expect(props.onToggleExpand).toHaveBeenCalledWith(null);
  });

  it("Given an agent pane menu, when showing it in the inspector, then the agent is focused and the dock opens", async () => {
    const { props, user } = await openWorkbench();

    await user.click(within(terminalPane("term-claude")).getByRole("button", { name: "More actions" }));
    await user.click(await screen.findByRole("menuitem", { name: /Show in inspector/ }));

    expect(props.onFocus).toHaveBeenCalledWith("term-claude");
    expect(useShellStore.getState().dock.isOpen).toBe(true);
  });

  it("Given an agent pane menu, when detaching it, then the agent leaves the Workbench", async () => {
    const { props, user } = await openWorkbench();

    await user.click(within(terminalPane("term-codex")).getByRole("button", { name: "More actions" }));
    await user.click(await screen.findByRole("menuitem", { name: /Detach from Workbench/ }));

    expect(props.onDetach).toHaveBeenCalledWith("term-codex");
  });

  it("Given a detached agent, when the workbench renders, then its pane is hidden", async () => {
    await openWorkbench({ detachedTerminalIds: ["term-claude"] });

    expect(document.querySelector('[data-term-id="term-claude"]')).toBeNull();
    expect(terminalPane("term-codex")).toBeInTheDocument();
  });
});

describe("VisualShellSurface workbench pane tabs", () => {
  beforeEach(() => {
    useOrchestrationStore.getState().sync([workspace], []);
  });

  it("Given two agents sharing a pane, when focusing the second tab, then that agent is focused", async () => {
    mergeTabsIntoFirstPane(null);
    const { props, user } = await openWorkbench();

    const lane = screen.getByRole("complementary", { name: "Pane tabs" });
    await user.click(within(lane).getByRole("button", { name: "Focus claude" }));

    expect(props.onFocus).toHaveBeenCalledWith("term-claude");
    expect(props.onSelectWorkspace).toHaveBeenCalledWith("ws-api", "term-claude");
  });

  it("Given two agents sharing a pane, when detaching and ending tabs, then each agent's session is used", async () => {
    mergeTabsIntoFirstPane(null);
    const { props, user } = await openWorkbench();
    const lane = screen.getByRole("complementary", { name: "Pane tabs" });

    await user.click(within(lane).getByRole("button", { name: "Focus claude" }));
    await user.click(within(lane).getByRole("button", { name: "Detach claude" }));
    expect(props.onDetach).toHaveBeenCalledWith("term-claude");

    await user.click(within(lane).getByRole("button", { name: "Focus codex" }));
    await user.click(within(lane).getByRole("button", { name: "End codex" }));
    await user.click(await screen.findByRole("button", { name: "End terminal" }));
    expect(props.onKill).toHaveBeenCalledWith("term-codex");
  });

  it("Given a tab without a session, when it is shown and used, then it is flagged as orphaned and only focus passes through", async () => {
    mergeTabsIntoFirstPane("Lost session");
    const { props, user } = await openWorkbench();

    const orphan = document.querySelector<HTMLElement>(".terra-orphan-tab");
    if (!orphan) throw new Error("the orphaned tab is not rendered");
    expect(orphan).toHaveTextContent("Orphaned tab");
    expect(orphan).toHaveTextContent("Lost session");

    const lane = screen.getByRole("complementary", { name: "Pane tabs" });
    await user.click(within(lane).getByRole("button", { name: "Focus Lost session" }));
    expect(props.onFocus).toHaveBeenCalledWith("tab-orphan");

    await user.click(within(lane).getByRole("button", { name: "Detach Lost session" }));
    await user.click(within(lane).getByRole("button", { name: "Focus Lost session" }));
    await user.click(within(lane).getByRole("button", { name: "End Lost session" }));
    await user.click(await screen.findByRole("button", { name: "End terminal" }));
    expect(props.onDetach).not.toHaveBeenCalled();
    expect(props.onKill).not.toHaveBeenCalled();
  });
});

describe("VisualShellSurface empty workbench", () => {
  it("Given a snapshot without containers, when the workbench opens, then it offers a new workspace", async () => {
    useOrchestrationStore.getState().sync([], []);
    const props = shellProps({ workspaces: [], groups: [], activeId: null, focusedId: null });
    const user = userEvent.setup();
    render(<Harness {...props} />);

    expect(await screen.findByText("No workspace visible")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New workspace" }));

    expect(props.onNewWorkspace).toHaveBeenCalled();
  });
});

describe("VisualShellSurface fleet batch actions", () => {
  beforeEach(() => {
    useOrchestrationStore.getState().sync([workspace], []);
  });

  async function openFleetWithSelection() {
    const props = shellProps();
    const user = userEvent.setup();
    render(<Harness {...props} />);
    await user.click(screen.getByRole("button", { name: "Fleet" }));
    await user.click(await screen.findByRole("checkbox", { name: "Select claude" }));
    await user.click(screen.getByRole("checkbox", { name: "Select codex" }));
    return { props, user, toolbar: screen.getByRole("toolbar", { name: "Batch actions" }) };
  }

  it("Given selected agents, when pausing them, then the batch stop runs", async () => {
    const { props, user, toolbar } = await openFleetWithSelection();

    await user.click(within(toolbar).getByRole("button", { name: "Pause" }));

    expect(props.onBatchStop).toHaveBeenCalledWith(expect.arrayContaining(["term-codex", "term-claude"]));
  });

  it("Given selected agents, when resuming them, then the batch resume runs", async () => {
    const { props, user, toolbar } = await openFleetWithSelection();

    await user.click(within(toolbar).getByRole("button", { name: "Resume" }));

    expect(props.onBatchResume).toHaveBeenCalledWith(expect.arrayContaining(["term-codex", "term-claude"]));
  });

  it("Given selected agents, when talking to them, then the first one is focused and voice starts", async () => {
    const { props, user, toolbar } = await openFleetWithSelection();

    await user.click(within(toolbar).getByRole("button", { name: "Talk to them" }));

    expect(props.onFocus).toHaveBeenCalledTimes(1);
    expect(props.onToggleVoice).toHaveBeenCalled();
  });
});

const isolatedWorkspace: Workspace = {
  ...workspace,
  terminals: [
    { id: "term-codex", command: "codex", width: 120 },
    {
      id: "term-claude",
      command: "claude",
      width: 120,
      role: "executor",
      worktree: { path: "/tmp/terra-api-wt", cwd: "/tmp/terra-api-wt", branch: "terra/feature-x", base: "main", repo: "/tmp/terra-api" },
    },
  ],
};

describe("VisualShellSurface agent panes", () => {
  it("Given an exited agent, when restarting or closing its pane, then the session is restarted or ended", async () => {
    useOrchestrationStore.getState().sync([workspace], []);
    const { props, user } = await openWorkbench({ exited: { "term-codex": 1 } });
    const pane = terminalPane("term-codex");

    await user.click(within(pane).getByRole("button", { name: "Restart" }));
    expect(props.onRestart).toHaveBeenCalledWith("term-codex", "codex");

    await user.click(within(pane).getByRole("button", { name: "Close pane" }));
    expect(props.onKill).toHaveBeenCalledWith("term-codex");
  });

  it("Given an agent asking for the user, when marking it read from the pane, then its notifications clear", async () => {
    useOrchestrationStore.getState().sync([workspace], []);
    const { props, user } = await openWorkbench({
      notifications: { "term-codex": 1 },
      notificationItems: [{ key: 1, terminalId: "term-codex", workspaceId: workspace.id, message: "May I run npm test?", ts: Date.now(), isRead: false }],
    });
    const pane = terminalPane("term-codex");

    expect(pane).toHaveTextContent("May I run npm test?");
    await user.click(within(pane).getByRole("button", { name: "Mark as read" }));

    expect(props.onClearNotifications).toHaveBeenCalledWith("term-codex");
  });

  it("Given an agent in its own worktree, when opening its branch, then the review opens for that agent", async () => {
    useOrchestrationStore.getState().sync([isolatedWorkspace], []);
    const { user } = await openWorkbench({ workspaces: [isolatedWorkspace] });
    const pane = terminalPane("term-claude");

    expect(within(pane).getByText("Executor")).toBeInTheDocument();
    await user.click(within(pane).getByRole("button", { name: /terra\/feature-x/ }));

    expect(useReviewStore.getState().target).toEqual({ workspaceId: "ws-api", terminalId: "term-claude", label: "claude" });
  });
});

describe("VisualShellSurface inspector actions", () => {
  beforeEach(() => {
    useOrchestrationStore.getState().sync([workspace], []);
    vi.spyOn(mcpApi, "agentUsage").mockResolvedValue([]);
    vi.spyOn(ptyApi, "terminalRuntimeInfo").mockResolvedValue({ id: "term-codex", pid: 42, cols: 120, rows: 40, isRunning: true, isReaped: false, generation: 1 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function openInspector(overrides: Partial<VisualShellSurfaceProps> = {}) {
    const opened = await openWorkbench(overrides);
    await opened.user.click(screen.getByRole("button", { name: "Show inspector (Ctrl+I)" }));
    return { ...opened, inspector: await screen.findByRole("complementary", { name: "Agent inspector" }) };
  }

  it("Given the focused agent in the inspector, when detaching it, then it leaves the Workbench", async () => {
    const { props, user, inspector } = await openInspector();

    await user.click(within(inspector).getByRole("button", { name: "Detach" }));

    expect(props.onDetach).toHaveBeenCalledWith("term-codex");
  });

  it("Given a detached focused agent, when reattaching it from the inspector, then it comes back", async () => {
    const { props, user, inspector } = await openInspector({ detachedTerminalIds: ["term-codex"] });

    await user.click(within(inspector).getByRole("button", { name: "Reattach" }));

    expect(props.onReattach).toHaveBeenCalledWith("term-codex");
  });

  it("Given the focused agent in the inspector, when restarting it and confirming, then the session restarts", async () => {
    const { props, user, inspector } = await openInspector();

    await user.click(within(inspector).getByRole("button", { name: "Restart" }));
    const dialog = await screen.findByRole("dialog", { name: "Restart session" });
    await user.click(within(dialog).getByRole("button", { name: "Restart session" }));

    expect(props.onRestart).toHaveBeenCalledWith("term-codex", "codex");
  });

  it("Given the focused agent in the inspector, when ending it and confirming, then the session ends", async () => {
    const { props, user, inspector } = await openInspector();

    await user.click(within(inspector).getByRole("button", { name: "End session" }));
    const dialog = await screen.findByRole("dialog", { name: "End session" });
    await user.click(within(dialog).getByRole("button", { name: "End session" }));

    expect(props.onKill).toHaveBeenCalledWith("term-codex");
  });
});

describe("VisualShellSurface notification center", () => {
  beforeEach(() => {
    useOrchestrationStore.getState().sync([workspace], []);
  });

  it("Given an agent whose context is nearly full, when going to its pane from the notifications, then it is focused", async () => {
    const { props, user } = await openWorkbench({ contextUsage: { "term-claude": 95 } });

    await user.click(screen.getByRole("button", { name: "1 needs you" }));
    const center = screen.getByRole("dialog", { name: "Notifications" });
    await user.click(within(center).getByRole("button", { name: "Go to pane" }));

    expect(props.onFocus).toHaveBeenCalledWith("term-claude");
    expect(screen.queryByRole("dialog", { name: "Notifications" })).not.toBeInTheDocument();
  });

  it("Given the notifications, when opening the fleet from them, then the fleet shows", async () => {
    const { user } = await openWorkbench();

    await user.click(screen.getByRole("button", { name: "Notifications" }));
    await user.click(screen.getByRole("button", { name: "See everything in the Fleet →" }));

    expect(useShellStore.getState().activeSurface).toBe("fleet");
    expect(await screen.findByRole("heading", { name: "Fleet" })).toBeInTheDocument();
  });
});
