import type { TerminalTab } from "../workspace.model";
import type { UnknownRecord } from "../../lib/records/records";

export const DOMAIN_SNAPSHOT_VERSION = 2 as const;

export type RecordLike = UnknownRecord;

export function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function readFlag(raw: RecordLike, key: string, legacyKey: string): unknown {
  return raw[key] ?? raw[legacyKey];
}

export function uniqueId(preferred: string, fallback: string, used: Set<string>): string {
  const base = preferred || fallback;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

export type RuntimeTab = TerminalTab & {
  groupId?: string | null;
  isSuspended?: boolean;
  isPlacementExplicit?: boolean;
};

export function runtimeTab(tab: TerminalTab): RuntimeTab {
  return tab as RuntimeTab;
}

export interface ActiveSelection {
  activeProjectId: string | null;
  activeContainerId: string | null;
  activePaneId: string | null;
  activeTabId: string | null;
}
