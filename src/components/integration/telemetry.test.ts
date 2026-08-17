import { describe, expect, it } from "vitest";
import type { Workspace } from "../../types";
import { deriveTelemetryModel } from "./telemetry";

const workspaces: Workspace[] = [{
  id: "project-a",
  name: "Projeto A",
  cwd: "/tmp/a",
  terminals: [
    { id: "term-running", command: "codex", width: 100 },
    { id: "term-exited", command: "shell", width: 100 },
    { id: "term-suspended", command: "claude", width: 100, suspended: true },
  ],
}];

describe("Terra telemetry model", () => {
  it("uses only live counts, resume queue, focused context, voice and sync state", () => {
    expect(deriveTelemetryModel({
      workspaces,
      exited: { "term-exited": 1 },
      resumeCount: 2,
      contextUsage: { "term-running": 72 },
      focusedId: "term-running",
      voiceEnabled: true,
      voiceActive: true,
      voiceLabel: "Ouvindo",
      orchestrationHydrated: true,
    })).toEqual({
      activeAgents: 1,
      totalAgents: 3,
      queuedRuns: 2,
      focusedContext: 72,
      voiceLabel: "Ouvindo",
      voiceState: "active",
      syncState: "synced",
    });
  });

  it("does not fabricate context or voice metrics when no target/feature exists", () => {
    expect(deriveTelemetryModel({
      workspaces: [],
      exited: {},
      contextUsage: {},
      voiceEnabled: false,
      voiceActive: false,
      voiceLabel: "Voz",
      orchestrationHydrated: false,
    })).toMatchObject({
      activeAgents: 0,
      totalAgents: 0,
      queuedRuns: 0,
      focusedContext: null,
      voiceState: "disabled",
      syncState: "syncing",
    });
  });
});
