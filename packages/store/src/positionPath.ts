import type { Db } from "./db.js";
import { refreshProjections } from "./projections.js";
import { statement } from "./statements.js";

/*
 * The path one position took while it was held, for the trade drawer's chart: the venue's marks
 * (the price the position would close at and its P&L on each broker poll) grouped into candles on
 * the UTC grid, the P&L line, and the moments that matter: entry, the best and the worst mark,
 * and the exit or the latest mark. Everything is read from stored marks and the round trip; a
 * candle only spans marks that exist, so a stretch with none stays empty.
 */

const MIN = 60_000;
/** Candle sizes the chart offers, on the UTC grid. */
export const PATH_BUCKETS = [MIN, 5 * MIN, 15 * MIN, 30 * MIN, 60 * MIN, 240 * MIN, 1440 * MIN] as const;
/** The automatic size is the smallest that keeps the chart at or under this many candles. */
const AUTO_CANDLES = 160;
/** A size is offered while it draws at most this many candles. */
const MAX_CANDLES = 1500;
/** Gaps between marks at least this long are reported: the broker poll heartbeats every 5 minutes. */
export const PATH_GAP_MS = 15 * MIN;
/** At most this many gaps are listed (the count and the longest cover the rest). */
const MAX_GAP_SPANS = 500;
/** Marks at one unchanged price for at least this long are a flat stretch: a closed market or no quotes. */
export const PATH_FLAT_MS = 60 * MIN;

export interface PathCandle {
  /** Bucket start, epoch ms UTC. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Marks inside the bucket. */
  marks: number;
}

export interface PathMark {
  ts: number;
  /** The venue's mark: the price the position would close at. */
  price: number | null;
  /** The position's P&L at the mark, excluding swap, in account money. */
  pnl: number;
}

export interface PositionPath {
  ticket: string;
  status: "open" | "closed";
  side: "long" | "short";
  entry: { ts: number; price: number | null } | null;
  exit: { ts: number; price: number | null } | null;
  /** The initial stop and target: the entry order's, else the first the venue held on the position. */
  stopPrice: number | null;
  targetPrice: number | null;
  /** Where the initial levels come from: the entry order, or the venue's position (an order never linked to the trade). */
  levelSource: "order" | "venue" | null;
  /** Each change of the venue's stop and target while the position was held, in time order (null is none). */
  levelSteps: Array<{ ts: number; stop: number | null; target: number | null }>;
  /** How the entry order's stop behaves, as qkt submitted it; null when no order is linked or it stated none. */
  stopStyle: StopStyle | null;
  /** Closes of part of the position before its final exit, from the venue's deals. */
  partials: Array<{ ts: number; price: number; qty: number }>;
  /** Account money per one price unit of the whole position (P&L = move × this), from the marks; null without a move. */
  moneyPerPoint: number | null;
  /** Money at risk to the initial stop as the engine stated it at entry; null when not stated. */
  riskAmount: number | null;
  bucketMs: number;
  /** Sizes that draw between 2 and MAX_CANDLES candles over the held window. */
  buckets: number[];
  candles: PathCandle[];
  /** The P&L line: per bucket the first, lowest, highest and last mark, and both edges of every gap, in time order. */
  pnl: Array<{ ts: number; pnl: number }>;
  /** The highest P&L mark (first if repeated); null without marks. */
  best: PathMark | null;
  /** The lowest P&L mark (first if repeated); null without marks. */
  worst: PathMark | null;
  /** The newest mark, with the swap it carried. */
  last: (PathMark & { swap: number | null }) | null;
  marks: number;
  firstMarkTs: number | null;
  /** The longest stretch without a mark, when at least PATH_GAP_MS. */
  longestGap: { from: number; to: number } | null;
  /** Stretches without a mark of at least PATH_GAP_MS, in time order (the first MAX_GAP_SPANS). */
  gapSpans: Array<{ from: number; to: number }>;
  /** Stretches of at least PATH_FLAT_MS over which every mark carried the same price, in time order (capped likewise). */
  flatSpans: Array<{ from: number; to: number }>;
  gaps: number;
}

/** The entry order's stop as qkt submitted it: fixed, or one that moves (trailing, stepped, tightening on a clock). */
export interface StopStyle {
  kind: "fixed" | "trailing" | "stepped" | "tightening";
  /** Price distance a trailing stop keeps behind the best price. */
  trailDistance?: number | null;
  /** Profit (price distance) the trade must reach before a trailing or stepped stop starts to move. */
  armAt?: number | null;
  /** How often a tightening stop moves, ms. */
  intervalMs?: number | null;
  /** How many profit steps a stepped stop has. */
  steps?: number | null;
}

const STOP_KIND: Record<string, StopStyle["kind"]> = { Fixed: "fixed", ArmedTrail: "trailing", SteppedStop: "stepped", TimeTighten: "tightening" };

const finiteNum = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};

/** The stop style a submit payload states under `stopLoss` (qkt OrderRequestEvidence); null for a bare price or none. */
export function stopStyleOf(payload: Record<string, unknown> | null | undefined): StopStyle | null {
  const sl = payload?.stopLoss;
  if (sl == null || typeof sl !== "object") return null;
  const o = sl as Record<string, unknown>;
  const kind = STOP_KIND[String(o.type)];
  if (!kind) return null;
  const out: StopStyle = { kind };
  if (kind === "trailing") { out.trailDistance = finiteNum(o.trailDistance); out.armAt = finiteNum(o.mfeThreshold); }
  if (kind === "stepped") {
    const steps = Array.isArray(o.steps) ? (o.steps as Array<Record<string, unknown>>) : [];
    out.steps = steps.length;
    out.armAt = steps.length > 0 ? finiteNum(steps[0]!.mfeThreshold) : null;
  }
  if (kind === "tightening") out.intervalMs = finiteNum(o.intervalMs);
  return out;
}

/** The submit of order `orderId` near the entry: where the stop's style is stated. */
function entrySubmit(db: Db, instanceId: string, orderId: string | null, entryTs: number | null): Record<string, unknown> | null {
  if (orderId == null || entryTs == null) return null;
  const rows = statement(db, `SELECT payload FROM events WHERE instance_id=? AND type='order.submit' AND ts BETWEEN ? AND ?
      AND json_extract(payload,'$.orderId')=? ORDER BY ts LIMIT 1`).all(instanceId, entryTs - 10 * MIN, entryTs + 2 * MIN, orderId) as Array<{ payload: string }>;
  try { return rows[0] ? (JSON.parse(rows[0].payload) as Record<string, unknown>) : null; } catch { return null; }
}

/**
 * Money per price unit of the whole position, read from the marks: the mark furthest from the entry (largest move,
 * least rounding) divided into its P&L. Null when no mark moved off the entry.
 */
export function moneyPerPointOf(side: "long" | "short", entryPrice: number | null, marks: ReadonlyArray<{ price: number | null; pnl: number | null }>): number | null {
  if (entryPrice == null) return null;
  const dir = side === "long" ? 1 : -1;
  let best: { move: number; pnl: number } | null = null;
  for (const m of marks) {
    if (m.price == null || m.pnl == null || !Number.isFinite(m.price) || !Number.isFinite(m.pnl)) continue;
    const move = (m.price - entryPrice) * dir;
    if (move !== 0 && (!best || Math.abs(move) > Math.abs(best.move))) best = { move, pnl: m.pnl };
  }
  if (!best) return null;
  const v = best.pnl / best.move;
  return Number.isFinite(v) && v > 0 ? v : null;
}

interface MarkRow { ts: number; price: number | null; pnl: number | null; swap: number | null }

/** The automatic candle size for a held window of `spanMs`, and the sizes offered. */
export function pathBuckets(spanMs: number): { auto: number; offered: number[] } {
  const span = Math.max(spanMs, 0);
  const offered = PATH_BUCKETS.filter((b, i) => span / b <= MAX_CANDLES && (span / b >= 2 || i === 0));
  const auto = PATH_BUCKETS.find((b) => span / b <= AUTO_CANDLES) ?? PATH_BUCKETS[PATH_BUCKETS.length - 1]!;
  return { auto, offered: offered.length > 0 ? offered : [auto] };
}

/** One position's path, or null when the instance holds no round trip with that ticket. */
export function positionPath(db: Db, instanceId: string, ticket: string, bucketMs?: number, now = Date.now()): PositionPath | null {
  refreshProjections(db);
  const trip = statement(db, `SELECT side, open, entry_ts entryTs, entry_price entryPrice, exit_ts exitTs, exit_price exitPrice,
      stop_price stopPrice, target_price targetPrice, entry_order_id entryOrderId, risk_amount riskAmount
    FROM round_trips WHERE instance_id=? AND position_ticket=?`).get(instanceId, ticket) as {
    side: "long" | "short"; open: number; entryTs: number | null; entryPrice: number | null; exitTs: number | null; exitPrice: number | null;
    stopPrice: number | null; targetPrice: number | null; entryOrderId: string | null; riskAmount: number | null;
  } | undefined;
  if (!trip) return null;
  const open = trip.open === 1;
  const from = trip.entryTs;
  const to = open ? now : trip.exitTs ?? now;
  const rows = from == null ? [] : statement(db, `SELECT ts, current_price price, profit pnl, swap FROM position_valuations
      WHERE instance_id=? AND ticket=? AND ts>=? AND ts<=? ORDER BY ts`).all(instanceId, ticket, from, to) as MarkRow[];

  const end = open ? (rows.at(-1)?.ts ?? from ?? now) : (trip.exitTs ?? rows.at(-1)?.ts ?? now);
  const { auto, offered } = pathBuckets(from == null ? 0 : end - from);
  const bucket = bucketMs != null && offered.includes(bucketMs) ? bucketMs : auto;

  const candles: PathCandle[] = [];
  const pnl: Array<{ ts: number; pnl: number }> = [];
  let best: PathMark | null = null;
  let worst: PathMark | null = null;
  let longestGap: { from: number; to: number } | null = null;
  let gaps = 0;
  const gapSpans: Array<{ from: number; to: number }> = [];
  const flatSpans: Array<{ from: number; to: number }> = [];
  // the run of marks at one price: from its first mark to its latest
  let flat: { price: number; from: number; to: number } | null = null;
  const closeFlat = () => {
    if (flat && flat.to - flat.from >= PATH_FLAT_MS && flatSpans.length < MAX_GAP_SPANS) flatSpans.push({ from: flat.from, to: flat.to });
    flat = null;
  };
  // the P&L marks of the bucket being read, reduced to first/lowest/highest/last
  let group: Array<{ ts: number; pnl: number; edge: boolean }> = [];
  let groupStart = Number.NaN;
  const flush = () => {
    if (group.length === 0) return;
    let lo = group[0]!, hi = group[0]!;
    for (const m of group) {
      if (m.pnl < lo.pnl) lo = m;
      if (m.pnl > hi.pnl) hi = m;
    }
    const keep = new Set([group[0]!, lo, hi, group.at(-1)!]);
    for (const m of group) if (keep.has(m) || m.edge) pnl.push({ ts: m.ts, pnl: m.pnl });
    group = [];
  };

  let prevTs: number | null = null;
  for (const r of rows) {
    const gap = prevTs != null && r.ts - prevTs >= PATH_GAP_MS;
    // the mark before a gap is the last P&L mark read; it closes the line at the gap's edge
    if (gap && group.length > 0) group.at(-1)!.edge = true;
    if (prevTs != null && gap) {
      gaps++;
      if (gapSpans.length < MAX_GAP_SPANS) gapSpans.push({ from: prevTs, to: r.ts });
      if (!longestGap || r.ts - prevTs > longestGap.to - longestGap.from) longestGap = { from: prevTs, to: r.ts };
    }
    prevTs = r.ts;
    if (gap) closeFlat();
    if (r.price != null && Number.isFinite(r.price)) {
      if (flat && flat.price === r.price) flat.to = r.ts;
      else {
        closeFlat();
        flat = { price: r.price, from: r.ts, to: r.ts };
      }
    }
    const start = Math.floor(r.ts / bucket) * bucket;
    if (r.price != null && Number.isFinite(r.price)) {
      const c = candles.at(-1);
      if (c && c.t === start) {
        c.h = Math.max(c.h, r.price);
        c.l = Math.min(c.l, r.price);
        c.c = r.price;
        c.marks++;
      } else {
        candles.push({ t: start, o: r.price, h: r.price, l: r.price, c: r.price, marks: 1 });
      }
    }
    if (r.pnl != null && Number.isFinite(r.pnl)) {
      if (start !== groupStart) {
        flush();
        groupStart = start;
      }
      group.push({ ts: r.ts, pnl: r.pnl, edge: gap });
      if (!best || r.pnl > best.pnl) best = { ts: r.ts, price: r.price, pnl: r.pnl };
      if (!worst || r.pnl < worst.pnl) worst = { ts: r.ts, price: r.price, pnl: r.pnl };
    }
  }
  flush();
  closeFlat();

  const lastRow = [...rows].reverse().find((r) => r.pnl != null && Number.isFinite(r.pnl));

  // the venue's stop/target as it changed; the initial levels fall back to the first the venue held
  const levelSteps = statement(db, "SELECT ts, stop, target FROM position_levels WHERE instance_id=? AND ticket=? AND ts<=? ORDER BY ts")
    .all(instanceId, ticket, to) as Array<{ ts: number; stop: number | null; target: number | null }>;
  const pos = (v: number | null) => (v != null && Number.isFinite(v) && v > 0 ? v : null);
  const orderStop = pos(trip.stopPrice), orderTarget = pos(trip.targetPrice);
  const venueStop = levelSteps.find((l) => l.stop != null)?.stop ?? null;
  const venueTarget = levelSteps.find((l) => l.target != null)?.target ?? null;
  const fromOrder = orderStop != null || orderTarget != null;
  const fromVenue = !fromOrder && (venueStop != null || venueTarget != null);
  // partial closes: OUT deals before the final exit (each deal once: a venue can report one deal more than once)
  const partials = (statement(db, `SELECT MIN(ts) ts, price, qty FROM deals WHERE instance_id=? AND position_ticket=? AND entry='OUT' AND ts<?
      GROUP BY deal_ticket ORDER BY ts`).all(instanceId, ticket, open ? Number.MAX_SAFE_INTEGER : (trip.exitTs ?? Number.MAX_SAFE_INTEGER)) as Array<{ ts: number; price: number | null; qty: number | null }>)
    .filter((d): d is { ts: number; price: number; qty: number } => d.price != null && d.qty != null);
  return {
    ticket,
    status: open ? "open" : "closed",
    side: trip.side,
    entry: from == null ? null : { ts: from, price: trip.entryPrice },
    exit: open || trip.exitTs == null ? null : { ts: trip.exitTs, price: trip.exitPrice },
    stopPrice: fromOrder ? orderStop : fromVenue ? venueStop : null,
    targetPrice: fromOrder ? orderTarget : fromVenue ? venueTarget : null,
    levelSource: fromOrder ? "order" : fromVenue ? "venue" : null,
    levelSteps,
    stopStyle: stopStyleOf(entrySubmit(db, instanceId, trip.entryOrderId, from)),
    partials,
    moneyPerPoint: moneyPerPointOf(trip.side, trip.entryPrice, rows),
    riskAmount: trip.riskAmount,
    bucketMs: bucket,
    buckets: offered,
    candles,
    pnl,
    best,
    worst,
    last: lastRow ? { ts: lastRow.ts, price: lastRow.price, pnl: lastRow.pnl!, swap: lastRow.swap } : null,
    marks: rows.length,
    firstMarkTs: rows[0]?.ts ?? null,
    longestGap,
    gapSpans,
    flatSpans,
    gaps,
  };
}
