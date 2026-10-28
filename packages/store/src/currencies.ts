import type { Db } from "./db.js";
import { statement } from "./statements.js";

/*
 * The currency of each venue account (046_account_currencies.sql), so money from accounts in different
 * currencies is reported per currency instead of added 1:1 into one total. The instance's own currency
 * (instances.currency, money.ts) stays the minor unit money is rounded at.
 */

/** Records the currency a state.account poll reported for its account; a repeat writes nothing. */
export function recordAccountCurrency(db: Db, instanceId: string, p: { broker: string; currency: string; accountId?: string | null }): void {
  statement(db,
    `INSERT INTO account_currencies (instance_id, account, label, currency) VALUES (@i, @account, @label, @currency)
     ON CONFLICT(instance_id, account) DO UPDATE SET label=excluded.label, currency=excluded.currency
     WHERE label <> excluded.label OR currency <> excluded.currency`,
  ).run({ i: instanceId, account: p.accountId ?? p.broker, label: p.broker, currency: p.currency.trim().toUpperCase() });
}

/** The currencies the instance's venue accounts book in, A to Z. */
export function instanceCurrencies(db: Db, instanceId: string): string[] {
  return (statement(db, "SELECT DISTINCT currency FROM account_currencies WHERE instance_id=? ORDER BY currency").all(instanceId) as Array<{ currency: string }>)
    .map((r) => r.currency);
}

/**
 * SQL: the currency of round trip `t` (a round_trips row): its account's, by the account its deals state,
 * else by the label it trades under; null when no account reported one (an engine-only close, a silent account).
 */
export const TRIP_CURRENCY = (t: string) => `COALESCE(
  (SELECT c.currency FROM deals d JOIN account_currencies c ON c.instance_id=d.instance_id AND c.account=d.account_id
     WHERE d.instance_id=${t}.instance_id AND d.position_ticket=${t}.position_ticket AND d.account_id IS NOT NULL LIMIT 1),
  (SELECT c.currency FROM account_currencies c WHERE c.instance_id=${t}.instance_id AND c.label=${t}.broker LIMIT 1))`;

/** Money of one currency: the net of the round trips booked in it, and how many. */
export interface CurrencyNet { currency: string | null; net: number; n: number }
