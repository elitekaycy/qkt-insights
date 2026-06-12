import type { Db } from "./db.js";

/**
 * Trading-performance analytics. Sources, in order of trust:
 *
 * 1. Broker deals (when the strategy has closing deals) — ground truth. Per-trade
 *    P&L comes from dealClosedTrades (each closing leg paired with its position's
 *    IN), money-over-time from strategyEquityCurve (starting balance + cumulative
 *    realized). Never approximate.
 * 2. trade.closed rows (qkt >= 0.41 paper/backtest) — exact per-trade P&L when
 *    they cover the whole queried history.
 * 3. Equity snapshots — realized deltas between consecutive snapshots stand in
 *    for trades; the `approximate` flag the UI surfaces as "≈".
 */

const DAY = 86_400_000;

export interface AnalyticsFilter { instanceId: string; strategyId: string; from?: number; to?: number }

export interface DrawdownPeriod {
  peakTs: number;
  troughTs: number;
  recoveryTs: number | null;
  depth: number;
  depthPct: number;
  lengthDays: number;
  recoveryDays: number | null;
}

export interface DayNet { day: string; net: number; trades: number }

export interface PostLossRow { n: number; sample: number; nextWinRate: number; nextAvg: number }

export interface PerformanceReport {
  profitFactor: number | "inf" | null;
  expectancy: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  payoffRatio: number | null;
  kelly: number | null;
  grossProfit: number;
  grossLoss: number;
  largestWin: number | null;
  largestLoss: number | null;
  maxDrawdownPct: number | null;
  maxDrawdownAbs: number | null;
  drawdownDurationDays: number | null;
  recoveryFactor: number | null;
  sharpe: number | null;
  sortino: number | null;
  calmar: number | null;
  wins: number;
  losses: number;
  winRate: number | null;
  maxWinStreak: number;
  maxLossStreak: number;
  currentStreak: number;
  daysTraded: number;
  profitableDays: number;
  bestDay: number | null;
  worstDay: number | null;
  avgDayPnl: number | null;
  totalNet: number;
  approximate: boolean;
}

interface SnapRow { ts: number; realized: number; equity: number }

function snapshots(db: Db, f: AnalyticsFilter): SnapRow[] {
  const cl = ["instance_id=@instanceId", "strategy_id=@strategyId"];
  if (f.from != null) cl.push("ts>=@from");
  if (f.to != null) cl.push("ts<=@to");
  return db.prepare(
    `SELECT ts, realized, equity FROM equity_snapshots WHERE ${cl.join(" AND ")} ORDER BY ts ASC`,
  ).all(f) as SnapRow[];
}

/** Nonzero realized-P&L changes between consecutive snapshots — the approximate trade list. */
function realizedDeltas(snaps: SnapRow[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < snaps.length; i++) {
    const d = snaps[i]!.realized - snaps[i - 1]!.realized;
    if (d !== 0) out.push(d);
  }
  return out;
}

export interface ClosedTradeRow {
  ts: number;
  symbol: string;
  side: string;
  qty: number;
  price: number;
  realized: number;
  entryTs: number | null;
  orderId: string | null;
}

/** A closed trade rebuilt from broker deals; price is the exit price. */
export interface DealClosedTrade extends ClosedTradeRow {
  entryPrice: number | null;
  exitPrice: number;
  holdMs: number | null;
}

const OUT_LEGS = "('OUT','INOUT','OUT_BY')";

/** True when broker deals closed positions for this strategy — the deals source is authoritative then. */
export function hasClosingDeals(db: Db, f: { instanceId: string; strategyId: string }): boolean {
  return db.prepare(
    `SELECT 1 FROM deals WHERE instance_id=? AND strategy_id=? AND entry IN ${OUT_LEGS} LIMIT 1`,
  ).get(f.instanceId, f.strategyId) != null;
}

/**
 * One row per closing deal (OUT/INOUT/OUT_BY), paired with its position's first
 * IN deal: entry price/time come from the IN leg, exit and realized money from
 * the closing leg. A position closed in parts yields one row per closing leg,
 * all sharing the same IN. side is the POSITION's direction (the IN side), not
 * the close leg's. realized counts only the closing leg's profit + commission +
 * swap: on this account opening legs carry zero commission, and charging the IN
 * leg to one of several partial closes would double-count it anyway.
 */
export function dealClosedTrades(db: Db, f: AnalyticsFilter): DealClosedTrade[] {
  const cl = ["o.instance_id=@instanceId", "o.strategy_id=@strategyId", `o.entry IN ${OUT_LEGS}`];
  if (f.from != null) cl.push("o.ts>=@from");
  if (f.to != null) cl.push("o.ts<=@to");
  const rows = db.prepare(
    `SELECT o.position_ticket orderId, o.symbol, o.side outSide, i.side inSide, o.qty,
            i.price entryPrice, o.price exitPrice, i.ts entryTs, o.ts ts,
            o.profit + COALESCE(o.commission,0) + COALESCE(o.swap,0) realized
     FROM deals o
     LEFT JOIN deals i ON i.rowid = (
       SELECT rowid FROM deals x
       WHERE x.instance_id=o.instance_id AND x.position_ticket=o.position_ticket AND x.entry='IN'
       ORDER BY x.ts ASC LIMIT 1
     )
     WHERE ${cl.join(" AND ")}
     ORDER BY o.ts ASC`,
  ).all(f) as any[];
  return rows.map((r) => ({
    orderId: r.orderId,
    symbol: r.symbol,
    side: r.inSide ?? (r.outSide === "BUY" ? "SELL" : r.outSide === "SELL" ? "BUY" : r.outSide),
    qty: r.qty,
    price: r.exitPrice,
    entryPrice: r.entryPrice ?? null,
    exitPrice: r.exitPrice,
    entryTs: r.entryTs ?? null,
    ts: r.ts,
    realized: r.realized,
    holdMs: r.entryTs != null ? r.ts - r.entryTs : null,
  }));
}

export interface StrategyEquityPoint { ts: number; equity: number; realized: number; unrealized: number }

/**
 * The equity series rebuilt from broker deals: the configured starting balance
 * plus cumulative realized P&L at each closing deal, anchored by a first point
 * at the starting balance when the first traded position was opened. Strategies
 * without a stored starting balance get a 0-based curve — pure cumulative P&L.
 * unrealized is always 0: deals only know closed money. Cumulative realized is
 * built over the full history first, so a from/to window still shows true levels.
 */
export function strategyEquityCurve(
  db: Db,
  f: { instanceId: string; strategyId: string; from?: number; to?: number },
): StrategyEquityPoint[] {
  const rows = dealClosedTrades(db, { instanceId: f.instanceId, strategyId: f.strategyId });
  if (rows.length === 0) return [];
  const sb = (db.prepare("SELECT starting_balance sb FROM strategies WHERE instance_id=? AND strategy_id=?")
    .get(f.instanceId, f.strategyId) as { sb: number | null } | undefined)?.sb ?? 0;
  const pts: StrategyEquityPoint[] = [{ ts: rows[0]!.entryTs ?? rows[0]!.ts, equity: sb, realized: 0, unrealized: 0 }];
  let cum = 0;
  for (const r of rows) {
    cum += r.realized;
    pts.push({ ts: r.ts, equity: sb + cum, realized: cum, unrealized: 0 });
  }
  if (f.from == null && f.to == null) return pts;
  return pts.filter((p) => (f.from == null || p.ts >= f.from) && (f.to == null || p.ts <= f.to));
}

function ledgerCloses(db: Db, f: AnalyticsFilter): ClosedTradeRow[] {
  const cl = ["instance_id=@instanceId", "strategy_id=@strategyId"];
  if (f.from != null) cl.push("ts>=@from");
  if (f.to != null) cl.push("ts<=@to");
  return db.prepare(
    `SELECT ts, symbol, side, qty, price, realized, entry_ts entryTs, order_id orderId FROM trade_closes WHERE ${cl.join(" AND ")} ORDER BY ts ASC`,
  ).all(f) as ClosedTradeRow[];
}

/** Per-trade rows oldest-first: broker deals when they exist, else trade.closed rows. */
function closes(db: Db, f: AnalyticsFilter): ClosedTradeRow[] {
  return hasClosingDeals(db, f) ? dealClosedTrades(db, f) : ledgerCloses(db, f);
}

/** The money-over-time series: the deals-rebuilt curve when it exists, else equity snapshots. */
function series(db: Db, f: AnalyticsFilter): SnapRow[] {
  return hasClosingDeals(db, f) ? strategyEquityCurve(db, f) : snapshots(db, f);
}

/** Every closed trade in the range, newest first — the rows behind the performance numbers. */
export function closedTrades(db: Db, f: AnalyticsFilter): ClosedTradeRow[] {
  return closes(db, f).reverse();
}

/**
 * The per-trade P&L series. Broker deals are exact whenever they exist. Else
 * trade.closed rows are exact when they span the whole queried history; an
 * instance upgraded mid-stream has older trades only the snapshots saw, and
 * labeling that partial list exact would be a lie. Otherwise the realized-delta
 * approximation over snapshots. Range filters self-heal: a window that starts
 * after the first close is fully covered and reports exact.
 */
export function tradePnls(db: Db, f: AnalyticsFilter): { pnls: number[]; exact: boolean } {
  if (hasClosingDeals(db, f)) {
    return { pnls: dealClosedTrades(db, f).map((c) => c.realized).filter((r) => r !== 0), exact: true };
  }
  const exact = ledgerCloses(db, f);
  if (exact.length > 0 && closesCoverRange(db, f, exact[0]!.ts)) {
    return { pnls: exact.map((c) => c.realized).filter((r) => r !== 0), exact: true };
  }
  return { pnls: realizedDeltas(snapshots(db, f)), exact: false };
}

/** True when no realized P&L moved before the first stored close — nothing traded before trade.closed coverage began. */
function closesCoverRange(db: Db, f: AnalyticsFilter, firstCloseTs: number): boolean {
  const snaps = snapshots(db, f);
  for (let i = 1; i < snaps.length; i++) {
    if (snaps[i]!.ts >= firstCloseTs) return true;
    if (snaps[i]!.realized !== snaps[i - 1]!.realized) return false;
  }
  return true;
}

function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function dailyNets(db: Db, f: AnalyticsFilter): DayNet[] {
  // Deals path: group the closed trades per UTC day directly — net is the day's
  // realized sum, trades the number of closing legs that day.
  if (hasClosingDeals(db, f)) {
    const byDay = new Map<string, DayNet>();
    for (const c of dealClosedTrades(db, f)) {
      const day = utcDay(c.ts);
      const cur = byDay.get(day) ?? { day, net: 0, trades: 0 };
      cur.net += c.realized;
      cur.trades++;
      byDay.set(day, cur);
    }
    return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  }
  const snaps = snapshots(db, f);
  if (snaps.length === 0) return [];
  const lastByDay = new Map<string, number>();
  for (const s of snaps) lastByDay.set(utcDay(s.ts), s.realized);

  const fills = db.prepare(
    `SELECT e.ts FROM events e WHERE e.instance_id=@instanceId AND e.type='trade'
       AND COALESCE(e.strategy_id, (SELECT o.strategy_id FROM orders o
             WHERE o.instance_id=e.instance_id AND o.order_id=json_extract(e.payload,'$.orderId')))=@strategyId
       ${f.from != null ? "AND e.ts>=@from" : ""} ${f.to != null ? "AND e.ts<=@to" : ""}`,
  ).all(f) as { ts: number }[];
  const fillsByDay = new Map<string, number>();
  for (const t of fills) fillsByDay.set(utcDay(t.ts), (fillsByDay.get(utcDay(t.ts)) ?? 0) + 1);

  const days = [...lastByDay.keys()].sort();
  const out: DayNet[] = [];
  let prev: number | null = null;
  for (const day of days) {
    const last = lastByDay.get(day)!;
    const net = prev == null ? 0 : last - prev;
    const trades = fillsByDay.get(day) ?? 0;
    if (prev != null && (net !== 0 || trades > 0)) out.push({ day, net, trades });
    prev = last;
  }
  return out;
}

export function drawdownPeriods(db: Db, f: AnalyticsFilter): DrawdownPeriod[] {
  const snaps = series(db, f);
  return snaps.length > 0 ? walkPeriods(snaps) : [];
}

function period(peak: number, peakTs: number, trough: number, troughTs: number, recoveryTs: number | null, lastTs?: number): DrawdownPeriod {
  const end = recoveryTs ?? lastTs ?? troughTs;
  return {
    peakTs,
    troughTs,
    recoveryTs,
    depth: peak - trough,
    depthPct: peak > 0 ? ((peak - trough) / peak) * 100 : 0,
    lengthDays: (end - peakTs) / DAY,
    recoveryDays: recoveryTs != null ? (recoveryTs - troughTs) / DAY : null,
  };
}

export function postLossStats(db: Db, f: AnalyticsFilter): PostLossRow[] {
  const { pnls: deltas } = tradePnls(db, f);
  const buckets = new Map<number, number[]>();
  for (let i = 0; i < deltas.length - 1; i++) {
    if (deltas[i]! >= 0) continue;
    let run = 0;
    for (let j = i; j >= 0 && deltas[j]! < 0; j--) run++;
    for (let n = 1; n <= Math.min(run, 5); n++) {
      const next = deltas[i + 1]!;
      const arr = buckets.get(n) ?? [];
      arr.push(next);
      buckets.set(n, arr);
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([n, nexts]) => ({
      n,
      sample: nexts.length,
      nextWinRate: (nexts.filter((x) => x > 0).length / nexts.length) * 100,
      nextAvg: nexts.reduce((a, b) => a + b, 0) / nexts.length,
    }));
}

export function performanceReport(db: Db, f: AnalyticsFilter): PerformanceReport {
  const snaps = series(db, f);
  const { pnls: deltas, exact } = tradePnls(db, f);
  const wins = deltas.filter((d) => d > 0);
  const losses = deltas.filter((d) => d < 0);
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  // Summed from the same series the trade counts come from — never mix the
  // snapshot span (numerator) with the close count (denominator). In the
  // approximate mode the delta sum telescopes to last - first anyway.
  const totalNet = deltas.reduce((a, b) => a + b, 0);

  const avgWin = wins.length > 0 ? grossProfit / wins.length : null;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : null;
  const payoffRatio = avgWin != null && avgLoss != null && avgLoss > 0 ? avgWin / avgLoss : null;
  const winRate = deltas.length > 0 ? wins.length / deltas.length : null;
  const kelly = winRate != null && payoffRatio != null && payoffRatio > 0 ? winRate - (1 - winRate) / payoffRatio : null;
  const profitFactor: number | "inf" | null =
    deltas.length === 0 ? null : grossLoss === 0 ? (grossProfit > 0 ? "inf" : null) : grossProfit / grossLoss;

  let maxWinStreak = 0, maxLossStreak = 0, runW = 0, runL = 0;
  for (const d of deltas) {
    if (d > 0) { runW++; runL = 0; } else { runL++; runW = 0; }
    maxWinStreak = Math.max(maxWinStreak, runW);
    maxLossStreak = Math.max(maxLossStreak, runL);
  }
  let currentStreak = 0;
  for (let i = deltas.length - 1; i >= 0; i--) {
    const sign = deltas[i]! > 0 ? 1 : -1;
    if (currentStreak === 0) currentStreak = sign;
    else if (Math.sign(currentStreak) === sign) currentStreak += sign;
    else break;
  }

  // Risk: walk the full curve.
  let peak = -Infinity, maxDdAbs = 0, maxDdPct = 0;
  for (const s of snaps) {
    peak = Math.max(peak, s.equity);
    if (peak > 0) {
      maxDdAbs = Math.max(maxDdAbs, peak - s.equity);
      maxDdPct = Math.max(maxDdPct, ((peak - s.equity) / peak) * 100);
    }
  }
  const periods = snaps.length > 0 ? walkPeriods(snaps) : [];
  const drawdownDurationDays = periods.length > 0 ? Math.max(...periods.map((p) => p.lengthDays)) : null;

  // Ratios from end-of-day equity returns; null under 5 daily points (too little to pretend).
  const byDay = new Map<string, number>();
  for (const s of snaps) byDay.set(utcDay(s.ts), s.equity);
  const dailyEq = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, eq]) => eq);
  let sharpe: number | null = null, sortino: number | null = null, calmar: number | null = null;
  if (dailyEq.length >= 5) {
    const rets: number[] = [];
    for (let i = 1; i < dailyEq.length; i++) {
      const prev = dailyEq[i - 1]!;
      if (prev !== 0) rets.push(dailyEq[i]! / prev - 1);
    }
    if (rets.length >= 2) {
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
      const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
      const down = Math.sqrt(rets.reduce((a, b) => a + Math.min(0, b) ** 2, 0) / rets.length);
      sharpe = sd > 0 ? (mean * 252) / (sd * Math.sqrt(252)) : null;
      sortino = down > 0 ? (mean * 252) / (down * Math.sqrt(252)) : null;
      calmar = maxDdPct > 0 ? (mean * 252 * 100) / maxDdPct : null;
    }
  }

  const days = dailyNets(db, f);
  const dayValues = days.map((d) => d.net);

  return {
    profitFactor,
    expectancy: deltas.length > 0 ? totalNet / deltas.length : null,
    avgWin,
    avgLoss,
    payoffRatio,
    kelly,
    grossProfit,
    grossLoss,
    largestWin: wins.length > 0 ? Math.max(...wins) : null,
    largestLoss: losses.length > 0 ? Math.abs(Math.min(...losses)) : null,
    maxDrawdownPct: snaps.length > 0 ? maxDdPct : null,
    maxDrawdownAbs: snaps.length > 0 ? maxDdAbs : null,
    drawdownDurationDays,
    recoveryFactor: maxDdAbs > 0 ? totalNet / maxDdAbs : null,
    sharpe,
    sortino,
    calmar,
    wins: wins.length,
    losses: losses.length,
    winRate: winRate != null ? winRate * 100 : null,
    maxWinStreak,
    maxLossStreak,
    currentStreak,
    daysTraded: days.length,
    profitableDays: dayValues.filter((n) => n > 0).length,
    bestDay: dayValues.length > 0 ? Math.max(...dayValues) : null,
    worstDay: dayValues.length > 0 ? Math.min(...dayValues) : null,
    avgDayPnl: dayValues.length > 0 ? totalNet / dayValues.length : null,
    totalNet,
    approximate: !exact,
  };
}

export interface BreakdownRow { key: string; net: number; trades: number; wins: number }
export interface DistributionBin { from: number; to: number; count: number }

export interface TradeBreakdowns {
  bySymbol: BreakdownRow[];
  byHour: BreakdownRow[];
  byDow: BreakdownRow[];
  byVolume: BreakdownRow[];
  holdTime: BreakdownRow[] | null;
  distribution: DistributionBin[];
}

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const HOLD_BINS: { key: string; maxMs: number }[] = [
  { key: "<15m", maxMs: 15 * 60_000 },
  { key: "15–60m", maxMs: 60 * 60_000 },
  { key: "1–4h", maxMs: 4 * 3_600_000 },
  { key: "4–24h", maxMs: 24 * 3_600_000 },
  { key: ">1d", maxMs: Infinity },
];

/** Per-close breakdowns — exact data only; null until this instance publishes trade.closed. */
export function tradeBreakdowns(db: Db, f: AnalyticsFilter): TradeBreakdowns | null {
  const rows = closes(db, f);
  if (rows.length === 0) return null;

  const acc = (map: Map<string, BreakdownRow>, key: string, r: ClosedTradeRow) => {
    const cur = map.get(key) ?? { key, net: 0, trades: 0, wins: 0 };
    cur.net += r.realized;
    cur.trades++;
    if (r.realized > 0) cur.wins++;
    map.set(key, cur);
  };

  const bySymbol = new Map<string, BreakdownRow>();
  const byHour = new Map<string, BreakdownRow>();
  const byDow = new Map<string, BreakdownRow>();
  const byVolume = new Map<string, BreakdownRow>();
  const holdTime = new Map<string, BreakdownRow>();
  let withEntry = 0;
  for (const r of rows) {
    const d = new Date(r.ts);
    acc(bySymbol, r.symbol, r);
    acc(byHour, String(d.getUTCHours()).padStart(2, "0"), r);
    acc(byDow, DOW[(d.getUTCDay() + 6) % 7]!, r);
    acc(byVolume, r.qty.toFixed(2), r);
    if (r.entryTs != null) {
      withEntry++;
      const held = r.ts - r.entryTs;
      acc(holdTime, HOLD_BINS.find((b) => held < b.maxMs)!.key, r);
    }
  }

  const pnls = rows.map((r) => r.realized);
  const min = Math.min(...pnls);
  const max = Math.max(...pnls);
  const BINS = 11;
  const width = max > min ? (max - min) / BINS : 1;
  const distribution: DistributionBin[] = Array.from({ length: BINS }, (_, i) => ({
    from: min + i * width,
    to: min + (i + 1) * width,
    count: 0,
  }));
  for (const p of pnls) {
    const i = Math.min(BINS - 1, Math.floor((p - min) / width));
    distribution[i]!.count++;
  }

  const sortNet = (m: Map<string, BreakdownRow>) => [...m.values()].sort((a, b) => b.net - a.net);
  const sortKey = (m: Map<string, BreakdownRow>) => [...m.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  return {
    bySymbol: sortNet(bySymbol),
    byHour: sortKey(byHour),
    byDow: [...byDow.values()].sort((a, b) => DOW.indexOf(a.key) - DOW.indexOf(b.key)),
    byVolume: sortKey(byVolume),
    holdTime: withEntry > 0 ? HOLD_BINS.map((b) => holdTime.get(b.key)).filter((x): x is BreakdownRow => !!x) : null,
    distribution,
  };
}

function walkPeriods(snaps: SnapRow[]): DrawdownPeriod[] {
  const out: DrawdownPeriod[] = [];
  let peak = snaps[0]!.equity, peakTs = snaps[0]!.ts, inDd = false, trough = 0, troughTs = 0;
  for (const s of snaps) {
    if (s.equity >= peak) {
      if (inDd) { out.push(period(peak, peakTs, trough, troughTs, s.ts)); inDd = false; }
      peak = s.equity; peakTs = s.ts;
    } else if (!inDd) { inDd = true; trough = s.equity; troughTs = s.ts; }
    else if (s.equity < trough) { trough = s.equity; troughTs = s.ts; }
  }
  if (inDd) out.push(period(peak, peakTs, trough, troughTs, null, snaps[snaps.length - 1]!.ts));
  return out;
}
