import { describe, expect, it } from "vitest";
import type { Workspace, WorkspaceGroup } from "../../domain/workspace.model";
import { translateNow } from "../../i18n";
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
  it("Given workspaces with agents, when building the model, then agents are normalized into groups, projects and semantic statuses", () => {
    const model = deriveFleetModel({
      workspaces,
      groups,
      exited: { "claude-1": 1 },
      notifications: { "codex-1": 2 },
      contextUsage: { "aider-1": 91 },
      titles: { "codex-1": "Planning" },
      branches: { terra: "main", archive: "legacy" },
    }, translateNow);

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

  it("Given a fleet model, when filtering by status, group, agent or text, then the source is not mutated", () => {
    const source = deriveFleetModel({ workspaces, groups }, translateNow);
    const filtered = filterFleetModel(
      deriveFleetModel({ workspaces, groups, notifications: { "codex-1": 1 }, titles: { "codex-1": "Planning" } }, translateNow),
      { groupId: "core", status: "attention", query: "planning" },
    );

    expect(source.summary.total).toBe(4);
    expect(filtered.agents.map((agent) => agent.id)).toEqual(["codex-1"]);

    const byAgent = filterFleetModel(source, { agent: "Codex" });
    expect(byAgent.agents.map((agent) => agent.id)).toEqual(["codex-1"]);
    const byPath = filterFleetModel(source, { query: "scratch" });
    expect(byPath.agents.map((agent) => agent.id)).toEqual(["aider-1"]);
  });

  it("Given a group, when aggregating its status, then attention ranks above working and suspension above exit", () => {
    expect(fleetAggregateStatus(["exited", "suspended"])).toBe("suspended");
    expect(fleetAggregateStatus(["working", "exited"])).toBe("working");
    expect(fleetAggregateStatus(["attention", "working"])).toBe("attention");
    expect(fleetAggregateStatus([])).toBe("working");
  });

  it("Given optional duration and activity telemetry, when building the model, then they are formatted", () => {
    const now = Date.UTC(2026, 0, 1, 12, 1, 0);
    expect(formatFleetDuration(90_000, now, translateNow)).toBe("1m 30s");
    expect(formatFleetDuration("queued", now, translateNow)).toBe("queued");
    expect(formatFleetRelativeTime(Date.UTC(2026, 0, 1, 11, 0, 0), now, translateNow)).toBe("há 1 h");
    expect(formatFleetRelativeTime("agora", now, translateNow)).toBe("agora");
  });

  it("Given states reported through hooks, when building the model, then they are used", () => {
    const model = deriveFleetModel({
      workspaces: [{ id: "ws", name: "ws", cwd: "/", terminals: [
        { id: "a", command: "claude", width: null },
        { id: "b", command: "claude", width: null },
        { id: "c", command: "claude", width: null },
      ] }],
      reported: { a: "idle", b: "needs_input" },
    }, translateNow);
    const byId = Object.fromEntries(model.agents.map((agent) => [agent.id, agent.status]));
    expect(byId).toEqual({ a: "idle", b: "attention", c: "working" });
    expect(model.summary.idle).toBe(1);
  });

  it("Given shells the rest of the UI recognizes, when deriving the fleet, then they are labelled as shells", () => {
    const commands = ["sh", "pwsh", "nu", "cmd.exe", "/usr/bin/zsh -l", "powershell"];
    const model = deriveFleetModel({
      workspaces: [{ id: "ws", name: "ws", cwd: "/", terminals: commands.map((command, position) => ({ id: `t${position}`, command, width: null })) }],
    }, translateNow);
    expect(model.agents.map((agent) => agent.label)).toEqual(commands.map(() => translateNow("fleet.shellAgent")));
  });

  it("Given an agent, a script or a command without an executable, when deriving the fleet, then it labels the agent, the script or the shell", () => {
    const model = deriveFleetModel({
      workspaces: [{ id: "ws", name: "ws", cwd: "/", terminals: [
        { id: "a", command: "codex --full-auto", width: null },
        { id: "b", command: "./scripts/run.sh", width: null },
        { id: "c", command: "/", width: null },
      ] }],
    }, translateNow);
    expect(model.agents.map((agent) => agent.label)).toEqual(["Codex", "Run", translateNow("fleet.shellAgent")]);
  });
});
