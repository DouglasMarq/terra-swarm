import { normalizeSearchText } from "../lib/text/normalizeSearchText";
import type { Workspace } from "./workspace.model";

const MAX_NAME_ROUNDS = 100;

/**
 * Optional automatic agent names ("Vega", "Lyra"…). Off by default: agents
 * are identified by their task title and numbered kind. When on, every new
 * agent gets a name from the list that no open agent is using.
 */

export type NamesExhaustedStrategy = "type-number" | "repeat";

export const NAME_SETS = {
  stars: ["Vega", "Lyra", "Orion", "Atlas", "Nova", "Sirius", "Deneb", "Castor", "Rigel", "Altair", "Electra", "Polaris", "Mira", "Hydra", "Capella", "Spica"],
  rivers: ["Xingu", "Tapajós", "Negro", "Juruá", "Madeira", "Paraná", "Iguaçu", "Araguaia", "Tocantins", "Purus", "Japurá", "Solimões", "Pardo", "Doce"],
} as const;

export type NameSetId = keyof typeof NAME_SETS | "custom";

export const DEFAULT_NAME_LIST: readonly string[] = NAME_SETS.stars;

export interface PickAgentNameOptions {
  /** Skip names that start with the same letter as, or sound like, an open agent's name. */
  avoidSimilar?: boolean;
  exhausted?: NamesExhaustedStrategy;
}

/** Rough "sounds alike" check: same first letter and same consonant skeleton, or edit distance ≤ 1. */
export function namesSimilar(first: string, second: string): boolean {
  const normalizedFirst = normalizeSearchText(first);
  const normalizedSecond = normalizeSearchText(second);
  if (!normalizedFirst || !normalizedSecond) return false;
  if (normalizedFirst === normalizedSecond) return true;
  if (normalizedFirst[0] !== normalizedSecond[0]) return false;
  const skeleton = (value: string) => value.replace(/[aeiouy]/g, "");
  if (skeleton(normalizedFirst) === skeleton(normalizedSecond)) return true;
  return editDistanceAtMostOne(normalizedFirst, normalizedSecond);
}

function editDistanceAtMostOne(first: string, second: string): boolean {
  if (Math.abs(first.length - second.length) > 1) return false;
  let firstIndex = 0;
  let secondIndex = 0;
  let edits = 0;
  while (firstIndex < first.length && secondIndex < second.length) {
    if (first[firstIndex] === second[secondIndex]) {
      firstIndex += 1;
      secondIndex += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (first.length > second.length) firstIndex += 1;
    else if (second.length > first.length) secondIndex += 1;
    else {
      firstIndex += 1;
      secondIndex += 1;
    }
  }
  return edits + (first.length - firstIndex) + (second.length - secondIndex) <= 1;
}

/**
 * Picks the next free name. Returns null when the list is exhausted and the
 * strategy is "type-number" (the caller then keeps the numbered kind, e.g.
 * "claude 4").
 */
export function pickAgentName(
  inUse: readonly string[],
  list: readonly string[],
  options: PickAgentNameOptions = {},
): string | null {
  const { avoidSimilar = true, exhausted = "type-number" } = options;
  const taken = new Set(inUse.map(normalizeSearchText));
  const free = list.filter((name) => name.trim() && !taken.has(normalizeSearchText(name)));
  const distinct = avoidSimilar
    ? free.filter((name) => !inUse.some((used) => normalizeSearchText(used)[0] === normalizeSearchText(name)[0] || namesSimilar(used, name)))
    : free;
  if (distinct.length > 0) return distinct[0];
  if (free.length > 0) return free[0];
  if (exhausted === "type-number" || list.length === 0) return null;
  // "repeat": reuse the list with a number, Vega 2, Lyra 2, …
  for (let round = 2; round < MAX_NAME_ROUNDS; round += 1) {
    const candidate = list.map((name) => `${name} ${round}`).find((name) => !taken.has(normalizeSearchText(name)));
    if (candidate) return candidate;
  }
  return null;
}

export function agentNamesInUse(
  workspaces: readonly Workspace[],
  agentNames: Readonly<Record<string, string>>,
): string[] {
  const openIds = new Set(workspaces.flatMap((workspace) => workspace.terminals.map((terminal) => terminal.id)));
  return Object.entries(agentNames).filter(([id]) => openIds.has(id)).map(([, name]) => name);
}
