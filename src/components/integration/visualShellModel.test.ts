import { describe, expect, it } from "vitest";
import { t } from "../../i18n";
import type { NotificationItem, TerminalTab, Workspace, WorkspaceContainer, WorkspaceSnapshotV2 } from "../../types";
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
  return { id, paneId: "pane-1", ptyId, command: "claude", cwd: "/Users/me/project", width: null, title: id, orphaned: false };
}

function container(id: string, projectId: string): WorkspaceContainer {
  return { id, projectId, paneIds: [], layout: { mode: "grid" }, visible: true, collapsed: false, closed: false, fullscreen: false };
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

function item(key: number, terminalId: string, ts: number, extra: Partial<NotificationItem> = {}): NotificationItem {
  return { key, terminalId, workspaceId: "ws-1", message: `message ${key}`, ts, read: false, ...extra };
}

describe("visibleSnapshot", () => {
  it("given nothing detached and no focus, returns the snapshot as is", () => {
    const source = snapshot();
    expect(visibleSnapshot(source, [], null)).toBe(source);
    expect(visibleSnapshot(null, ["t-1"], "t-1")).toBeNull();
  });

  it("given a detached active tab, drops it and activates the pane's first visible tab", () => {
    const visible = visibleSnapshot(snapshot(), ["t-1"], null);
    expect(visible?.tabs.map((entry) => entry.id)).toEqual(["tab-2", "tab-3"]);
    expect(visible?.panes[0]).toMatchObject({ tabIds: ["tab-2", "tab-3"], activeTabId: "tab-2" });
    expect(visible?.activeTabId).toBe("tab-2");
  });

  it("given a focused terminal, activates its tab in the pane that holds it", () => {
    expect(visibleSnapshot(snapshot(), [], "t-3")?.panes[0]?.activeTabId).toBe("tab-3");
  });
});

describe("workbenchSnapshot", () => {
  it("given an active project, keeps only that project's containers", () => {
    expect(workbenchSnapshot(snapshot(), [], null, "ws-2")?.containers.map((entry) => entry.id)).toEqual(["c-2"]);
  });

  it("given no active project, keeps every container", () => {
    expect(workbenchSnapshot(snapshot(), [], null, null)?.containers).toHaveLength(2);
  });
});

describe("projectStatus", () => {
  it("given an agent that needs the user, needs attention", () => {
    expect(projectStatus(["working", "attention", "idle"])).toBe("attention");
  });

  it("given a working agent and none needing the user, is working", () => {
    expect(projectStatus(["idle", "working"])).toBe("working");
  });

  it("given only idle, suspended or exited agents, or none, is idle", () => {
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
      { id: "t-2", command: "claude", width: null, suspended: true },
      { id: "t-3", command: "claude", width: null },
      { id: "t-4", command: "claude", width: null },
    ],
  }];

  it("given running agents over the threshold, alerts for them only", () => {
    const alerts = nearlyFullContexts(workspaces, { "t-3": 0 }, { "t-1": 90, "t-2": 95, "t-3": 99, "t-4": 40 });
    expect(alerts).toEqual([{ terminalId: "t-1", workspaceId: "ws-1", used: 90 }]);
  });
});

describe("latestMessageByAgent", () => {
  it("given unread messages, keeps each agent's latest text", () => {
    expect(latestMessageByAgent([item(1, "t-1", 10), item(2, "t-1", 20), item(3, "t-2", 5, { read: true })])).toEqual({ "t-1": "message 2" });
  });
});

describe("lastActivityByAgent", () => {
  it("given messages, keeps each agent's latest time and skips system notices", () => {
    expect(lastActivityByAgent([item(1, "t-1", 10, { read: true }), item(2, "t-1", 5), item(3, "t-2", 50, { system: true })])).toEqual({ "t-1": 10 });
  });
});

describe("shellVoiceState", () => {
  it("given a state from the host, uses it", () => {
    expect(shellVoiceState("preview", "recording")).toBe("preview");
  });

  it("given no host state, follows the recorder", () => {
    expect(shellVoiceState(undefined, "recording")).toBe("listening");
    expect(shellVoiceState(undefined, "transcribing")).toBe("transcribing");
    expect(shellVoiceState(undefined, "idle")).toBe("idle");
  });
});

describe("shellVoiceLabel", () => {
  it("given each state, names it", () => {
    expect(shellVoiceLabel("listening", t)).toBe(t("shell.voiceListening"));
    expect(shellVoiceLabel("transcribing", t)).toBe(t("shell.voiceTranscribing"));
    expect(shellVoiceLabel("preview", t)).toBe(t("shell.voicePreview"));
    expect(shellVoiceLabel("error", t)).toBe(t("shell.voiceError"));
    expect(shellVoiceLabel("idle", t)).toBe(t("shell.voice"));
  });
});
