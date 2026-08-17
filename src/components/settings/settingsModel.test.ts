import { describe, expect, it } from "vitest";

import {
  filterSettingsSections,
  getInitialSettingsSection,
  normalizeSettingsSearch,
  SETTINGS_SECTIONS,
} from "./settingsModel";

describe("settings registry", () => {
  it("keeps the nine Terra settings categories in a stable order", () => {
    expect(SETTINGS_SECTIONS.map((section) => section.id)).toEqual([
      "profile",
      "appearance",
      "terminal",
      "voice",
      "agents",
      "orchestration",
      "shortcuts",
      "data",
      "updates",
    ]);
  });

  it("normalizes accents and case for Brazilian Portuguese search", () => {
    expect(normalizeSettingsSearch("  Orquestração  ")).toBe("orquestracao");
    expect(filterSettingsSections(SETTINGS_SECTIONS, "MICROFONE").map((section) => section.id)).toEqual([
      "voice",
    ]);
  });

  it("matches descriptions and keywords, not only visible labels", () => {
    expect(filterSettingsSections(SETTINGS_SECTIONS, "scrollback").map((section) => section.id)).toEqual([
      "terminal",
    ]);
    expect(filterSettingsSections(SETTINGS_SECTIONS, "fleet").map((section) => section.id)).toEqual([
      "orchestration",
    ]);
  });

  it("falls back to the first registered section when selection is invalid", () => {
    expect(getInitialSettingsSection(SETTINGS_SECTIONS, "voice")).toBe("voice");
    expect(getInitialSettingsSection(SETTINGS_SECTIONS, "missing" as never)).toBe("profile");
    expect(getInitialSettingsSection([])).toBeUndefined();
  });
});

