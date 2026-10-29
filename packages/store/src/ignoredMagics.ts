import type { Envelope } from "@qkt-insights/contract";
import type { Db } from "./db.js";
import { statement } from "./statements.js";
import { instanceMoneyDigits, sumMoney } from "./money.js";
import { bumpEpoch, bumpReconciliation } from "./versions.js";

/*
 * Magic ranges an instance ignores (INSIGHTS_IGNORE_MAGICS): another system trading the same venue
 * account under its own MT5 magic numbers, such as a soak beside the forward bench. qkt sends every
 * deal and position on the account, so without the rule the instance would show those as
 * Unattributed. A deal in an ignored range is kept in `ignored_deals` instead of `deals`, so no
 * strategy, round trip or account figure reads it; the balance continuity check still counts it,
 * because it moved the account's balance. Positions and pending orders in a range are dropped from
 * the live state. A deal stored before its range was configured stays where it is.
 */

/** A closed range of magic numbers: `lo <= magic <= hi`. */
export interface MagicRange { lo: number; hi: number }

/** The deals an instance ignores and the ranges it ignores them by, for the dashboard's note. */
export interface IgnoredDeals {
  /** The configured ranges, "31000-31199" (or "40000" for a single magic), lowest first. */
  ranges: string[];
  /** Venue deals the ranges kept out, each counted once however many profiles sent it. */
  deals: number;
  /** Their net (profit + commission + swap + fee) in the account currency. */
  net: number;
}

/** Replaces every instance's ignored ranges wholesale: an instance dropped from the map ignores nothing. */
export function replaceIgnoredMagics(db: Db, ranges: Record<string, readonly MagicRange[]>): void {
  const before = statement(db, "SELECT DISTINCT instance_id i FROM ignored_magic_ranges").all() as Array<{ i: string }>;
  const ins = statement(db, "INSERT OR IGNORE INTO ignored_magic_ranges (instance_id, lo, hi) VALUES (?, ?, ?)");
  db.transaction(() => {
    statement(db, "DELETE FROM ignored_magic_ranges").run();
    for (const [instanceId, list] of Object.entries(ranges)) for (const r of list) ins.run(instanceId, r.lo, r.hi);
  })();
  for (const i of new Set([...before.map((r) => r.i), ...Object.keys(ranges)])) bumpReconciliation(db, i);
  bumpEpoch(db);
}

function rangesOf(db: Db, instanceId: string): MagicRange[] {
  return statement(db, "SELECT lo, hi FROM ignored_magic_ranges WHERE instance_id=? ORDER BY lo, hi").all(instanceId) as MagicRange[];
}

const within = (ranges: readonly MagicRange[], magic: number | null | undefined) =>
  magic != null && ranges.some((r) => magic >= r.lo && magic <= r.hi);

/** Whether the instance ignores deals and holdings with this magic. */
export function isIgnoredMagic(db: Db, instanceId: string, magic: number | null | undefined): boolean {
  if (magic == null) return false;
  return statement(db, "SELECT 1 FROM ignored_magic_ranges WHERE instance_id=? AND ? BETWEEN lo AND hi LIMIT 1").get(instanceId, magic) != null;
}

/**
 * Keeps a deal in an ignored range: once per deal ticket, and never when the deal is already in
 * `deals` (stored before its range was configured), so no check counts it twice.
 */
export function recordIgnoredDeal(db: Db, instanceId: string, d: {
  dealTicket: string; broker: string; accountId: string | null; magic: number; ts: number;
  profit: number; commission: number | null; swap: number | null; fee: number | null;
}): boolean {
  const stored = statement(db,
    `INSERT OR IGNORE INTO ignored_deals (instance_id, deal_ticket, broker, account_id, magic, ts, profit, commission, swap, fee)
     SELECT @i, @dealTicket, @broker, @accountId, @magic, @ts, @profit, @commission, @swap, @fee
     WHERE NOT EXISTS (SELECT 1 FROM deals WHERE instance_id=@i AND deal_ticket=@dealTicket)`,
  ).run({ i: instanceId, ...d }).changes > 0;
  if (stored) bumpReconciliation(db, instanceId);
  return stored;
}

/** The state.positions or state.orders envelope without the entries in an ignored range; any other envelope as it is. */
export function withoutIgnoredHoldings(db: Db, instanceId: string, e: Envelope): Envelope {
  if (e.type !== "state.positions" && e.type !== "state.orders") return e;
  const ranges = rangesOf(db, instanceId);
  if (ranges.length === 0) return e;
  const key = e.type === "state.positions" ? "positions" : "orders";
  const list = (e.payload as Record<typeof key, Array<{ magic?: number }>>)[key];
  const kept = list.filter((x) => !within(ranges, x.magic));
  return kept.length === list.length ? e : ({ ...e, payload: { ...e.payload, [key]: kept } } as Envelope);
}

/** An open position of another system on a shared account: its ticket and floating P&L incl. swap (null when the venue marks none). */
export interface OutsidePosition { ticket: string; floating: number | null }

/** The positions of a state.positions envelope that are in an ignored range: what withoutIgnoredHoldings drops. */
export function ignoredPositions(db: Db, instanceId: string, e: Envelope): OutsidePosition[] {
  if (e.type !== "state.positions") return [];
  const ranges = rangesOf(db, instanceId);
  if (ranges.length === 0) return [];
  const positions = (e.payload as { positions: Array<{ ticket: string; magic?: number; profit?: number; swap?: number }> }).positions;
  return positions.filter((x) => within(ranges, x.magic))
    .map((x) => ({ ticket: x.ticket, floating: x.profit == null ? null : x.profit + (x.swap ?? 0) }));
}

const rangeText = (r: MagicRange) => (r.lo === r.hi ? String(r.lo) : `${r.lo}-${r.hi}`);

export function ignoredDeals(db: Db, instanceId: string): IgnoredDeals {
  const rows = statement(db,
    `SELECT COALESCE(profit,0) + COALESCE(commission,0) + COALESCE(swap,0) + COALESCE(fee,0) net FROM ignored_deals g
     WHERE g.instance_id=? AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.instance_id=g.instance_id AND d.deal_ticket=g.deal_ticket)`,
  ).all(instanceId) as Array<{ net: number }>;
  return {
    ranges: rangesOf(db, instanceId).map(rangeText),
    deals: rows.length,
    net: sumMoney(rows.map((r) => r.net), instanceMoneyDigits(db, instanceId)),
  };
}
