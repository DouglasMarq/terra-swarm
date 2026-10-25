import { describe, expect, it } from "vitest";
import type { Workspace, WorkspaceSnapshotV2 } from "../../domain/workspace.model";
import {
  inspectorActionRequiresConfirmation,
  resolveInspectorTarget,
  totalTokens,
} from "./inspectorModel";
import { defined } from "../../test/defined";

const workspace: Workspace = {
  id: "project-one",
  name: "Terra",
  cwd: "/work/terra",
  groupId: "group-agents",
  terminals: [{
    id: "pty-codex",
    command: "codex --full-auto",
    width: 120,
    paneId: "pane-one",
    tabId: "tab-one",
  }],
};

const snapshot: WorkspaceSnapshotV2 = {
  version: 2,
  projects: [{
    id: "project-one",
    name: "Terra project",
    cwd: "/work/terra",
    groupId: "group-agents",
    paneIds: ["pane-one"],
    containerIds: ["container-one"],
    activePaneId: "pane-one",
    activeContainerId: "container-one",
    layout: { mode: "grid" },
    collapsed: false,
  }],
  groups: [{
    id: "group-agents",
    name: "Agentes",
    projectIds: ["project-one"],
    parentGroupId: null,
    collapsed: false,
    suspended: false,
    layout: { mode: "grid" },
  }],
  containers: [{
    id: "container-one",
    projectId: "project-one",
    paneIds: ["pane-one"],
    layout: { mode: "grid" },
    visible: true,
    collapsed: false,
    closed: false,
    fullscreen: false,
  }],
  panes: [{
    id: "pane-one",
    projectId: "project-one",
    containerId: "container-one",
    tabIds: ["tab-one"],
    activeTabId: "tab-one",
    layout: { mode: "grid" },
  }],
  tabs: [{
    id: "tab-one",
    paneId: "pane-one",
    ptyId: "pty-codex",
    command: "codex --full-auto",
    cwd: "/work/terra",
    width: 120,
    title: "Codex executor",
    orphaned: false,
  }],
  orphanedTabIds: [],
  activeProjectId: "project-one",
  activeGroupId: "group-agents",
  activeContainerId: "container-one",
  activePaneId: "pane-one",
  activeTabId: "tab-one",
  layout: { mode: "grid" },
};

describe("resolveInspectorTarget", () => {
  it("Given a lifecycle mutation, when resolving the target, then it requires explicit confirmation before it can execute", () => {
    expect(inspectorActionRequiresConfirmation("kill")).toBe(true);
    expect(inspectorActionRequiresConfirmation("restart")).toBe(true);
    expect(inspectorActionRequiresConfirmation("focus")).toBe(false);
    expect(inspectorActionRequiresConfirmation("detach")).toBe(false);
    expect(inspectorActionRequiresConfirmation("reattach")).toBe(false);
  });

  it("Given real metadata, when resolving the focused terminal, then the complete project hierarchy is resolved", () => {
    expect(resolveInspectorTarget({
      focusedId: "pty-codex",
      workspaces: [workspace],
      snapshot,
      titles: { "pty-codex": "Codex em foco" },
      contextUsage: { "pty-codex": 42 },
      detachedTerminalIds: ["pty-other"],
    })).toEqual(expect.objectContaining({
      terminalId: "pty-codex",
      displayName: "Codex em foco",
      projectName: "Terra project",
      groupName: "Agentes",
      containerId: "container-one",
      paneId: "pane-one",
      tabId: "tab-one",
      profileId: "codex",
      profileLabel: "Codex",
      cwd: "/work/terra",
      state: "ativo",
      contextUsage: 42,
      isDetached: false,
    }));
  });

  it("Given the PTY API has no value, when resolving the target, then no process metrics are fabricated", () => {
    const target = resolveInspectorTarget({ focusedId: "pty-codex", workspaces: [workspace] });
    expect(target).toEqual(expect.objectContaining({ state: "ativo", contextUsage: null }));
    expect(target).not.toHaveProperty("pid");
    expect(target).not.toHaveProperty("cpu");
    expect(target).not.toHaveProperty("memory");
  });

  it("Given an observed exit and a stale suspended flag, when resolving the target, then the exit wins", () => {
    const suspended = {
      ...workspace,
      terminals: [{ ...defined(workspace.terminals[0]), suspended: true }],
    };
    expect(resolveInspectorTarget({
      focusedId: "pty-codex",
      workspaces: [suspended],
      snapshot,
      exited: { "pty-codex": null },
    })?.state).toBe("encerrado");
  });
});

describe("totalTokens", () => {
  it("Given a session's usage, when totalling tokens, then input, output and both cache directions are added", () => {
    expect(totalTokens({
      terminal_id: "t-1",
      agent: "claude",
      input_tokens: 1,
      output_tokens: 20,
      cache_read_tokens: 300,
      cache_write_tokens: 4000,
      turns: 3,
      model: null,
    })).toBe(4321);
  });
});
