import { describe, expect, it } from "vitest";
import { isVoiceLanguage } from "./voiceLanguages";

describe("isVoiceLanguage", () => {
  it("Given an offered language or auto, when checking it, then it is accepted", () => {
    expect(isVoiceLanguage("auto")).toBe(true);
    expect(isVoiceLanguage("pt")).toBe(true);
  });

  it("Given an unknown or non-string value, when checking it, then it is rejected", () => {
    expect(isVoiceLanguage("xx")).toBe(false);
    expect(isVoiceLanguage("")).toBe(false);
    expect(isVoiceLanguage(null)).toBe(false);
  });
});
