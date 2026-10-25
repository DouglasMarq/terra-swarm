import { describe, expect, it } from "vitest";
import { deriveAgentStatus, isTerminalRunning } from "./agentStatus";

describe("isTerminalRunning", () => {
  it("Given a live terminal, when checking it, then it is running", () => {
    expect(isTerminalRunning({ id: "a" }, {})).toBe(true);
  });

  it("Given a suspended or exited terminal, when checking it, then it is not running", () => {
    expect(isTerminalRunning({ id: "a", suspended: true }, {})).toBe(false);
    expect(isTerminalRunning({ id: "a" }, { a: null })).toBe(false);
  });
});

describe("deriveAgentStatus", () => {
  it("Given a suspended or exited process, when deriving the status, then the process state wins", () => {
    expect(deriveAgentStatus({ isSuspended: true, reported: "needs_input" })).toBe("suspended");
    expect(deriveAgentStatus({ hasExited: true, notifications: 3 })).toBe("exited");
  });

  it("Given anything that needs a human, when deriving the status, then it comes first", () => {
    expect(deriveAgentStatus({ reported: "needs_input" })).toBe("attention");
    expect(deriveAgentStatus({ reported: "blocked" })).toBe("attention");
    expect(deriveAgentStatus({ reported: "idle", notifications: 1 })).toBe("attention");
    expect(deriveAgentStatus({ reported: "working", contextUsed: 90 })).toBe("attention");
  });

  it("Given a reported state or none, when deriving the status, then the reported state is used, else a live agent is working", () => {
    expect(deriveAgentStatus({ reported: "idle" })).toBe("idle");
    expect(deriveAgentStatus({ reported: "working" })).toBe("working");
    expect(deriveAgentStatus({})).toBe("working");
  });
});
