/*
 * What one unit of a position's quantity is. qkt states an instrument's kind on deals and positions
 * (`instrument.kind`: cfd from MT5, equity/spot/perpetual/future/option from a gateway's listing or qkt's
 * registry) but not yet the unit of `qty` (`instrument.quantityUnit`), so a unit is named from the kind:
 * an MT5 CFD trades in lots, a share in shares, a spot coin in coins, and a gateway's derivatives in
 * contracts of the stated contract size. A stated unit wins; a kind this release does not know names none.
 */
const UNIT_BY_KIND: Record<string, string> = {
  cfd: "lots", equity: "shares", spot: "coins", perpetual: "contracts", future: "contracts", option: "contracts",
};

/** The unit of `qty` for an instrument of `kind`, or `stated` when qkt named one; null when neither says. */
export function quantityUnitOf(kind: string | null | undefined, stated: string | null | undefined): string | null {
  if (stated) return stated;
  return kind ? UNIT_BY_KIND[kind.toLowerCase()] ?? null : null;
}
