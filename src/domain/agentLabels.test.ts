import { describe, expect, it } from "vitest";
import type { Workspace } from "./workspace.model";
import { agentKind, buildAgentLabels, cleanAgentTitle } from "./agentLabels";

const workspace = (terminals: Array<[string, string]>): Workspace => ({
  id: "ws",
  name: "terra-swarm",
  cwd: "/tmp",
  terminals: terminals.map(([id, command]) => ({ id, command, width: null })),
});

describe("agentKind", () => {
  it("Given a command, when reading the agent kind, then it uses the executable name and folds shells", () => {
    expect(agentKind("claude --continue")).toBe("claude");
    expect(agentKind("/opt/homebrew/bin/codex resume --last")).toBe("codex");
    expect(agentKind("zsh")).toBe("shell");
    expect(agentKind("")).toBe("shell");
  });
});

describe("cleanAgentTitle", () => {
  it("Given a raw title, when cleaning it, then spinner glyphs are stripped and titles without a task are dropped", () => {
    expect(cleanAgentTitle("✳ Refatorar planejador", "claude", "claude")).toBe("Refatorar planejador");
    expect(cleanAgentTitle("⠂ Revisar PR", "claude", "claude")).toBe("Revisar PR");
    expect(cleanAgentTitle("Claude Code", "claude", "claude")).toBeNull();
    expect(cleanAgentTitle("~/projects/terra", "zsh", "shell")).toBeNull();
    expect(cleanAgentTitle("me@host:~/x", "zsh", "shell")).toBeNull();
    expect(cleanAgentTitle("claude", "claude", "claude")).toBeNull();
  });
});

describe("buildAgentLabels", () => {
  it("Given repeated and unique kinds in a project, when building labels, then repeated kinds are numbered and unique ones stay bare", () => {
    const labels = buildAgentLabels([workspace([["a", "claude"], ["b", "codex"], ["c", "claude"]])]);
    expect(labels.a.tag).toBe("claude 1");
    expect(labels.c.tag).toBe("claude 2");
    expect(labels.b.tag).toBe("codex");
    expect(labels.a.primary).toBe("claude 1");
  });

  it("Given a task title and a name, when building labels, then the title is primary and the name goes in the tag", () => {
    const labels = buildAgentLabels([workspace([["a", "claude"], ["b", "claude"]])], {
      titles: { a: "✳ Animações do Workbench" },
      names: { b: "Lyra" },
    });
    expect(labels.a.primary).toBe("Animações do Workbench");
    expect(labels.a.tag).toBe("claude 1");
    expect(labels.b.primary).toBe("Lyra");
    expect(labels.b.tag).toBe("Lyra · claude");
  });
});
