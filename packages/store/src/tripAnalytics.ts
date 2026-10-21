import type { Db } from "./db.js";
import { winRatePct } from "./analytics.js";
import { roundTripPages, roundTripTotals, type RoundTripQuery, type TripEnded, type TripRow } from "./tripQueries.js";

/*
 * The journal's aggregates over round trips: one call answers every card, chart and table of a
 * strategy's sections for the scope and query on screen, so they all describe the same trades.
 * The unit is the closed round trip (entry to exit, P&L after costs). Days and months are UTC
 * exit days; weekday and hour are the UTC entry. Every bucket carries the query token that
 * selects its trades, so a click narrows the page to exactly the trades behind the figure.
 */

const DAY = 86_400_000;
const H = 3_600_000;

/** Per-trade points kept for the cumulative curve and the P&L-per-trade bars (newest kept). */
export const TRIP_SERIES_MAX = 3000;
/** Runs of losses the after-N-losses table follows. */
const POST_LOSS_MAX = 5;

export interface TripBucket {
  key: string;
  label: string;
  /** The query token that selects this bucket's trades, e.g. `held:1h..4h`. */
  filter: string;
  n: number;
  wins: number;
  losses: number;
  pnl: number;
}

export interface TripDay { day: string; n: number; wins: number; losses: number; pnl: number }
export interface TripMonth extends TripDay { grossWin: number; grossLoss: number }

export interface TripPoint {
  /** The venue position ticket (opaque on shared links). */
  id: string;
  exitTs: number;
  pnl: number;
  /** Running total of the matched closed trades up to and including this one. */
  cum: number;
}

export interface TripAnalytics {
  /** Round trips in the scope before the query, and the ones it matched. */
  total: number;
  matched: number;
  closed: number;
  open: number;
  /** Realized P&L of the matched round trips; a partly closed open one counts what it closed. */
  pnl: number;
  /** Closed round trips only from here on. */
  grossWin: number;
  /** Sum of losing trades, negative. */
  grossLoss: number;
  wins: number;
  losses: number;
  breakeven: number;
  /** Winning over decided closed round trips, percent; null without one. */
  winRate: number | null;
  profitFactor: number | "inf" | null;
  avgWin: number | null;
  /** Mean losing trade, negative. */
  avgLoss: number | null;
  payoff: number | null;
  /** Mean P&L per closed round trip. */
  expectancy: number | null;
  /** R multiples of the closed trades that had a stop on the entry. */
  r: { n: number; avg: number | null; total: number | null };
  best: { id: string; pnl: number } | null;
  worst: { id: string; pnl: number } | null;
  avgHoldMs: number | null;
  /** Deepest fall of the running realized total from its peak (starting at 0), as money (positive). */
  maxDd: number;
  /** Exit times of the trade at the peak before the deepest fall and of the trough; null without a fall. */
  maxDdWindow: { from: number; to: number } | null;
  streaks: { current: number; maxWin: number; maxLoss: number };
  postLoss: Array<{ n: number; sample: number; nextWinRate: number; nextAvg: number }>;
  /** Closed trades by exit time, oldest first; at most TRIP_SERIES_MAX, the newest kept. */
  trades: TripPoint[];
  tradesTruncated: boolean;
  daily: TripDay[];
  monthly: TripMonth[];
  side: TripBucket[];
  ended: TripBucket[];
  hold: TripBucket[];
  /** By instrument (broker-profile prefixes folded), largest share of trades first. */
  instrument: TripBucket[];
  weekday: TripBucket[];
  hour: TripBucket[];
}

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const WEEKDAY_LABEL = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Hold buckets, [min, max) in ms, with the query token that selects each. */
export const HOLD_BUCKETS: ReadonlyArray<{ key: string; label: string; filter: string; min: number; max: number }> = [
  { key: "<1h", label: "< 1h", filter: "held:<1h", min: 0, max: H },
  { key: "1-4h", label: "1–4h", filter: "held:1h..4h", min: H, max: 4 * H },
  { key: "4-24h", label: "4–24h", filter: "held:4h..24h", min: 4 * H, max: 24 * H },
  { key: "1-3d", label: "1–3d", filter: "held:1d..3d", min: DAY, max: 3 * DAY },
  { key: ">3d", label: "> 3d", filter: "held:>=3d", min: 3 * DAY, max: Infinity },
];

const ENDED_ORDER: ReadonlyArray<[TripEnded, string]> = [
  ["tp", "Target"], ["stop", "Stop"], ["signal", "Signal exit"], ["venue", "Venue close"], ["manual", "By hand"],
];

const bucket = (key: string, label: string, filter: string): TripBucket => ({ key, label, filter, n: 0, wins: 0, losses: 0, pnl: 0 });
const add = (b: { n: number; wins: number; losses: number; pnl: number }, pnl: number) => {
  b.n++;
  b.pnl += pnl;
  if (pnl > 0) b.wins++;
  else if (pnl < 0) b.losses++;
};
const utcDay = (ts: number) => new Date(ts).toISOString().slice(0, 10);

type Closed = TripRow & { pnl: number; exitTs: number };

/**
 * Aggregates over the matched round trips. `rows` is every matched round trip in any order;
 * `counts` are the scope's totals (before and after the query), computed by the caller.
 */
export function analyzeTrips(rows: readonly TripRow[], counts: { total: number; matched: number }): TripAnalytics {
  const closed = rows
    .filter((r): r is Closed => r.status === "closed" && r.pnl != null && r.exitTs != null)
    .sort((a, b) => a.exitTs - b.exitTs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const pnl = rows.reduce((a, r) => a + (r.pnl ?? 0), 0);
  let grossWin = 0, grossLoss = 0, wins = 0, losses = 0, breakeven = 0;
  let rN = 0, rSum = 0, holdN = 0, holdSum = 0;
  let cum = 0, peak = 0, maxDd = 0;
  let peakTs: number | null = null;
  let maxDdWindow: TripAnalytics["maxDdWindow"] = null;
  let runW = 0, runL = 0, maxWin = 0, maxLoss = 0;
  let best: Closed | null = null, worst: Closed | null = null;
  const points: TripPoint[] = [];
  const days = new Map<string, TripDay>();
  const months = new Map<string, TripMonth>();
  const side = { long: bucket("long", "Long", "side:long"), short: bucket("short", "Short", "side:short") };
  const ended = new Map(ENDED_ORDER.map(([k, label]) => [k, bucket(k, label, `ended:${k}`)]));
  const hold = HOLD_BUCKETS.map((b) => bucket(b.key, b.label, b.filter));
  const instrument = new Map<string, TripBucket>();
  const weekday = WEEKDAYS.map((d, i) => bucket(d, WEEKDAY_LABEL[i]!, `weekday:${d}`));
  const hour = Array.from({ length: 24 }, (_, h) => bucket(String(h).padStart(2, "0"), String(h).padStart(2, "0"), `hour:${h}`));

  for (const t of closed) {
    const p = t.pnl;
    if (p > 0) { wins++; grossWin += p; runW++; runL = 0; }
    else if (p < 0) { losses++; grossLoss += p; runL++; runW = 0; }
    else breakeven++;
    maxWin = Math.max(maxWin, runW);
    maxLoss = Math.max(maxLoss, runL);
    if (t.r != null) { rN++; rSum += t.r; }
    if (t.holdMs != null) { holdN++; holdSum += t.holdMs; }
    if (!best || p > best.pnl) best = t;
    if (!worst || p < worst.pnl) worst = t;
    cum += p;
    if (cum > peak) { peak = cum; peakTs = t.exitTs; }
    if (peak - cum > maxDd) {
      maxDd = peak - cum;
      maxDdWindow = { from: peakTs ?? closed[0]!.exitTs, to: t.exitTs };
    }
    points.push({ id: t.id, exitTs: t.exitTs, pnl: p, cum });

    const day = utcDay(t.exitTs);
    const d = days.get(day) ?? { day, n: 0, wins: 0, losses: 0, pnl: 0 };
    add(d, p);
    days.set(day, d);
    const month = day.slice(0, 7);
    const m = months.get(month) ?? { day: month, n: 0, wins: 0, losses: 0, pnl: 0, grossWin: 0, grossLoss: 0 };
    add(m, p);
    if (p > 0) m.grossWin += p;
    else m.grossLoss += p;
    months.set(month, m);

    add(side[t.side], p);
    const inst = instrument.get(t.instrument) ?? bucket(t.instrument, t.instrument, `symbol:${t.instrument}`);
    add(inst, p);
    instrument.set(t.instrument, inst);
    if (t.ended) add(ended.get(t.ended)!, p);
    if (t.holdMs != null) add(hold.find((_, i) => t.holdMs! >= HOLD_BUCKETS[i]!.min && t.holdMs! < HOLD_BUCKETS[i]!.max) ?? hold[0]!, p);
    if (t.entryTs != null) {
      const e = new Date(t.entryTs);
      add(weekday[(e.getUTCDay() + 6) % 7]!, p);
      add(hour[e.getUTCHours()]!, p);
    }
  }

  // the current streak: consecutive wins (positive) or losses (negative) ending at the latest decided trade
  let current = 0;
  for (let i = closed.length - 1; i >= 0; i--) {
    const s = Math.sign(closed[i]!.pnl);
    if (s === 0) continue;
    if (current === 0) current = s;
    else if (Math.sign(current) === s) current += s;
    else break;
  }

  const n = closed.length;
  const decided = wins + losses;
  return {
    total: counts.total,
    matched: counts.matched,
    closed: n,
    open: rows.filter((r) => r.status === "open").length,
    pnl,
    grossWin,
    grossLoss,
    wins,
    losses,
    breakeven,
    winRate: winRatePct(wins, losses),
    profitFactor: decided === 0 ? null : grossLoss === 0 ? (grossWin > 0 ? "inf" : null) : grossWin / -grossLoss,
    avgWin: wins > 0 ? grossWin / wins : null,
    avgLoss: losses > 0 ? grossLoss / losses : null,
    payoff: wins > 0 && losses > 0 ? grossWin / wins / (-grossLoss / losses) : null,
    expectancy: n > 0 ? (grossWin + grossLoss) / n : null,
    r: { n: rN, avg: rN > 0 ? rSum / rN : null, total: rN > 0 ? rSum : null },
    best: best ? { id: best.id, pnl: best.pnl } : null,
    worst: worst ? { id: worst.id, pnl: worst.pnl } : null,
    avgHoldMs: holdN > 0 ? holdSum / holdN : null,
    maxDd,
    maxDdWindow,
    streaks: { current, maxWin, maxLoss },
    postLoss: postLoss(closed.map((t) => t.pnl)),
    trades: points.slice(-TRIP_SERIES_MAX),
    tradesTruncated: points.length > TRIP_SERIES_MAX,
    daily: [...days.values()],
    monthly: [...months.values()],
    side: [side.long, side.short],
    ended: [...ended.values()].filter((b) => b.n > 0),
    hold,
    instrument: [...instrument.values()].sort((a, b) => b.n - a.n || (a.key < b.key ? -1 : 1)),
    weekday,
    hour,
  };
}

/** After N losses in a row (1..5), how the next trade went: the same reading as the performance report. */
export function postLoss(pnls: readonly number[]): TripAnalytics["postLoss"] {
  const next = new Map<number, number[]>();
  let run = 0;
  for (let i = 0; i < pnls.length - 1; i++) {
    run = pnls[i]! < 0 ? run + 1 : 0;
    for (let k = 1; k <= Math.min(run, POST_LOSS_MAX); k++) next.set(k, [...(next.get(k) ?? []), pnls[i + 1]!]);
  }
  return [...next.entries()].sort((a, b) => a[0] - b[0]).map(([k, xs]) => ({
    n: k,
    sample: xs.length,
    nextWinRate: (xs.filter((x) => x > 0).length / xs.length) * 100,
    nextAvg: xs.reduce((a, b) => a + b, 0) / xs.length,
  }));
}

/** The journal aggregates of every round trip the query matches. */
export function roundTripAnalytics(db: Db, q: RoundTripQuery): TripAnalytics {
  const rows: TripRow[] = [];
  for (const page of roundTripPages(db, { ...q, sort: "exit", dir: "asc", cursor: null }, 1000)) rows.push(...page);
  const totals = roundTripTotals(db, q);
  return analyzeTrips(rows, { total: totals.total, matched: totals.matched });
}
