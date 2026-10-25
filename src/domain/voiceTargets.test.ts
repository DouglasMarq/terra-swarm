import { describe, expect, it } from "vitest";
import type { Workspace, WorkspaceGroup } from "./workspace.model";
import { isVoiceModelError, resolveVoiceAgent, resolveVoiceGroup, resolveVoiceTerminal } from "./voiceTargets";

const workspaces: Workspace[] = [
  {
    id: "ws-alpha",
    name: "Alpha",
    cwd: "/work/alpha",
    terminals: [
      { id: "term-claude", command: "claude", width: null },
      { id: "term-codex", command: "codex --full-auto", width: null },
    ],
  },
  {
    id: "ws-beta",
    name: "Beta",
    cwd: "/work/beta",
    terminals: [{ id: "term-zsh", command: "zsh", width: null }],
  },
];

const noLabels = { titles: {}, names: {} };

describe("resolveVoiceTerminal", () => {
  it("Given a spoken agent kind, when resolving, then it returns that agent's terminal and project", () => {
    const match = resolveVoiceTerminal(workspaces, "Codex", noLabels);

    expect(match?.terminal.id).toBe("term-codex");
    expect(match?.workspace.id).toBe("ws-alpha");
  });

  it("Given part of a task title, when resolving, then it matches the terminal by title", () => {
    const match = resolveVoiceTerminal(workspaces, "login", {
      titles: { "term-claude": "Fix the login form" },
      names: {},
    });

    expect(match?.terminal.id).toBe("term-claude");
  });

  it("Given a project name, when no agent matches, then it returns the project's first terminal", () => {
    expect(resolveVoiceTerminal(workspaces, "beta", noLabels)?.terminal.id).toBe("term-zsh");
  });

  it("Given an empty or unknown target, when resolving, then it returns null", () => {
    expect(resolveVoiceTerminal(workspaces, "  ", noLabels)).toBeNull();
    expect(resolveVoiceTerminal(workspaces, "gamma", noLabels)).toBeNull();
  });
});

describe("resolveVoiceGroup", () => {
  const groups: WorkspaceGroup[] = [
    { id: "group-front", name: "Frontend", collapsed: false, projectIds: [], parentGroupId: null, suspended: false },
  ];

  it("Given a group name or id, when resolving, then it returns the group id", () => {
    expect(resolveVoiceGroup(groups, "frontend")).toBe("group-front");
    expect(resolveVoiceGroup(groups, "group-front")).toBe("group-front");
  });

  it("Given an unknown group, when resolving, then it returns null", () => {
    expect(resolveVoiceGroup(groups, "backend")).toBeNull();
  });
});

describe("resolveVoiceAgent", () => {
  const agents = [
    { id: "claude", label: "Claude Code", available: true },
    { id: "gemini", label: "Gemini", available: false },
  ];

  it("Given an available agent's label, when resolving, then it returns that agent", () => {
    expect(resolveVoiceAgent(agents, "claude code")?.id).toBe("claude");
  });

  it("Given an unavailable agent, when resolving, then it returns null", () => {
    expect(resolveVoiceAgent(agents, "gemini")).toBeNull();
  });
});

describe("isVoiceModelError", () => {
  it("Given a message about the speech model, when checked, then it is a model error", () => {
    expect(isVoiceModelError("Whisper model not found")).toBe(true);
    expect(isVoiceModelError("Modelo ausente")).toBe(true);
  });

  it("Given any other message, when checked, then it is not a model error", () => {
    expect(isVoiceModelError("microphone busy")).toBe(false);
    expect(isVoiceModelError(undefined)).toBe(false);
  });
});
