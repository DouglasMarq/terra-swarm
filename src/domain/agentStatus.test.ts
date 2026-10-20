import { describe, expect, it } from "vitest";
import { deriveAgentStatus } from "./agentStatus";

describe("deriveAgentStatus", () => {
  it("lets the process state win", () => {
    expect(deriveAgentStatus({ suspended: true, reported: "needs_input" })).toBe("suspended");
    expect(deriveAgentStatus({ exited: true, notifications: 3 })).toBe("exited");
  });

  it("puts anything that needs a human first", () => {
    expect(deriveAgentStatus({ reported: "needs_input" })).toBe("attention");
    expect(deriveAgentStatus({ reported: "blocked" })).toBe("attention");
    expect(deriveAgentStatus({ reported: "idle", notifications: 1 })).toBe("attention");
    expect(deriveAgentStatus({ reported: "working", contextUsed: 90 })).toBe("attention");
  });

  it("uses the reported state, else assumes a live agent is working", () => {
    expect(deriveAgentStatus({ reported: "idle" })).toBe("idle");
    expect(deriveAgentStatus({ reported: "working" })).toBe("working");
    expect(deriveAgentStatus({})).toBe("working");
  });
});
