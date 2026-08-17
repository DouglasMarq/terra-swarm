/** Versioned, fail-closed feature flags for capabilities introduced in waves 3/4. */

export const FEATURE_FLAGS_VERSION = 1 as const;

export const FEATURE_FLAG_IDS = [
  "groups",
  "subTabs",
  "durableScrollback",
  "fleetView",
  "voiceCommands",
] as const;

export type FeatureFlagId = (typeof FEATURE_FLAG_IDS)[number];
export type FeatureFlags = Record<FeatureFlagId, boolean>;

export type FeatureFlagsDocument = {
  version: typeof FEATURE_FLAGS_VERSION;
  flags: FeatureFlags;
};

export const DEFAULT_FEATURE_FLAGS: Readonly<FeatureFlags> = Object.freeze({
  groups: false,
  subTabs: false,
  durableScrollback: false,
  fleetView: false,
  voiceCommands: false,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseInput(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function validVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function flagValues(raw: unknown): Partial<FeatureFlags> {
  if (!isRecord(raw)) return {};
  const result: Partial<FeatureFlags> = {};
  for (const id of FEATURE_FLAG_IDS) {
    if (typeof raw[id] === "boolean") result[id] = raw[id];
  }
  return result;
}

function withDefaults(flags: Partial<FeatureFlags>): FeatureFlags {
  return {
    groups: flags.groups ?? DEFAULT_FEATURE_FLAGS.groups,
    subTabs: flags.subTabs ?? DEFAULT_FEATURE_FLAGS.subTabs,
    durableScrollback: flags.durableScrollback ?? DEFAULT_FEATURE_FLAGS.durableScrollback,
    fleetView: flags.fleetView ?? DEFAULT_FEATURE_FLAGS.fleetView,
    voiceCommands: flags.voiceCommands ?? DEFAULT_FEATURE_FLAGS.voiceCommands,
  };
}

/**
 * Normalizes legacy flat settings and the current versioned envelope. Unknown
 * future versions fail closed, so a new flag cannot accidentally enable an
 * unsupported capability in an older binary.
 */
export function normalizeFeatureFlags(raw: unknown): FeatureFlags {
  const parsed = parseInput(raw);
  if (!isRecord(parsed)) return { ...DEFAULT_FEATURE_FLAGS };

  if ("version" in parsed) {
    if (!validVersion(parsed.version) || parsed.version > FEATURE_FLAGS_VERSION) {
      return { ...DEFAULT_FEATURE_FLAGS };
    }
    const source = isRecord(parsed.flags) ? parsed.flags : {};
    return withDefaults(flagValues(source));
  }

  // Version 0 was the unwrapped map used by early development builds.
  return withDefaults(flagValues(parsed));
}

export function createFeatureFlagsDocument(
  flags?: Partial<FeatureFlags> | unknown,
): FeatureFlagsDocument {
  return {
    version: FEATURE_FLAGS_VERSION,
    flags: normalizeFeatureFlags(flags),
  };
}

export function serializeFeatureFlags(flags?: Partial<FeatureFlags> | unknown): string {
  return JSON.stringify(createFeatureFlagsDocument(flags));
}

export function isFeatureEnabled(id: FeatureFlagId, flags: Partial<FeatureFlags> | unknown): boolean {
  return normalizeFeatureFlags(flags)[id];
}

export function setFeatureFlag(
  flags: Partial<FeatureFlags> | unknown,
  id: FeatureFlagId,
  enabled: boolean,
): FeatureFlags {
  return { ...normalizeFeatureFlags(flags), [id]: enabled };
}

export const parseFeatureFlags = normalizeFeatureFlags;
export const readFeatureFlags = normalizeFeatureFlags;
export const getDefaultFeatureFlags = (): FeatureFlags => ({ ...DEFAULT_FEATURE_FLAGS });

