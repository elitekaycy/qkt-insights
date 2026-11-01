import { exactMoney, moneyDigits, roundMoney } from "@qkt-insights/contract/money";
import type { Db } from "./db.js";
import { statement } from "./statements.js";
import { bumpEpoch } from "./versions.js";

export { exactMoney, moneyDigits, roundMoney };

/** Minor-unit decimals of the instance's account currency (instances.currency); 2 when unknown. */
export function instanceMoneyDigits(db: Db, instanceId: string): number {
  const row = statement(db, "SELECT currency FROM instances WHERE id=?").get(instanceId) as { currency: string | null } | undefined;
  return moneyDigits(row?.currency);
}

/**
 * Records the account currency a state.account poll reported. When its minor unit differs from the
 * one the instance's money was stored at, every position and engine close of the instance is
 * queued, so the next read rewrites them (and the days they feed) at the new unit.
 */
export function setInstanceCurrency(db: Db, instanceId: string, currency: string): void {
  const before = statement(db, "SELECT currency FROM instances WHERE id=?").get(instanceId) as { currency: string | null } | undefined;
  if (!before || before.currency === currency) return;
  statement(db, "UPDATE instances SET currency=? WHERE id=?").run(currency, instanceId);
  if (moneyDigits(before.currency) === moneyDigits(currency)) return;
  statement(db,
    `INSERT OR IGNORE INTO projection_dirty (kind, instance_id, key)
     SELECT DISTINCT 'position', instance_id, COALESCE('p:' || position_ticket, 'd:' || rowid) FROM deals WHERE instance_id=?`,
  ).run(instanceId);
  statement(db,
    "INSERT OR IGNORE INTO projection_dirty (kind, instance_id, key) SELECT 'position', instance_id, 'l:' || id FROM trade_closes WHERE instance_id=?",
  ).run(instanceId);
  bumpEpoch(db);
}

/** `total + v` at `digits`: a running sum of money that stays at the minor unit, whatever the order of its terms. */
export function addMoney(total: number, v: number, digits: number): number {
  return roundMoney(total + roundMoney(v, digits), digits);
}

/** Every value of `values` summed with addMoney. */
export function sumMoney(values: Iterable<number>, digits: number): number {
  let t = 0;
  for (const v of values) t = addMoney(t, v, digits);
  return t;
}

/** Running sums rounded per step: each leg of `values` keeps the exact running total at `digits`. */
export function cumulativeRounding(values: readonly number[], digits: number): number[] {
  let raw = 0, prior = 0;
  return values.map((v) => {
    raw += v;
    const cum = roundMoney(raw, digits);
    const leg = roundMoney(cum - prior, digits);
    prior = cum;
    return leg;
  });
}
