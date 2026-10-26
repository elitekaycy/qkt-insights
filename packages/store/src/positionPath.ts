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
  stopPrice: number | null;
  targetPrice: number | null;
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
      stop_price stopPrice, target_price targetPrice
    FROM round_trips WHERE instance_id=? AND position_ticket=?`).get(instanceId, ticket) as {
    side: "long" | "short"; open: number; entryTs: number | null; entryPrice: number | null; exitTs: number | null; exitPrice: number | null;
    stopPrice: number | null; targetPrice: number | null;
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
  return {
    ticket,
    status: open ? "open" : "closed",
    side: trip.side,
    entry: from == null ? null : { ts: from, price: trip.entryPrice },
    exit: open || trip.exitTs == null ? null : { ts: trip.exitTs, price: trip.exitPrice },
    stopPrice: trip.stopPrice,
    targetPrice: trip.targetPrice,
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
