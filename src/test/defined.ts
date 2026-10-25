export function defined<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected a value, got nothing");
  return value;
}
