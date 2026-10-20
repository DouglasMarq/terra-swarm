/** 950 → "950", 12_345 → "12.3k", 4_200_000 → "4.2M". */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < 1000) return String(Math.max(0, Math.round(value || 0)));
  const [divisor, suffix] = value >= 1e9 ? [1e9, "B"] : value >= 1e6 ? [1e6, "M"] : [1e3, "k"];
  const scaled = value / divisor;
  return `${scaled >= 100 ? Math.round(scaled) : Number(scaled.toFixed(1))}${suffix}`;
}
