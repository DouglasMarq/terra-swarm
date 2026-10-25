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
  it("Given raw profiles, when normalizing them, then ids, labels, commands and resume strategy are normalized", () => {
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

  it("Given configured profiles, when normalizing the list, then duplicates are removed and built-ins are the fallback", () => {
    const profiles = normalizeAgentProfiles([
      { id: "claude", label: "First", command: "claude" },
      { id: "claude", label: "Second", command: "claude" },
    ]);
    expect(profiles).toHaveLength(1);
    expect(normalizeAgentProfiles(undefined)).toHaveLength(DEFAULT_AGENT_PROFILES.length);
    expect(profileForCommand("codex --no-alt-screen").id).toBe("codex");
  });

  it("Given a voice behavior, when rendering it, then it does not depend on a terminal", () => {
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
  it("Given a continuation command, when computing the fresh command, then it maps back to the agent's own command", () => {
    expect(freshCommand("claude --continue")).toBe("claude");
    expect(freshCommand("codex  resume --last")).toBe("codex");
    expect(freshCommand("claude --model opus")).toBe("claude --model opus");
    expect(freshCommand("shell")).toBe("shell");
  });
});

describe("fallbackProfile", () => {
  it("Given a built-in agent id, when asking for its fallback profile, then its catalog profile is returned", () => {
    expect(fallbackProfile("claude")).toBe(DEFAULT_AGENT_PROFILES.find((profile) => profile.id === "claude"));
  });

  it("Given an unknown id, when asking for its fallback profile, then it runs that id and resumes with the original command", () => {
    expect(fallbackProfile("my-agent")).toEqual({
      id: "my-agent",
      label: "my-agent",
      command: "my-agent",
      resumeCommandStrategy: { kind: "original" },
      voicePromptBehavior: { enabled: true, mode: "append", prefix: "", suffix: "" },
    });
  });
});
