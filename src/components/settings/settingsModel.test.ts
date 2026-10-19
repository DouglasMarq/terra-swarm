import { describe, expect, it } from "vitest";

import {
  filterSettingsSections,
  getInitialSettingsSection,
  normalizeSettingsSearch,
  SETTINGS_SECTIONS,
} from "./settingsModel";

describe("settings registry", () => {
  it("keeps the seven settings categories in a stable order", () => {
    expect(SETTINGS_SECTIONS.map((section) => section.id)).toEqual([
      "general",
      "terminal",
      "agents",
      "voice",
      "shortcuts",
      "data",
      "about",
    ]);
  });

  it("normalizes accents and case for Brazilian Portuguese search", () => {
    expect(normalizeSettingsSearch("  Orquestração  ")).toBe("orquestracao");
    expect(filterSettingsSections(SETTINGS_SECTIONS, "orquestracao").map((section) => section.id)).toEqual([
      "general",
    ]);
    expect(filterSettingsSections(SETTINGS_SECTIONS, "MICROFONE").map((section) => section.id)).toEqual([
      "voice",
    ]);
  });

  it("matches descriptions and keywords, not only visible labels", () => {
    expect(filterSettingsSections(SETTINGS_SECTIONS, "scrollback").map((section) => section.id)).toEqual([
      "terminal",
    ]);
    expect(filterSettingsSections(SETTINGS_SECTIONS, "language").map((section) => section.id)).toEqual([
      "general",
    ]);
  });

  it("falls back to the first registered section when selection is invalid", () => {
    expect(getInitialSettingsSection(SETTINGS_SECTIONS, "voice")).toBe("voice");
    expect(getInitialSettingsSection(SETTINGS_SECTIONS, "missing" as never)).toBe("general");
    expect(getInitialSettingsSection([])).toBeUndefined();
  });
});

