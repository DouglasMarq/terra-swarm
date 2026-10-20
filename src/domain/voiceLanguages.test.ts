import { describe, expect, it } from "vitest";
import { isVoiceLanguage } from "./voiceLanguages";

describe("isVoiceLanguage", () => {
  it("given an offered language or auto, accepts it", () => {
    expect(isVoiceLanguage("auto")).toBe(true);
    expect(isVoiceLanguage("pt")).toBe(true);
  });

  it("given an unknown or non-string value, rejects it", () => {
    expect(isVoiceLanguage("xx")).toBe(false);
    expect(isVoiceLanguage("")).toBe(false);
    expect(isVoiceLanguage(null)).toBe(false);
  });
});
