import { describe, expect, it } from "vitest";
import { translateNow } from "../../i18n";
import type { NotificationItem } from "../../domain/notification.model";
import type { TerminalTab, Workspace, WorkspaceContainer, WorkspaceSnapshotV2 } from "../../domain/workspace.model";
import {
  lastActivityByAgent,
  latestMessageByAgent,
  nearlyFullContexts,
  projectStatus,
  shellVoiceLabel,
  shellVoiceState,
  visibleSnapshot,
  workbenchSnapshot,
} from "./visualShellModel";

function tab(id: string, ptyId: string): TerminalTab {
  return { id, paneId: "pane-1", ptyId, command: "claude", cwd: "/Users/me/project", width: null, title: id, isOrphaned: false };
}

function container(id: string, projectId: string): WorkspaceContainer {
  return { id, projectId, paneIds: [], layout: { mode: "grid" }, isVisible: true, isCollapsed: false, isClosed: false, isFullscreen: false };
}

function snapshot(): WorkspaceSnapshotV2 {
  return {
    version: 2,
    projects: [],
    groups: [],
    containers: [container("c-1", "ws-1"), container("c-2", "ws-2")],
    panes: [{ id: "pane-1", projectId: "ws-1", containerId: "c-1", tabIds: ["tab-1", "tab-2", "tab-3"], activeTabId: "tab-1", layout: { mode: "grid" } }],
    tabs: [tab("tab-1", "t-1"), tab("tab-2", "t-2"), tab("tab-3", "t-3")],
    orphanedTabIds: [],
    activeProjectId: "ws-1",
    activeGroupId: null,
    activeContainerId: "c-1",
    activePaneId: "pane-1",
    activeTabId: "tab-1",
    layout: { mode: "grid" },
  };
}

function item(key: number, terminalId: string, fields: Pick<NotificationItem, "ts"> & Partial<NotificationItem>): NotificationItem {
  return { key, terminalId, workspaceId: "ws-1", message: `message ${key}`, isRead: false, ...fields };
}

describe("visibleSnapshot", () => {
  it("Given nothing detached and no focus, when projecting the visible snapshot, then the snapshot is returned as is", () => {
    const source = snapshot();
    expect(visibleSnapshot(source, [], null)).toBe(source);
    expect(visibleSnapshot(null, ["t-1"], "t-1")).toBeNull();
  });

  it("Given a detached active tab, when projecting the visible snapshot, then it is dropped and the pane's first visible tab becomes active", () => {
    const visible = visibleSnapshot(snapshot(), ["t-1"], null);
    expect(visible?.tabs.map((entry) => entry.id)).toEqual(["tab-2", "tab-3"]);
    expect(visible?.panes[0]).toMatchObject({ tabIds: ["tab-2", "tab-3"], activeTabId: "tab-2" });
    expect(visible?.activeTabId).toBe("tab-2");
  });

  it("Given a focused terminal, when projecting the visible snapshot, then its tab becomes active in the pane that holds it", () => {
    expect(visibleSnapshot(snapshot(), [], "t-3")?.panes[0]?.activeTabId).toBe("tab-3");
  });
});

describe("workbenchSnapshot", () => {
  it("Given an active project, when building the workbench snapshot, then only that project's containers are kept", () => {
    expect(workbenchSnapshot(snapshot(), { detachedTerminalIds: [], focusedId: null, activeProjectId: "ws-2" })?.containers.map((entry) => entry.id)).toEqual(["c-2"]);
  });

  it("Given no active project, when building the workbench snapshot, then every container is kept", () => {
    expect(workbenchSnapshot(snapshot(), { detachedTerminalIds: [], focusedId: null, activeProjectId: null })?.containers).toHaveLength(2);
  });
});

describe("projectStatus", () => {
  it("Given an agent that needs the user, when computing the project status, then it needs attention", () => {
    expect(projectStatus(["working", "attention", "idle"])).toBe("attention");
  });

  it("Given a working agent and none needing the user, when computing the project status, then it is working", () => {
    expect(projectStatus(["idle", "working"])).toBe("working");
  });

  it("Given only idle, suspended or exited agents, or none, when computing the project status, then it is idle", () => {
    expect(projectStatus(["idle", "suspended", "exited"])).toBe("idle");
    expect(projectStatus([])).toBe("idle");
  });
});

describe("nearlyFullContexts", () => {
  const workspaces: Workspace[] = [{
    id: "ws-1",
    name: "alpha",
    cwd: "/Users/me/alpha",
    terminals: [
      { id: "t-1", command: "claude", width: null },
      { id: "t-2", command: "claude", width: null, isSuspended: true },
      { id: "t-3", command: "claude", width: null },
      { id: "t-4", command: "claude", width: null },
    ],
  }];

  it("Given running agents over the threshold, when looking for nearly full contexts, then only they raise an alert", () => {
    const alerts = nearlyFullContexts(workspaces, { "t-3": 0 }, { "t-1": 90, "t-2": 95, "t-3": 99, "t-4": 40 });
    expect(alerts).toEqual([{ terminalId: "t-1", workspaceId: "ws-1", used: 90 }]);
  });
});

describe("latestMessageByAgent", () => {
  it("Given unread messages, when picking the latest per agent, then each agent's latest text is kept", () => {
    expect(latestMessageByAgent([item(1, "t-1", { ts: 10 }), item(2, "t-1", { ts: 20 }), item(3, "t-2", { ts: 5, isRead: true })])).toEqual({ "t-1": "message 2" });
  });
});

describe("lastActivityByAgent", () => {
  it("Given messages, when computing the last activity, then each agent's latest time is kept and system notices are skipped", () => {
    expect(lastActivityByAgent([item(1, "t-1", { ts: 10, isRead: true }), item(2, "t-1", { ts: 5 }), item(3, "t-2", { ts: 50, isSystem: true })])).toEqual({ "t-1": 10 });
  });
});

describe("shellVoiceState", () => {
  it("Given a state from the host, when computing the voice state, then it is used", () => {
    expect(shellVoiceState("preview", "recording")).toBe("preview");
  });

  it("Given no host state, when computing the voice state, then it follows the recorder", () => {
    expect(shellVoiceState(undefined, "recording")).toBe("listening");
    expect(shellVoiceState(undefined, "transcribing")).toBe("transcribing");
    expect(shellVoiceState(undefined, "idle")).toBe("idle");
  });
});

describe("shellVoiceLabel", () => {
  it("Given each voice state, when labelling it, then it is named", () => {
    expect(shellVoiceLabel("listening", translateNow)).toBe(translateNow("shell.voiceListening"));
    expect(shellVoiceLabel("transcribing", translateNow)).toBe(translateNow("shell.voiceTranscribing"));
    expect(shellVoiceLabel("preview", translateNow)).toBe(translateNow("shell.voicePreview"));
    expect(shellVoiceLabel("error", translateNow)).toBe(translateNow("shell.voiceError"));
    expect(shellVoiceLabel("idle", translateNow)).toBe(translateNow("shell.voice"));
  });
});
