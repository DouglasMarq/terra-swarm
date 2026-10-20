import { describe, expect, it } from "vitest";
import { isAgentRole, orchestratorOf } from "./agentRoles";

describe("agent roles", () => {
  it("recognises roles", () => {
    expect(isAgentRole("tester")).toBe(true);
    expect(isAgentRole("boss")).toBe(false);
  });

  it("finds the running orchestrator of a project", () => {
    const terminals = [
      { id: "t-1", command: "claude", width: null, role: "orchestrator" as const },
      { id: "t-2", command: "claude", width: null, role: "orchestrator" as const },
      { id: "t-3", command: "codex", width: null, role: "executor" as const },
    ];
    expect(orchestratorOf({ terminals }, {})).toBe("t-1");
    expect(orchestratorOf({ terminals }, { "t-1": 0 })).toBe("t-2");
    expect(orchestratorOf({ terminals: terminals.slice(2) }, {})).toBeNull();
    expect(orchestratorOf(null, {})).toBeNull();
  });
});
