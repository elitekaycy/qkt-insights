import type { Db } from "./db.js";
import { statement } from "./statements.js";
import { refreshProjections } from "./projections.js";
import { instanceMoneyDigits, roundMoney } from "./money.js";
import { endedFromDealComment, endedFromEngineEvents, entryOrderByTicket, type Ended, type EventsNear } from "./inferredVenueFacts.js";

/** Window around a leg in which the engine events that explain it are looked for. */
const BEFORE_MS = 10 * 60_000;
const AFTER_MS = 2 * 60_000;

const CLOSING = new Set(["OUT", "INOUT", "OUT_BY"]);

interface Leg {
  broker: string; symbol: string | null; side: string | null; entry: string | null; qty: number | null; price: number | null;
  profit: number | null; commission: number | null; swap: number | null; fee: number | null; comment: string | null;
  strategyId: string | null; orderTicket: string | null; closeReason: string | null; ts: number;
}

export interface RoundTripRow {
  instanceId: string; positionTicket: string; broker: string | null; strategyId: string | null; instrument: string; symbol: string | null;
  side: "long" | "short"; entryTs: number | null; entryPrice: number | null; exitTs: number | null; exitPrice: number | null; qty: number | null;
  realized: number; gross: number; commission: number; swap: number; fee: number; legs: number;
  entryOrderId: string | null; entryOrderTicket: string | null; stopPrice: number | null; targetPrice: number | null;
  ended: Ended | null; holdMs: number | null; open: boolean;
  /** "deal": a venue position from its deals; "ledger": one engine close no venue deal stands for. */
  source: "deal" | "ledger";
  /** Why the position closed, as qkt stated it (STOP, TAKE_PROFIT, SIGNAL, MANUAL, TIMED, STOP_OUT, ...); null when not stated. */
  closeReason: string | null;
  /** The entry's money at risk to its initial stop, as qkt stated it; null when not stated. */
  riskAmount: number | null;
}

/**
 * The `ended` code of each close reason qkt states: a stop or target, the venue (a stop-out, a
 * liquidation, an expiry), a person, or the strategy's own exit (its signal or its timed hold).
 */
const ENDED_BY_REASON: Record<string, Ended> = {
  STOP: "stop", TAKE_PROFIT: "tp", STOP_OUT: "so", LIQUIDATION: "so", EXPIRY: "so", MANUAL: "manual", SIGNAL: "signal", TIMED: "signal",
};

/** The `ended` code of a stated close reason; null for none or one this release does not know. */
export function endedByReason(reason: string | null | undefined): Ended | null {
  return reason == null ? null : ENDED_BY_REASON[reason.toUpperCase()] ?? null;
}

function instrument(symbol: string | null): string {
  if (!symbol) return "";
  const i = symbol.lastIndexOf(":");
  return i >= 0 ? symbol.slice(i + 1) : symbol;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** A stop or target as qkt sends it: a bare price, or `{type: "Fixed", price}`. */
const level = (v: unknown): number | null => num(v) ?? (v != null && typeof v === "object" ? num((v as { price?: unknown }).price) : null);

function eventsNear(db: Db, instanceId: string, type: string, ts: number): Array<Record<string, unknown>> {
  return (statement(db, "SELECT payload FROM events WHERE instance_id=? AND type=? AND ts BETWEEN ? AND ? ORDER BY ts, seq")
    .all(instanceId, type, ts - BEFORE_MS, ts + AFTER_MS) as Array<{ payload: string }>).map((r) => {
    try { return JSON.parse(r.payload) as Record<string, unknown>; } catch { return {}; }
  });
}

/** Size-weighted price of legs; null without volume. Summed in leg order. */
function weighted(legs: Leg[]): number | null {
  let q = 0, v = 0;
  for (const l of legs) { q += l.qty ?? 0; v += (l.qty ?? 0) * (l.price ?? 0); }
  return q > 0 ? v / q : null;
}

/**
 * Rewrites the round trip of one position from its canonical legs and the engine events around
 * its entry and exit. O(legs) plus a few indexed event reads.
 */
export function recomputeRoundTrip(db: Db, instanceId: string, position: string): void {
  const legs = statement(db,
    `SELECT broker, symbol, side, entry, qty, price, profit, commission, swap, fee, comment, strategy_id strategyId, order_ticket orderTicket,
       close_reason closeReason, ts
     FROM deals WHERE instance_id=? AND position_ticket=? AND canonical=1 ORDER BY ts, rowid`,
  ).all(instanceId, position) as Leg[];
  const prior = statement(db,
    "SELECT stop_price stopPrice, target_price targetPrice, ended FROM round_trips WHERE instance_id=? AND position_ticket=?",
  ).get(instanceId, position) as { stopPrice: number | null; targetPrice: number | null; ended: string | null } | undefined;
  statement(db, "DELETE FROM round_trips WHERE instance_id=? AND position_ticket=?").run(instanceId, position);
  if (legs.length === 0) return;

  const ins = legs.filter((l) => l.entry === "IN");
  const outs = legs.filter((l) => CLOSING.has(l.entry ?? ""));
  const first = ins[0] ?? legs[0]!;
  const inSide = ins[0]?.side ?? (outs[0]?.side === "BUY" ? "SELL" : outs[0]?.side === "SELL" ? "BUY" : null);
  let gross = 0, commission = 0, swap = 0, fee = 0;
  for (const l of legs) { gross += l.profit ?? 0; commission += l.commission ?? 0; swap += l.swap ?? 0; fee += l.fee ?? 0; }
  // at the account currency's minor unit: the sums of venue amounts carry float noise past it
  const digits = instanceMoneyDigits(db, instanceId);
  const realized = roundMoney(gross + commission + swap + fee, digits);
  [gross, commission, swap, fee] = [gross, commission, swap, fee].map((v) => roundMoney(v, digits)) as [number, number, number, number];
  const inQty = ins.reduce((a, l) => a + (l.qty ?? 0), 0);
  const fullyClosed = statement(db,
    "SELECT 1 FROM position_closures WHERE instance_id=? AND position_ticket=? AND until_ts IS NULL",
  ).get(instanceId, position) != null;
  const open = ins.length > 0 && !fullyClosed;
  const last = outs[outs.length - 1];
  const entryTs = ins[0]?.ts ?? null;
  const exitTs = last?.ts ?? null;

  const entryOrderTicket = ins[0]?.orderTicket ?? null;
  const near: EventsNear = (type, ts) => eventsNear(db, instanceId, type, ts);
  const entry = entryOf(db, instanceId, position, entryOrderTicket, entryTs, near);
  const closeReason = open || last == null ? null : last.closeReason;

  const row: RoundTripRow = {
    instanceId,
    positionTicket: position,
    broker: first.broker,
    strategyId: ins.find((l) => l.strategyId != null)?.strategyId ?? legs.find((l) => l.strategyId != null)?.strategyId ?? null,
    instrument: instrument(first.symbol),
    symbol: first.symbol,
    side: inSide === "SELL" ? "short" : "long",
    entryTs,
    entryPrice: weighted(ins),
    exitTs,
    exitPrice: weighted(outs),
    qty: ins.length > 0 ? inQty : outs.reduce((a, l) => a + (l.qty ?? 0), 0),
    realized,
    gross, commission, swap, fee,
    legs: legs.length,
    entryOrderId: entry.orderId,
    entryOrderTicket,
    stopPrice: entry.stop ?? prior?.stopPrice ?? null,
    targetPrice: entry.target ?? prior?.targetPrice ?? null,
    ended: open || last == null ? null
      : endedByReason(closeReason) ?? endedFromDealComment(last.comment) ?? endedFromEngineEvents(near, position, last.ts, prior?.ended ?? null),
    holdMs: !open && entryTs != null && exitTs != null ? exitTs - entryTs : null,
    open,
    source: "deal",
    closeReason,
    riskAmount: entry.risk,
  };
  statement(db,
    `INSERT INTO round_trips (instance_id, position_ticket, broker, strategy_id, instrument, symbol, side, entry_ts, entry_price,
       exit_ts, exit_price, qty, realized, gross, commission, swap, fee, legs, entry_order_id, entry_order_ticket, stop_price,
       target_price, ended, hold_ms, open, source, close_reason, risk_amount)
     VALUES (@instanceId, @positionTicket, @broker, @strategyId, @instrument, @symbol, @side, @entryTs, @entryPrice,
       @exitTs, @exitPrice, @qty, @realized, @gross, @commission, @swap, @fee, @legs, @entryOrderId, @entryOrderTicket, @stopPrice,
       @targetPrice, @ended, @holdMs, @open, @source, @closeReason, @riskAmount)`,
  ).run({ ...row, open: row.open ? 1 : 0 });
}

/**
 * The entry of position `position`: its opening order, and that order's initial stop, target and
 * money at risk. A fill that names the position it opened (`positionId`, leg IN) states all of it;
 * an engine that names no position is read by the venue ticket convention, with the bracket of the
 * order's submit and no stated risk.
 */
function entryOf(db: Db, instanceId: string, position: string, ticket: string | null, entryTs: number | null, near: EventsNear):
  { orderId: string | null; stop: number | null; target: number | null; risk: number | null } {
  if (entryTs != null) {
    const fill = near("order.filled", entryTs).concat(near("order.partially_filled", entryTs)).find((p) =>
      typeof p.orderId === "string" && (
        (p.positionId === position && p.legEntry === "IN") || (p.nextPositionId === position && p.legEntry === "INOUT")));
    if (fill) return { orderId: fill.orderId as string, stop: num(fill.initialStop), target: num(fill.initialTarget), risk: num(fill.riskAmount) };
  }
  const { orderId, submit } = entryOrderByTicket(db, instanceId, ticket, entryTs, near);
  return { orderId, stop: submit ? level(submit.stopLoss) : null, target: submit ? level(submit.takeProfit) : null, risk: null };
}

/**
 * SQL: whether broker deals stand for engine close `c` (a trade_closes row): its strategy has a deal,
 * or the broker its symbol trades on ("EXNESS:BTCUSD" -> EXNESS) has one. Its round trips are then
 * that venue's positions, and the close is not one. Chosen per close, not per instance: one engine
 * trading an MT5 account and a venue that sends no deals keeps the latter's closes.
 */
export const LEDGER_COVERED = (c: string) => `(EXISTS (SELECT 1 FROM deals d INDEXED BY idx_deals_strategy
    WHERE d.instance_id=${c}.instance_id AND d.strategy_id=${c}.strategy_id)
  OR EXISTS (SELECT 1 FROM deals d INDEXED BY idx_deals_broker
    WHERE d.instance_id=${c}.instance_id AND d.broker=upper(substr(${c}.symbol, 1, instr(${c}.symbol, ':') - 1))))`;

/**
 * Rewrites the round trip of one engine close (trade_closes id) that no broker deal stands for
 * (LEDGER_COVERED), such as a paper engine's: the close is the whole story there is. `side` on the
 * close is the closing fill's, so the position ran the other way. No entry price, stop or cost split
 * is known; realized is the engine's net after its costs.
 */
export function recomputeLedgerTrip(db: Db, instanceId: string, closeId: string): void {
  statement(db, "DELETE FROM round_trips WHERE instance_id=? AND position_ticket=? AND source='ledger'").run(instanceId, closeId);
  const c = statement(db,
    `SELECT strategy_id strategyId, symbol, side, qty, price, realized, entry_ts entryTs, ts, close_reason closeReason
     FROM trade_closes c WHERE instance_id=? AND id=? AND NOT ${LEDGER_COVERED("c")}`,
  ).get(instanceId, closeId) as { strategyId: string | null; symbol: string; side: string; qty: number; price: number; realized: number;
    entryTs: number | null; ts: number; closeReason: string | null } | undefined;
  if (!c) return;
  const realized = roundMoney(c.realized, instanceMoneyDigits(db, instanceId));
  statement(db,
    `INSERT INTO round_trips (instance_id, position_ticket, broker, strategy_id, instrument, symbol, side, entry_ts, entry_price,
       exit_ts, exit_price, qty, realized, gross, commission, swap, fee, legs, entry_order_id, entry_order_ticket, stop_price,
       target_price, ended, hold_ms, open, source, close_reason)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, 0, 0, 1, NULL, NULL, NULL, NULL, ?, ?, 0, 'ledger', ?)`,
  ).run(instanceId, closeId, c.strategyId, instrument(c.symbol), c.symbol, c.side === "BUY" ? "short" : "long", c.entryTs,
    c.ts, c.price, c.qty, realized, realized, endedByReason(c.closeReason), c.entryTs != null ? c.ts - c.entryTs : null, c.closeReason);
}

/** A strategy's (or the instance's) round trips, newest exit first: the stored rows as they are. */
export function storedRoundTrips(db: Db, f: { instanceId: string; strategyId?: string }): RoundTripRow[] {
  refreshProjections(db);
  const rows = statement(db,
    `SELECT instance_id instanceId, position_ticket positionTicket, broker, strategy_id strategyId, instrument, symbol, side,
       entry_ts entryTs, entry_price entryPrice, exit_ts exitTs, exit_price exitPrice, qty, realized, gross, commission, swap, fee,
       legs, entry_order_id entryOrderId, entry_order_ticket entryOrderTicket, stop_price stopPrice, target_price targetPrice,
       ended, hold_ms holdMs, open, source, close_reason closeReason, risk_amount riskAmount
     FROM round_trips WHERE instance_id=@instanceId ${f.strategyId != null ? "AND strategy_id=@strategyId" : ""}
     ORDER BY exit_ts DESC, position_ticket DESC`,
  ).all({ instanceId: f.instanceId, strategyId: f.strategyId }) as Array<Omit<RoundTripRow, "open"> & { open: number }>;
  return rows.map((r) => ({ ...r, open: r.open === 1 }));
}
