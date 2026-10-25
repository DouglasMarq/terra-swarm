const THOUSAND = 1e3;
const MILLION = 1e6;
const BILLION = 1e9;
const WHOLE_NUMBER_FROM = 100;

function scaleOf(value: number): [number, string] {
  if (value >= BILLION) return [BILLION, "B"];
  if (value >= MILLION) return [MILLION, "M"];
  return [THOUSAND, "k"];
}

/** 950 → "950", 12_345 → "12.3k", 4_200_000 → "4.2M". */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < THOUSAND) return String(Math.max(0, Math.round(value || 0)));
  const [divisor, suffix] = scaleOf(value);
  const scaled = value / divisor;
  return `${scaled >= WHOLE_NUMBER_FROM ? Math.round(scaled) : Number(scaled.toFixed(1))}${suffix}`;
}
