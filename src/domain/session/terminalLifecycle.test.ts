import { describe, expect, it } from "vitest";
import { isCurrentSpawnedTerminalRunning } from "./terminalLifecycle";

describe("terminal spawn lifecycle", () => {
  it("Given an immediate exit or an old generation, when checking the spawned terminal, then it is not treated as live", () => {
    expect(isCurrentSpawnedTerminalRunning("t-immediate", 8, [])).toBe(false);
    expect(
      isCurrentSpawnedTerminalRunning("t-immediate", 8, [
        { id: "t-immediate", seq: 7 },
      ]),
    ).toBe(false);
    expect(
      isCurrentSpawnedTerminalRunning("t-immediate", 8, [
        { id: "t-immediate", seq: 8 },
      ]),
    ).toBe(true);
  });
});
