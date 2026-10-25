import { describe, expect, it } from "vitest";
import { migrateLegacyWorkspaces } from "../../domain/migration";
import type { Workspace, WorkspaceSnapshotV2 } from "../../domain/workspace.model";
import { projectWorkbench, toWorkbenchSnapshot } from "./projection";

const legacy: Workspace[] = [
  {
    id: "alpha",
    name: "Alpha",
    cwd: "/tmp/alpha",
    terminals: [
      { id: "pty-1", command: "luna", width: 80, paneId: "pane-a", tabId: "tab-a" },
      { id: "pty-2", command: "shell", width: 100, paneId: "pane-a", tabId: "tab-b" },
    ],
  },
];

describe("workbench projection", () => {
  it("projects legacy workspaces into container → pane → tabs", () => {
    const projection = projectWorkbench(legacy);
    expect(projection.containers).toHaveLength(1);
    expect(projection.containers[0].project?.name).toBe("Alpha");
    expect(projection.containers[0].panes).toHaveLength(1);
    expect(projection.containers[0].panes[0].tabs.map((tab) => tab.id)).toEqual(["tab-a", "tab-b"]);
  });

  it("keeps hidden containers and does not turn a visual close into a PTY delete", () => {
    const snapshot = migrateLegacyWorkspaces(legacy);
    const hidden: WorkspaceSnapshotV2 = {
      ...snapshot,
      containers: snapshot.containers.map((container) => ({
        ...container,
        visible: false,
        closed: true,
      })),
    };
    const projection = projectWorkbench(hidden);
    expect(projection.containers).toHaveLength(1);
    expect(projection.containers[0].container.visible).toBe(false);
    expect(projection.containers[0].panes[0].tabs).toHaveLength(2);
    expect(hidden.tabs.map((tab) => tab.ptyId)).toEqual(["pty-1", "pty-2"]);
  });

  it("uses declared pane and tab order while dropping dangling references", () => {
    const snapshot = migrateLegacyWorkspaces(legacy);
    const altered: WorkspaceSnapshotV2 = {
      ...snapshot,
      panes: snapshot.panes.map((pane) => ({
        ...pane,
        tabIds: ["tab-b", "missing", "tab-a"],
      })),
      containers: snapshot.containers.map((container) => ({
        ...container,
        paneIds: ["missing-pane", ...container.paneIds],
      })),
    };
    const projection = projectWorkbench(altered);
    expect(projection.containers[0].panes).toHaveLength(1);
    expect(projection.containers[0].panes[0].tabs.map((tab) => tab.id)).toEqual(["tab-b", "tab-a"]);
  });

  it("accepts a normalized snapshot without migrating or mutating it", () => {
    const snapshot = migrateLegacyWorkspaces(legacy);
    const before = JSON.stringify(snapshot);
    expect(toWorkbenchSnapshot(snapshot)).toBe(snapshot);
    expect(JSON.stringify(snapshot)).toBe(before);
  });
});

