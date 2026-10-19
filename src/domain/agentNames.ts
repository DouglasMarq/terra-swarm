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

function normalize(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** Rough "sounds alike" check: same first letter and same consonant skeleton, or edit distance ≤ 1. */
export function namesSimilar(a: string, b: string): boolean {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x[0] !== y[0]) return false;
  const skeleton = (value: string) => value.replace(/[aeiouy]/g, "");
  if (skeleton(x) === skeleton(y)) return true;
  return editDistanceAtMostOne(x, y);
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
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
  const taken = new Set(inUse.map(normalize));
  const free = list.filter((name) => name.trim() && !taken.has(normalize(name)));
  const distinct = avoidSimilar
    ? free.filter((name) => !inUse.some((used) => normalize(used)[0] === normalize(name)[0] || namesSimilar(used, name)))
    : free;
  if (distinct.length > 0) return distinct[0];
  if (free.length > 0) return free[0];
  if (exhausted === "type-number" || list.length === 0) return null;
  // "repeat": reuse the list with a number, Vega 2, Lyra 2, …
  for (let round = 2; round < 100; round += 1) {
    const candidate = list.map((name) => `${name} ${round}`).find((name) => !taken.has(normalize(name)));
    if (candidate) return candidate;
  }
  return null;
}
