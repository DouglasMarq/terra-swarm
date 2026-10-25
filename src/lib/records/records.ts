export type UnknownRecord = Record<string, unknown>;

function isObject(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object";
}

export function isRecord(value: unknown): value is UnknownRecord {
  return isObject(value) && !Array.isArray(value);
}

export function asRecord(value: unknown): UnknownRecord {
  return isObject(value) ? value : {};
}

export function omitKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}
