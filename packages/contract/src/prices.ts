/**
 * Display precision of instrument prices. The venue quotes each instrument to a fixed number of
 * decimals (XAUUSD 2, EURUSD 5, USDJPY 3); figures the engine computes (a stop at entry − 1.5 ATR,
 * a weighted average exit) carry float noise past it. Shared by the server (timeline text, CSV)
 * and the web (tables, drawer), so a price reads the same everywhere.
 */

/** Most decimals a venue quote is read with; anything past it is computation noise. */
export const MAX_PRICE_DIGITS = 6;

/** Decimals a venue price was quoted with: 4127.67 → 2, 1.08455 → 5, 4135 → 0. */
export function decimalsOf(v: number): number {
  if (!Number.isFinite(v)) return 0;
  const s = Number(v.toPrecision(12)).toFixed(MAX_PRICE_DIGITS).replace(/0+$/, "");
  const i = s.indexOf(".");
  return i < 0 || i === s.length - 1 ? 0 : s.length - i - 1;
}

/** The conventional quote precision of metals, JPY crosses and FX pairs; null for anything else. */
export function knownDigits(instrument: string): number | null {
  const s = instrument.toUpperCase();
  if (s.startsWith("XAU")) return 2;
  if (s.startsWith("XAG")) return 3;
  if (/^[A-Z]{6}$/.test(s)) return s.endsWith("JPY") ? 3 : 5;
  return null;
}

/** Precision for an instrument with no venue prices to read: the convention, else 2. */
export function defaultDigits(instrument: string): number {
  return knownDigits(instrument) ?? 2;
}

/**
 * The precision of one instrument's venue prices: the most decimals among them, never below the
 * convention for metals and FX (a run of round prices says nothing about the quote). An unknown
 * instrument with no prices gets 2.
 */
export function digitsFrom(prices: readonly number[], instrument: string): number {
  const seen = prices.filter((p) => Number.isFinite(p) && p !== 0);
  const known = knownDigits(instrument);
  if (seen.length === 0) return known ?? 2;
  const observed = Math.min(MAX_PRICE_DIGITS, Math.max(...seen.map(decimalsOf)));
  return known == null ? observed : Math.max(observed, known);
}

/** A price at its instrument's precision, plain ASCII ("4122.72", "-0.07"); null for a missing one. */
export function roundPrice(v: number | null | undefined, digits: number): string | null {
  if (v == null || !Number.isFinite(v)) return null;
  const s = v.toFixed(digits);
  return /^-0\.?0*$/.test(s) ? s.slice(1) : s;
}
