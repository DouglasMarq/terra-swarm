import { describe, expect, it } from "vitest";
import { normalizeVoiceText, parseVoiceCommand } from "./voiceCommands";

describe("parseVoiceCommand", () => {
  it.each([
    ["focar terminal Luna", { type: "focus", target: "luna" }],
    ["focus terminal codex-2", { type: "focus", target: "codex-2" }],
    ["por favor, abrir a frota", { type: "open-fleet" }],
  ])("Given the explicit command %s, when parsing it, then it is classified as focus or fleet", (text, expected) => {
    expect(parseVoiceCommand(text)).toEqual(expected);
  });

  it("Given pt-BR accents and English fleet commands, when parsing them, then they are accepted", () => {
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

  it("Given a named or unnamed new agent request, when parsing it, then a named or default new agent is returned", () => {
    expect(parseVoiceCommand("novo agente")).toEqual({ type: "new-agent" });
    expect(parseVoiceCommand("new agent Luna Max")).toEqual({
      type: "new-agent",
      agent: "luna max",
    });
  });

  it("Given free-form or shell-shaped speech, when parsing it, then it is not classified", () => {
    expect(parseVoiceCommand("execute ls -la")).toBeNull();
    expect(parseVoiceCommand("focus $(rm -rf /)")).toBeNull();
    expect(parseVoiceCommand("suspender grupo")).toBeNull();
    expect(parseVoiceCommand("")).toBeNull();
  });
});

describe("normalizeVoiceText", () => {
  it("Given spoken text with accents, extra spaces and trailing marks, when normalizing it, then it is folded for matching", () => {
    expect(normalizeVoiceText("  O Claude   das Animações?!")).toBe("o claude das animacoes");
  });

  it("Given punctuation inside the text, when normalizing it, then it is kept", () => {
    expect(normalizeVoiceText("codex-2, por favor")).toBe("codex-2, por favor");
  });
});
