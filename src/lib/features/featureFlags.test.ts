import { describe, expect, it } from "vitest";
import {
  FEATURE_FLAGS_VERSION,
  createFeatureFlagsDocument,
  normalizeFeatureFlags,
  serializeFeatureFlags,
} from "./featureFlags";

describe("versioned feature flags", () => {
  it("fails closed by default and accepts the legacy flat shape", () => {
    expect(normalizeFeatureFlags(undefined)).toEqual({
      durableScrollback: false,
      voiceCommands: false,
    });
    expect(normalizeFeatureFlags({ durableScrollback: true, voiceCommands: "yes" })).toEqual({
      durableScrollback: true,
      voiceCommands: false,
    });
    // Flags that were retired are dropped from stored settings.
    expect(normalizeFeatureFlags({ groups: true, fleetView: true })).toEqual({
      durableScrollback: false,
      voiceCommands: false,
    });
  });

  it("normalizes current envelopes and rejects future versions", () => {
    const document = createFeatureFlagsDocument({ durableScrollback: true, voiceCommands: true });
    expect(document.version).toBe(FEATURE_FLAGS_VERSION);
    expect(normalizeFeatureFlags(serializeFeatureFlags({ voiceCommands: true }).toString()).voiceCommands).toBe(true);
    expect(
      normalizeFeatureFlags({ version: FEATURE_FLAGS_VERSION + 1, flags: { voiceCommands: true } }).voiceCommands,
    ).toBe(false);
  });
});

