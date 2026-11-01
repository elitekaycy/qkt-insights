import type { Db } from "./db.js";
import { maskLogin } from "@qkt-insights/contract/accountIdentity";
import { statement } from "./statements.js";

/*
 * The currency of each venue account (046_account_currencies.sql), so money from accounts in different
 * currencies is reported per currency instead of added 1:1 into one total. The instance's own currency
 * (instances.currency, money.ts) stays the minor unit money is rounded at.
 */

/** Records the currency a state.account poll reported for its account; a repeat writes nothing. */
export function recordAccountCurrency(db: Db, instanceId: string, p: {
  broker: string; currency: string; accountId?: string | null; login?: string | null;
  venue?: { connector?: string | null; adapter?: string | null; tradeMode?: string | null } | null;
}): void {
  statement(db,
    `INSERT INTO account_currencies (instance_id, account, label, currency, connector, adapter, trade_mode, login)
     VALUES (@i, @account, @label, @currency, @connector, @adapter, @tradeMode, @login)
     ON CONFLICT(instance_id, account) DO UPDATE SET label=excluded.label, currency=excluded.currency,
       connector=COALESCE(excluded.connector, connector), adapter=COALESCE(excluded.adapter, adapter),
       trade_mode=COALESCE(excluded.trade_mode, trade_mode), login=COALESCE(excluded.login, login)
     WHERE label <> excluded.label OR currency <> excluded.currency
       OR excluded.connector IS NOT connector OR excluded.adapter IS NOT adapter
       OR excluded.trade_mode IS NOT trade_mode OR excluded.login IS NOT login`,
  ).run({
    i: instanceId, account: p.accountId ?? p.broker, label: p.broker, currency: p.currency.trim().toUpperCase(),
    connector: p.venue?.connector ?? null, adapter: p.venue?.adapter ?? null, tradeMode: p.venue?.tradeMode ?? null,
    login: p.login ? maskLogin(p.login) : null,
  });
}

/** What a venue account is, as its last state.account stated it (049_account_venue_facts.sql). */
export interface AccountVenueFacts {
  account: string; label: string; currency: string;
  connector: string | null; adapter: string | null; tradeMode: string | null;
  /** The login masked to its last four characters ("•••9381"). */
  login: string | null;
}

/** The venue facts of every account the instance ever reported, by account id (or label, for an account without one). */
export function accountVenueFacts(db: Db, instanceId: string): AccountVenueFacts[] {
  return statement(db,
    `SELECT account, label, currency, connector, adapter, trade_mode tradeMode, login FROM account_currencies
     WHERE instance_id=? ORDER BY account`,
  ).all(instanceId) as AccountVenueFacts[];
}

/** The currencies the instance's venue accounts book in, A to Z. */
export function instanceCurrencies(db: Db, instanceId: string): string[] {
  return (statement(db, "SELECT DISTINCT currency FROM account_currencies WHERE instance_id=? ORDER BY currency").all(instanceId) as Array<{ currency: string }>)
    .map((r) => r.currency);
}

/** The currency of one venue account, by its id or any of its broker labels; null when it never reported one. */
export function accountCurrency(db: Db, instanceId: string, account: { identity: string | null; key: string; labels: readonly string[] }): string | null {
  const names = JSON.stringify([account.identity, account.key].filter((n): n is string => n != null));
  const row = statement(db,
    `SELECT currency FROM account_currencies WHERE instance_id=@i
       AND (account IN (SELECT value FROM json_each(@names)) OR label IN (SELECT value FROM json_each(@labels)))
     ORDER BY account IN (SELECT value FROM json_each(@names)) DESC LIMIT 1`,
  ).get({ i: instanceId, names, labels: JSON.stringify(account.labels) }) as { currency: string } | undefined;
  return row?.currency ?? null;
}

/**
 * The currency of the account a broker profile trades on: the one it reported, else the one its account
 * reported under another profile (several profiles on one venue account report as one); null when unknown.
 */
export function brokerCurrency(db: Db, instanceId: string, broker: string): string | null {
  const row = statement(db,
    `SELECT currency FROM account_currencies WHERE instance_id=@i AND (label=@broker OR account=@broker
       OR account IN (SELECT identity FROM account_labels WHERE instance_id=@i AND broker=@broker)
       OR account IN (SELECT account_id FROM deals WHERE instance_id=@i AND broker=@broker AND account_id IS NOT NULL))
     ORDER BY label=@broker DESC LIMIT 1`,
  ).get({ i: instanceId, broker }) as { currency: string } | undefined;
  return row?.currency ?? null;
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
