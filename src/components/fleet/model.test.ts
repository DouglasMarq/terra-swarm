import { describe, expect, it } from "vitest";
import type { Workspace, WorkspaceGroup } from "../../types";
import {
  deriveFleetModel,
  filterFleetModel,
  fleetAggregateStatus,
  formatFleetDuration,
  formatFleetRelativeTime,
} from "./model";

const groups: WorkspaceGroup[] = [
  {
    id: "core",
    name: "Core",
    collapsed: false,
    projectIds: ["terra"],
    parentGroupId: null,
    suspended: false,
  },
  {
    id: "paused",
    name: "Paused",
    collapsed: false,
    projectIds: ["archive"],
    parentGroupId: null,
    suspended: true,
  },
];

const workspaces: Workspace[] = [
  {
    id: "terra",
    name: "Terra Swarm",
    cwd: "/work/terra",
    groupId: "core",
    terminals: [
      { id: "codex-1", command: "codex --full-auto", width: 120 },
      { id: "claude-1", command: "claude", width: 120 },
    ],
  },
  {
    id: "archive",
    name: "Archive",
    cwd: "/work/archive",
    terminals: [{ id: "shell-1", command: "zsh", width: 80 }],
  },
  {
    id: "scratch",
    name: "Scratch",
    cwd: "/work/scratch",
    terminals: [{ id: "aider-1", command: "aider", width: 80 }],
  },
];

describe("fleet model", () => {
  it("normalizes agents into groups, projects, and semantic statuses", () => {
    const model = deriveFleetModel({
      workspaces,
      groups,
      exited: { "claude-1": 1 },
      notifications: { "codex-1": 2 },
      contextUsage: { "aider-1": 91 },
      titles: { "codex-1": "Planning" },
      branches: { terra: "main", archive: "legacy" },
    });

    expect(model.summary).toEqual({ total: 4, working: 0, idle: 0, attention: 2, suspended: 1, exited: 1 });
    expect(model.groups.map((group) => group.id)).toEqual(["core", "paused", "ungrouped"]);
    expect(model.groups[0]?.projects[0]?.agents[0]).toMatchObject({
      id: "codex-1",
      label: "Codex",
      title: "Planning",
      branch: "main",
      status: "attention",
      notificationCount: 2,
    });
    expect(model.groups[1]?.projects[0]?.agents[0]?.status).toBe("suspended");
    expect(model.groups[2]?.projects[0]?.agents[0]?.status).toBe("attention");
  });

  it("supports status, group, agent, and text filters without mutating the source", () => {
    const source = deriveFleetModel({ workspaces, groups });
    const filtered = filterFleetModel(
      deriveFleetModel({ workspaces, groups, notifications: { "codex-1": 1 }, titles: { "codex-1": "Planning" } }),
      { groupId: "core", status: "attention", query: "planning" },
    );

    expect(source.summary.total).toBe(4);
    expect(filtered.agents.map((agent) => agent.id)).toEqual(["codex-1"]);

    const byAgent = filterFleetModel(source, { agent: "Codex" });
    expect(byAgent.agents.map((agent) => agent.id)).toEqual(["codex-1"]);
    const byPath = filterFleetModel(source, { query: "scratch" });
    expect(byPath.agents.map((agent) => agent.id)).toEqual(["aider-1"]);
  });

  it("aggregates a group with attention above working and suspension above exit", () => {
    expect(fleetAggregateStatus(["exited", "suspended"])).toBe("suspended");
    expect(fleetAggregateStatus(["working", "exited"])).toBe("working");
    expect(fleetAggregateStatus(["attention", "working"])).toBe("attention");
    expect(fleetAggregateStatus([])).toBe("working");
  });

  it("formats optional duration and activity telemetry", () => {
    expect(formatFleetDuration(90_000)).toBe("1m 30s");
    expect(formatFleetDuration("queued")).toBe("queued");
    expect(formatFleetRelativeTime(Date.UTC(2026, 0, 1, 11, 0, 0), Date.UTC(2026, 0, 1, 12, 1, 0))).toBe("há 1 h");
    expect(formatFleetRelativeTime("agora")).toBe("agora");
  });

  it("uses the state agents report through their hooks", () => {
    const model = deriveFleetModel({
      workspaces: [{ id: "ws", name: "ws", cwd: "/", terminals: [
        { id: "a", command: "claude", width: null },
        { id: "b", command: "claude", width: null },
        { id: "c", command: "claude", width: null },
      ] }],
      reported: { a: "idle", b: "needs_input" },
    });
    const byId = Object.fromEntries(model.agents.map((agent) => [agent.id, agent.status]));
    expect(byId).toEqual({ a: "idle", b: "attention", c: "working" });
    expect(model.summary.idle).toBe(1);
  });
});
