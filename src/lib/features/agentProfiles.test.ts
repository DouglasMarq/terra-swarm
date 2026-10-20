import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_PROFILES,
  buildVoicePrompt,
  fallbackProfile,
  freshCommand,
  normalizeAgentProfile,
  normalizeAgentProfiles,
  profileForCommand,
  resolveResumeCommand,
} from "./agentProfiles";

describe("agent profiles", () => {
  it("normalizes IDs, labels, commands, and resume strategy", () => {
    const profile = normalizeAgentProfile({
      id: " custom agent ",
      label: "  Custom  ",
      command: "  custom --fast  ",
      resumeCommandStrategy: { kind: "template", template: "{command} --resume {session}" },
    });
    expect(profile.id).toBe("custom-agent");
    expect(profile.label).toBe("Custom");
    expect(profile.command).toBe("custom --fast");
    expect(resolveResumeCommand(profile, "custom --fast", { session: "42" })).toBe(
      "custom --fast --resume 42",
    );
  });

  it("deduplicates configured profiles and falls back to built-ins", () => {
    const profiles = normalizeAgentProfiles([
      { id: "claude", label: "First", command: "claude" },
      { id: "claude", label: "Second", command: "claude" },
    ]);
    expect(profiles).toHaveLength(1);
    expect(normalizeAgentProfiles(undefined)).toHaveLength(DEFAULT_AGENT_PROFILES.length);
    expect(profileForCommand("codex --no-alt-screen").id).toBe("codex");
  });

  it("renders voice behavior without coupling to a terminal", () => {
    const profile = normalizeAgentProfile({
      id: "voice-agent",
      voicePromptBehavior: { mode: "prepend", prefix: "Review: " },
    });
    expect(buildVoicePrompt(profile, "the patch")).toBe("Review: the patch");
    const disabled = normalizeAgentProfile({ id: "silent", voicePromptBehavior: false });
    expect(buildVoicePrompt(disabled, "keep this text")).toBe("keep this text");
  });
});

describe("freshCommand", () => {
  it("maps a continuation command back to the agent's own command", () => {
    expect(freshCommand("claude --continue")).toBe("claude");
    expect(freshCommand("codex  resume --last")).toBe("codex");
    expect(freshCommand("claude --model opus")).toBe("claude --model opus");
    expect(freshCommand("shell")).toBe("shell");
  });
});

describe("fallbackProfile", () => {
  it("given a built-in agent id, returns its catalog profile", () => {
    expect(fallbackProfile("claude")).toBe(DEFAULT_AGENT_PROFILES.find((profile) => profile.id === "claude"));
  });

  it("given an unknown id, returns a profile that runs it and resumes with the original command", () => {
    expect(fallbackProfile("my-agent")).toEqual({
      id: "my-agent",
      label: "my-agent",
      command: "my-agent",
      resumeCommandStrategy: { kind: "original" },
      voicePromptBehavior: { enabled: true, mode: "append", prefix: "", suffix: "" },
    });
  });
});
