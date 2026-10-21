import type { Db } from "./db.js";
import { statement } from "./statements.js";
import { refreshProjections } from "./projections.js";

/** Window around a leg in which the engine events that explain it are looked for. */
const BEFORE_MS = 10 * 60_000;
const AFTER_MS = 2 * 60_000;

const CLOSING = new Set(["OUT", "INOUT", "OUT_BY"]);

interface Leg {
  broker: string; symbol: string | null; side: string | null; entry: string | null; qty: number | null; price: number | null;
  profit: number | null; commission: number | null; swap: number | null; fee: number | null; comment: string | null;
  strategyId: string | null; orderTicket: string | null; ts: number;
}

export interface RoundTripRow {
  instanceId: string; positionTicket: string; broker: string | null; strategyId: string | null; instrument: string; symbol: string | null;
  side: "long" | "short"; entryTs: number | null; entryPrice: number | null; exitTs: number | null; exitPrice: number | null; qty: number | null;
  realized: number; gross: number; commission: number; swap: number; fee: number; legs: number;
  entryOrderId: string | null; entryOrderTicket: string | null; stopPrice: number | null; targetPrice: number | null;
  ended: "stop" | "tp" | "so" | "manual" | "signal" | null; holdMs: number | null; open: boolean;
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
    `SELECT broker, symbol, side, entry, qty, price, profit, commission, swap, fee, comment, strategy_id strategyId, order_ticket orderTicket, ts
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
  const inQty = ins.reduce((a, l) => a + (l.qty ?? 0), 0);
  const fullyClosed = statement(db,
    "SELECT 1 FROM position_closures WHERE instance_id=? AND position_ticket=? AND until_ts IS NULL",
  ).get(instanceId, position) != null;
  const open = ins.length > 0 && !fullyClosed;
  const last = outs[outs.length - 1];
  const entryTs = ins[0]?.ts ?? null;
  const exitTs = last?.ts ?? null;

  const entryOrderTicket = ins[0]?.orderTicket ?? null;
  const { orderId: entryOrderId, submit } = openingOrder(db, instanceId, entryOrderTicket, entryTs);

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
    realized: gross + commission + swap + fee,
    gross, commission, swap, fee,
    legs: legs.length,
    entryOrderId,
    entryOrderTicket,
    stopPrice: (submit ? level(submit.stopLoss) : null) ?? prior?.stopPrice ?? null,
    targetPrice: (submit ? level(submit.takeProfit) : null) ?? prior?.targetPrice ?? null,
    ended: open || last == null ? null : endedBy(db, instanceId, position, last, prior?.ended ?? null),
    holdMs: !open && entryTs != null && exitTs != null ? exitTs - entryTs : null,
    open,
  };
  statement(db,
    `INSERT INTO round_trips (instance_id, position_ticket, broker, strategy_id, instrument, symbol, side, entry_ts, entry_price,
       exit_ts, exit_price, qty, realized, gross, commission, swap, fee, legs, entry_order_id, entry_order_ticket, stop_price,
       target_price, ended, hold_ms, open)
     VALUES (@instanceId, @positionTicket, @broker, @strategyId, @instrument, @symbol, @side, @entryTs, @entryPrice,
       @exitTs, @exitPrice, @qty, @realized, @gross, @commission, @swap, @fee, @legs, @entryOrderId, @entryOrderTicket, @stopPrice,
       @targetPrice, @ended, @holdMs, @open)`,
  ).run({ ...row, open: row.open ? 1 : 0 });
}

/**
 * The engine order that opened the position and its submit. The orders table maps the venue ticket
 * to the order id; when it does not (the accept never reached that row, or the id belongs to
 * another run), the `order.accepted` near the entry that carries the ticket names the order. An
 * order id repeats across engine restarts, so only the submit near the entry is its own.
 */
function openingOrder(db: Db, instanceId: string, ticket: string | null, entryTs: number | null): { orderId: string | null; submit: Record<string, unknown> | undefined } {
  if (ticket == null) return { orderId: null, submit: undefined };
  const stored = (statement(db,
    "SELECT order_id o FROM orders WHERE instance_id=? AND broker_order_id=? ORDER BY created_ts ASC LIMIT 1",
  ).get(instanceId, ticket) as { o: string } | undefined)?.o ?? null;
  if (entryTs == null) return { orderId: stored, submit: undefined };
  const submits = eventsNear(db, instanceId, "order.submit", entryTs);
  const submitOf = (id: string | null) => (id == null ? undefined : submits.find((p) => p.orderId === id));
  const own = submitOf(stored);
  if (own) return { orderId: stored, submit: own };
  const accepted = eventsNear(db, instanceId, "order.accepted", entryTs)
    .find((p) => p.brokerOrderId != null && String(p.brokerOrderId) === ticket && typeof p.orderId === "string");
  const acceptedId = (accepted?.orderId as string | undefined) ?? null;
  const viaAccept = submitOf(acceptedId);
  return viaAccept ? { orderId: acceptedId, submit: viaAccept } : { orderId: stored ?? acceptedId, submit: undefined };
}

/**
 * How the position ended. The venue's comment on the closing deal is the truth for its stops,
 * targets and stop-outs; otherwise the engine's events near the close say who closed it: a
 * `qkt bot close` of the ticket is a person, an engine order closing the ticket is the strategy.
 * Nothing found: what an earlier read of those events said (they age out), else null.
 */
function endedBy(db: Db, instanceId: string, position: string, last: Leg, prior: string | null): RoundTripRow["ended"] {
  const c = (last.comment ?? "").toLowerCase();
  if (c.startsWith("[sl")) return "stop";
  if (c.startsWith("[tp")) return "tp";
  if (c.startsWith("[so")) return "so";
  if (eventsNear(db, instanceId, "bot.close", last.ts).some((p) => p.ticket === position)) return "manual";
  if (eventsNear(db, instanceId, "order.submit", last.ts).some((p) => p.closesTicket === position)) return "signal";
  return prior === "manual" || prior === "signal" ? prior : null;
}

/** A strategy's (or the instance's) round trips, newest exit first: the stored rows as they are. */
export function storedRoundTrips(db: Db, f: { instanceId: string; strategyId?: string }): RoundTripRow[] {
  refreshProjections(db);
  const rows = statement(db,
    `SELECT instance_id instanceId, position_ticket positionTicket, broker, strategy_id strategyId, instrument, symbol, side,
       entry_ts entryTs, entry_price entryPrice, exit_ts exitTs, exit_price exitPrice, qty, realized, gross, commission, swap, fee,
       legs, entry_order_id entryOrderId, entry_order_ticket entryOrderTicket, stop_price stopPrice, target_price targetPrice,
       ended, hold_ms holdMs, open
     FROM round_trips WHERE instance_id=@instanceId ${f.strategyId != null ? "AND strategy_id=@strategyId" : ""}
     ORDER BY exit_ts DESC, position_ticket DESC`,
  ).all({ instanceId: f.instanceId, strategyId: f.strategyId }) as Array<Omit<RoundTripRow, "open"> & { open: number }>;
  return rows.map((r) => ({ ...r, open: r.open === 1 }));
}
