/**
 * Account money at the account currency's minor unit. The venue books every deal in whole minor
 * units (cents for USD); a sum of those amounts in binary floating point lands a hair off the cent
 * (-250.2 + -0.1 is -250.29999999999998), which a comparison or a win/loss split must never see.
 * Stored figures (a closing leg, a round trip, a day) are rounded to the minor unit on write. A venue
 * can book finer than that (a paper perpetual's fee is a fraction of a cent), so a total sums the rows'
 * unrounded amounts and rounds once: it is what the deals total, which can differ from the sum of the
 * rows as printed by a cent per few rows. Over whole-cent amounts the two are the same.
 */

/** Minor-unit decimals of the ISO 4217 currencies that do not use 2. */
const MINOR_UNITS: Readonly<Record<string, number>> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0, RWF: 0, UGX: 0, UYI: 0,
  VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  CLF: 4, UYW: 4,
};

/** Decimals of the currency's minor unit: USD 2, JPY 0, KWD 3; 2 for an unknown or missing currency. */
export function moneyDigits(currency: string | null | undefined): number {
  return (currency ? MINOR_UNITS[currency.trim().toUpperCase()] : undefined) ?? 2;
}

/** What a row adds to a total: its unrounded amount, its minor-unit one when the row carries no other. */
export function exactMoney(row: { realized: number; realizedExact?: number | null }): number {
  return row.realizedExact ?? row.realized;
}

/**
 * `v` at `digits` decimals, halves away from zero, read at 15 significant digits first so float
 * noise cannot move it across a half (1.005 is 1.01, -280.34999999999997 is -280.35). Never -0.
 */
export function roundMoney(v: number, digits = 2): number {
  if (!Number.isFinite(v)) return v;
  const scaled = Number((Math.abs(v) * 10 ** digits).toPrecision(15));
  const r = (Math.sign(v) * Math.round(scaled)) / 10 ** digits;
  return r === 0 ? 0 : r;
}
