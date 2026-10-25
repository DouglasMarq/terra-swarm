import { describe, expect, it } from "vitest";
import { normalizeVoiceText, parseVoiceCommand } from "./voiceCommands";

describe("parseVoiceCommand", () => {
  it.each([
    ["focar terminal Luna", { type: "focus", target: "luna" }],
    ["focus terminal codex-2", { type: "focus", target: "codex-2" }],
    ["por favor, abrir a frota", { type: "open-fleet" }],
  ])("parses focus/fleet explicitly: %s", (text, expected) => {
    expect(parseVoiceCommand(text)).toEqual(expected);
  });

  it("accepts pt-BR accents and English fleet commands", () => {
    expect(parseVoiceCommand("abrir a frota")).toEqual({ type: "open-fleet" });
    expect(parseVoiceCommand("open the fleet")).toEqual({ type: "open-fleet" });
    expect(parseVoiceCommand("suspender o grupo Revisão")).toEqual({
      type: "suspend-group",
      group: "revisao",
    });
    expect(parseVoiceCommand("resume the group Luna Max")).toEqual({
      type: "resume-group",
      group: "luna max",
    });
  });

  it("supports a named or default new agent", () => {
    expect(parseVoiceCommand("novo agente")).toEqual({ type: "new-agent" });
    expect(parseVoiceCommand("new agent Luna Max")).toEqual({
      type: "new-agent",
      agent: "luna max",
    });
  });

  it("does not classify free-form or shell-shaped speech", () => {
    expect(parseVoiceCommand("execute ls -la")).toBeNull();
    expect(parseVoiceCommand("focus $(rm -rf /)")).toBeNull();
    expect(parseVoiceCommand("suspender grupo")).toBeNull();
    expect(parseVoiceCommand("")).toBeNull();
  });
});

describe("normalizeVoiceText", () => {
  it("given spoken text with accents, extra spaces and trailing marks, folds it for matching", () => {
    expect(normalizeVoiceText("  O Claude   das Animações?!")).toBe("o claude das animacoes");
  });

  it("given punctuation inside the text, keeps it", () => {
    expect(normalizeVoiceText("codex-2, por favor")).toBe("codex-2, por favor");
  });
});
