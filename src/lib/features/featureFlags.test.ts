import { describe, expect, it } from "vitest";
import {
  FEATURE_FLAGS_VERSION,
  createFeatureFlagsDocument,
  normalizeFeatureFlags,
  serializeFeatureFlags,
} from "./featureFlags";

describe("versioned feature flags", () => {
  it("Given no or legacy flat settings, when reading the flags, then they fail closed by default and the legacy flat shape is accepted", () => {
    expect(normalizeFeatureFlags(undefined)).toEqual({
      durableScrollback: false,
      voiceCommands: false,
    });
    expect(normalizeFeatureFlags({ durableScrollback: true, voiceCommands: "yes" })).toEqual({
      durableScrollback: true,
      voiceCommands: false,
    });
    expect(normalizeFeatureFlags({ groups: true, fleetView: true })).toEqual({
      durableScrollback: false,
      voiceCommands: false,
    });
  });

  it("Given current and future envelopes, when reading the flags, then current ones are normalized and future versions are rejected", () => {
    const document = createFeatureFlagsDocument({ durableScrollback: true, voiceCommands: true });
    expect(document.version).toBe(FEATURE_FLAGS_VERSION);
    expect(normalizeFeatureFlags(serializeFeatureFlags({ voiceCommands: true }).toString()).voiceCommands).toBe(true);
    expect(
      normalizeFeatureFlags({ version: FEATURE_FLAGS_VERSION + 1, flags: { voiceCommands: true } }).voiceCommands,
    ).toBe(false);
  });
});

