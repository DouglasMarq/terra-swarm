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
      groups: false,
      subTabs: false,
      durableScrollback: false,
      fleetView: false,
      voiceCommands: false,
    });
    expect(normalizeFeatureFlags({ groups: true, fleetView: "yes" })).toMatchObject({
      groups: true,
      fleetView: false,
    });
  });

  it("normalizes current envelopes and rejects future versions", () => {
    const document = createFeatureFlagsDocument({ groups: true, voiceCommands: true });
    expect(document.version).toBe(FEATURE_FLAGS_VERSION);
    expect(normalizeFeatureFlags(serializeFeatureFlags({ groups: true }).toString()).groups).toBe(true);
    expect(normalizeFeatureFlags({ version: FEATURE_FLAGS_VERSION + 1, flags: { groups: true } }).groups).toBe(
      false,
    );
  });
});

