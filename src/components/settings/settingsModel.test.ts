import { describe, expect, it } from "vitest";

import {
  filterSettingsSections,
  getInitialSettingsSection,
  SETTINGS_SECTIONS,
} from "./settingsModel";
import { normalizeSearchText } from "../../lib/text/normalizeSearchText";

describe("settings registry", () => {
  it("Given the settings registry, when listing categories, then the seven categories keep a stable order", () => {
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

  it("Given a Brazilian Portuguese search, when searching settings, then accents and case are normalized", () => {
    expect(normalizeSearchText("  Orquestração  ")).toBe("orquestracao");
    expect(filterSettingsSections(SETTINGS_SECTIONS, "orquestracao").map((section) => section.id)).toEqual([
      "general",
    ]);
    expect(filterSettingsSections(SETTINGS_SECTIONS, "MICROFONE").map((section) => section.id)).toEqual([
      "voice",
    ]);
  });

  it("Given a query, when searching settings, then descriptions and keywords match, not only visible labels", () => {
    expect(filterSettingsSections(SETTINGS_SECTIONS, "scrollback").map((section) => section.id)).toEqual([
      "terminal",
    ]);
    expect(filterSettingsSections(SETTINGS_SECTIONS, "language").map((section) => section.id)).toEqual([
      "general",
    ]);
  });

  it("Given an invalid selection, when resolving the section, then it falls back to the first registered section", () => {
    expect(getInitialSettingsSection(SETTINGS_SECTIONS, "voice")).toBe("voice");
    expect(getInitialSettingsSection(SETTINGS_SECTIONS, "missing" as never)).toBe("general");
    expect(getInitialSettingsSection([])).toBeUndefined();
  });
});

