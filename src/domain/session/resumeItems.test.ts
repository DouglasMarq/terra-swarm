import { describe, expect, it } from "vitest";
import type { Workspace } from "../workspace.model";
import { resumableItems, resumeCommandFor, resumeItemFor } from "./resumeItems";

const workspace: Workspace = {
  id: "ws-1",
  name: "Demo project",
  cwd: "/projects/demo",
  terminals: [{ id: "t-1", command: "claude", width: null }],
};

describe("resumeCommandFor", () => {
  it("Given a known agent with a resume flag, when resolving its resume command, then it uses that flag", () => {
    expect(resumeCommandFor("claude")).toBe("claude --continue");
  });

  it("Given a plain shell, when resolving its resume command, then it reruns the original command", () => {
    expect(resumeCommandFor("zsh")).toBe("zsh");
  });
});

describe("resumeItemFor", () => {
  it("Given a workspace terminal, when building its resume item, then it carries the workspace, agent and resume command", () => {
    expect(resumeItemFor(workspace, workspace.terminals[0])).toEqual({
      terminalId: "t-1",
      wsId: "ws-1",
      wsName: "Demo project",
      cwd: "/projects/demo",
      command: "claude",
      agentId: "claude",
      resumeCommand: "claude --continue",
    });
  });
});

describe("resumableItems", () => {
  const project: Workspace = {
    id: "ws-2",
    name: "Second project",
    cwd: "/projects/second",
    terminals: [
      { id: "t-exited", command: "claude", width: null },
      { id: "t-suspended", command: "codex", width: null, suspended: true },
      { id: "t-live", command: "zsh", width: null },
    ],
  };

  it("Given exited, suspended and live terminals, when picking resumable items, then only exited and suspended ones are kept in the requested order", () => {
    const items = resumableItems([project], ["t-suspended", "t-live", "t-exited", "t-missing"], { "t-exited": 0 });

    expect(items.map((item) => item.terminalId)).toEqual(["t-suspended", "t-exited"]);
  });
});
