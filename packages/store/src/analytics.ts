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
  /** Engine order that opened the position (orders.broker_order_id = IN leg's order ticket). */
  entryOrderId: string | null;
  /** Engine order that executed this close (orders.broker_order_id = closing leg's order ticket). */
  exitOrderId: string | null;
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
 * swap + fee: on this account opening legs carry zero commission, and charging
 * the IN leg to one of several partial closes would double-count it anyway.
 */
export function dealClosedTrades(db: Db, f: AnalyticsFilter): DealClosedTrade[] {
  const cl = ["o.instance_id=@instanceId", "o.strategy_id=@strategyId", `o.entry IN ${OUT_LEGS}`];
  if (f.from != null) cl.push("o.ts>=@from");
  if (f.to != null) cl.push("o.ts<=@to");
  const rows = db.prepare(
    `SELECT o.position_ticket orderId, o.symbol, o.side outSide, i.side inSide, o.qty,
            i.price entryPrice, o.price exitPrice, i.ts entryTs, o.ts ts,
            o.profit + COALESCE(o.commission,0) + COALESCE(o.swap,0) + COALESCE(o.fee,0) realized,
            eo.order_id entryOrderId, xo.order_id exitOrderId
     FROM deals o
     LEFT JOIN deals i ON i.rowid = (
       SELECT rowid FROM deals x
       WHERE x.instance_id=o.instance_id AND x.position_ticket=o.position_ticket AND x.entry='IN'
       ORDER BY x.ts ASC LIMIT 1
     )
     LEFT JOIN orders eo ON eo.instance_id=o.instance_id AND eo.broker_order_id=i.order_ticket
     LEFT JOIN orders xo ON xo.instance_id=o.instance_id AND xo.broker_order_id=o.order_ticket
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
    entryOrderId: r.entryOrderId ?? null,
    exitOrderId: r.exitOrderId ?? null,
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
  const rows = closes(db, { instanceId: f.instanceId, strategyId: f.strategyId });
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
  // Closed-trades path: group per UTC day — net is the day's realized sum, trades the number of
  // closing legs. Uses closes() so it falls back to trade.closed rows when broker deals were not
  // polled (engine-native fills), matching report/contribution; otherwise a live book that trades
  // but has no deals shows an empty calendar/equity while the report shows the P&L.
  const trades = closes(db, f);
  if (trades.length > 0) {
    const byDay = new Map<string, DayNet>();
    for (const c of trades) {
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

export interface BreakdownRow {
  key: string;
  net: number;
  trades: number;
  wins: number;
  /** Standard error of the mean per-trade P&L; null under 2 trades (cannot compute). */
  se: number | null;
}
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

  const samples = new Map<string, number[]>();
  const acc = (map: Map<string, BreakdownRow>, key: string, r: ClosedTradeRow) => {
    const cur = map.get(key) ?? { key, net: 0, trades: 0, wins: 0, se: null };
    cur.net += r.realized;
    cur.trades++;
    if (r.realized > 0) cur.wins++;
    map.set(key, cur);
    const id = `${map === byHour ? "h" : map === byDow ? "d" : map === bySymbol ? "s" : map === byVolume ? "v" : "t"}:${key}`;
    const arr = samples.get(id) ?? [];
    arr.push(r.realized);
    samples.set(id, arr);
  };
  const fillSe = (map: Map<string, BreakdownRow>, prefix: string) => {
    for (const row of map.values()) row.se = standardError(samples.get(`${prefix}:${row.key}`) ?? []);
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

  fillSe(bySymbol, "s");
  fillSe(byHour, "h");
  fillSe(byDow, "d");
  fillSe(byVolume, "v");
  fillSe(holdTime, "t");

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

/** Sample standard error of the mean; null under 2 observations — never a fake 0. */
function standardError(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
  return sd / Math.sqrt(xs.length);
}

export interface DowHourCell {
  /** 0 = Monday … 6 = Sunday (UTC), matching the byDow ordering. */
  dow: number;
  /** UTC hour of the close, 0-23. */
  hour: number;
  n: number;
  net: number;
  mean: number;
  /** Percentage 0-100. */
  winRate: number;
}

/**
 * Day-of-week × hour-of-day matrix over closed trades, bucketed by the CLOSE
 * timestamp in UTC. Cells with no trades are omitted — consumers mask them,
 * never interpolate. Exact sources only (deals, else trade.closed); null until
 * one exists, like tradeBreakdowns.
 */
export function dowHourMatrix(db: Db, f: AnalyticsFilter): DowHourCell[] | null {
  const rows = closes(db, f);
  if (rows.length === 0) return null;
  const cells = new Map<number, DowHourCell & { wins: number }>();
  for (const r of rows) {
    const d = new Date(r.ts);
    const dow = (d.getUTCDay() + 6) % 7;
    const hour = d.getUTCHours();
    const k = dow * 24 + hour;
    const cur = cells.get(k) ?? { dow, hour, n: 0, net: 0, mean: 0, winRate: 0, wins: 0 };
    cur.n++;
    cur.net += r.realized;
    if (r.realized > 0) cur.wins++;
    cells.set(k, cur);
  }
  return [...cells.values()]
    .sort((a, b) => a.dow * 24 + a.hour - (b.dow * 24 + b.hour))
    .map(({ wins, ...c }) => ({ ...c, mean: c.net / c.n, winRate: (wins / c.n) * 100 }));
}

export interface RollingPoint {
  day: string;
  /** Annualized (√252) Sharpe over the window's daily equity returns; null during warmup. */
  sharpe: number | null;
  /** Percentage of traded days in the window that were net-positive; null when none traded. */
  winRate: number | null;
  /** Mean net P&L per traded day in the window; null when none traded. */
  meanNet: number | null;
}

/**
 * Rolling edge-stability series over end-of-day equity. For each day in the
 * equity series, the window is the last `windowDays` daily return observations
 * ending that day; days with fewer observations report sharpe null — warmup is
 * visible, not faked. Win rate and mean net come from dailyNets days falling
 * inside the same window.
 */
export function rollingStats(db: Db, f: AnalyticsFilter, windowDays = 30): RollingPoint[] {
  const win = Number.isFinite(windowDays) ? Math.min(180, Math.max(7, Math.floor(windowDays))) : 30;
  const snaps = series(db, f);
  if (snaps.length === 0) return [];
  const eqByDay = new Map<string, number>();
  for (const s of snaps) eqByDay.set(utcDay(s.ts), s.equity);
  const days = [...eqByDay.keys()].sort();
  const nets = new Map(dailyNets(db, f).map((d) => [d.day, d.net]));

  const rets: (number | null)[] = [null];
  for (let i = 1; i < days.length; i++) {
    const prev = eqByDay.get(days[i - 1]!)!;
    rets.push(prev !== 0 ? eqByDay.get(days[i]!)! / prev - 1 : null);
  }

  return days.map((day, i) => {
    const winRets = rets.slice(Math.max(1, i - win + 1), i + 1).filter((r): r is number => r != null);
    let sharpe: number | null = null;
    if (winRets.length >= win) {
      const mean = winRets.reduce((a, b) => a + b, 0) / winRets.length;
      const sd = Math.sqrt(winRets.reduce((a, b) => a + (b - mean) ** 2, 0) / (winRets.length - 1));
      sharpe = sd > 0 ? (mean * 252) / (sd * Math.sqrt(252)) : null;
    }
    const winDays = days.slice(Math.max(0, i - win + 1), i + 1).filter((d) => nets.has(d));
    const dayNets = winDays.map((d) => nets.get(d)!);
    return {
      day,
      sharpe,
      winRate: dayNets.length > 0 ? (dayNets.filter((n) => n > 0).length / dayNets.length) * 100 : null,
      meanNet: dayNets.length > 0 ? dayNets.reduce((a, b) => a + b, 0) / dayNets.length : null,
    };
  });
}

export interface CostRow {
  key: string;
  grossProfit: number;
  commission: number;
  swap: number;
  fee: number;
  net: number;
  trades: number;
}

export interface CostDecomposition { byMonth: CostRow[]; total: CostRow }

/**
 * Gross-vs-cost decomposition per UTC month of the closing leg. Deals source
 * only — trade_closes rows carry realized with no cost split — so this is null
 * for paper instances; the payload's absence tells the UI why.
 */
export function costDecomposition(db: Db, f: AnalyticsFilter): CostDecomposition | null {
  if (!hasClosingDeals(db, f)) return null;
  const cl = ["instance_id=@instanceId", "strategy_id=@strategyId", `entry IN ${OUT_LEGS}`];
  if (f.from != null) cl.push("ts>=@from");
  if (f.to != null) cl.push("ts<=@to");
  const rows = db.prepare(
    `SELECT strftime('%Y-%m', ts/1000, 'unixepoch') key,
            SUM(profit) grossProfit,
            SUM(COALESCE(commission,0)) commission,
            SUM(COALESCE(swap,0)) swap,
            SUM(COALESCE(fee,0)) fee,
            SUM(profit + COALESCE(commission,0) + COALESCE(swap,0) + COALESCE(fee,0)) net,
            COUNT(*) trades
     FROM deals WHERE ${cl.join(" AND ")}
     GROUP BY key ORDER BY key ASC`,
  ).all(f) as CostRow[];
  const total = rows.reduce(
    (t, r) => ({
      key: "total",
      grossProfit: t.grossProfit + r.grossProfit,
      commission: t.commission + r.commission,
      swap: t.swap + r.swap,
      fee: t.fee + r.fee,
      net: t.net + r.net,
      trades: t.trades + r.trades,
    }),
    { key: "total", grossProfit: 0, commission: 0, swap: 0, fee: 0, net: 0, trades: 0 },
  );
  return { byMonth: rows, total };
}

export interface ContributionRow {
  key: string;
  net: number;
  trades: number;
  /** Percentage 0-100. */
  winRate: number;
  /** Mean net per trade. */
  expectancy: number;
  /** Signed fraction of total net (net/totalNet); null when total is 0. */
  share: number | null;
}

export interface ContributionRanking {
  bySymbol: ContributionRow[];
  byDirection: ContributionRow[];
  totalNet: number;
}

/**
 * Where the money comes from: ranked net contribution by symbol and by
 * position direction, each row carrying expectancy and n so size-driven
 * contribution is distinguishable from per-trade edge. share is signed —
 * a profitable symbol inside a losing total reports a negative share.
 */
export function contributionRanking(db: Db, f: AnalyticsFilter): ContributionRanking | null {
  const rows = closes(db, f);
  if (rows.length === 0) return null;
  const totalNet = rows.reduce((a, r) => a + r.realized, 0);
  const build = (key: (r: ClosedTradeRow) => string): ContributionRow[] => {
    const m = new Map<string, { net: number; trades: number; wins: number }>();
    for (const r of rows) {
      const k = key(r);
      const cur = m.get(k) ?? { net: 0, trades: 0, wins: 0 };
      cur.net += r.realized;
      cur.trades++;
      if (r.realized > 0) cur.wins++;
      m.set(k, cur);
    }
    return [...m.entries()]
      .map(([k, v]) => ({
        key: k,
        net: v.net,
        trades: v.trades,
        winRate: (v.wins / v.trades) * 100,
        expectancy: v.net / v.trades,
        share: totalNet !== 0 ? v.net / totalNet : null,
      }))
      .sort((a, b) => b.net - a.net);
  };
  return { bySymbol: build((r) => r.symbol), byDirection: build((r) => r.side), totalNet };
}

export interface NormalizedPerformance {
  trades: number;
  totalQty: number;
  netPerUnit: number | null;
  averageQty: number | null;
  averagePlannedRiskReward: number | null;
  plannedRiskRewardSample: number;
}

/** Size-normalized results plus planned price R:R from numeric bracket submits. */
export function normalizedPerformance(db: Db, f: AnalyticsFilter): NormalizedPerformance {
  const rows = closes(db, f);
  const totalQty = rows.reduce((a, r) => a + Math.abs(r.qty), 0);
  const totalNet = rows.reduce((a, r) => a + r.realized, 0);
  const cl = ["instance_id=@instanceId", "type='order.submit'", "COALESCE(strategy_id,json_extract(payload,'$.strategyId'))=@strategyId"];
  if (f.from != null) cl.push("ts>=@from");
  if (f.to != null) cl.push("ts<=@to");
  const submits = db.prepare(`SELECT payload FROM events WHERE ${cl.join(" AND ")}`).all(f) as { payload: string }[];
  const planned: number[] = [];
  for (const row of submits) {
    const p = JSON.parse(row.payload) as Record<string, unknown>;
    const entry = finite(p.entryPrice) ?? finite(p.limitPrice) ?? finite(p.stopPrice);
    const stop = finite(p.stopLoss);
    const target = finite(p.takeProfit);
    if (entry == null || stop == null || target == null) continue;
    const risk = Math.abs(entry - stop);
    if (risk > 0) planned.push(Math.abs(target - entry) / risk);
  }
  return {
    trades: rows.length,
    totalQty,
    netPerUnit: totalQty > 0 ? totalNet / totalQty : null,
    averageQty: rows.length > 0 ? totalQty / rows.length : null,
    averagePlannedRiskReward: planned.length > 0 ? planned.reduce((a, b) => a + b, 0) / planned.length : null,
    plannedRiskRewardSample: planned.length,
  };
}

export interface ExcursionRow {
  ticket: string;
  symbol: string;
  side: string;
  ts: number;
  exitPnl: number;
  mae: number;
  mfe: number;
  capturePct: number | null;
  observations: number;
}

export interface ExcursionStats {
  rows: ExcursionRow[];
  closedTrades: number;
  sampledTrades: number;
  coveragePct: number;
  averageMae: number;
  averageMfe: number;
  averageCapturePct: number | null;
  sampled: true;
}

/**
 * Sampled MAE/MFE from the broker position poll. Values between polls are not
 * observed, so coverage and the sampled flag are part of the result contract.
 */
export function excursionStats(db: Db, f: AnalyticsFilter): ExcursionStats | null {
  if (!hasClosingDeals(db, f)) return null;
  const trades = dealClosedTrades(db, f);
  const rows: ExcursionRow[] = [];
  for (const trade of trades) {
    if (!trade.orderId || trade.entryTs == null) continue;
    const values = db.prepare(
      `SELECT profit, ts FROM position_valuations
       WHERE instance_id=? AND ticket=? AND ts>=? AND ts<=?
         AND (strategy_id=? OR strategy_id IS NULL)
       ORDER BY ts ASC`,
    ).all(f.instanceId, trade.orderId, trade.entryTs, trade.ts, f.strategyId) as Array<{ profit: number | null; ts: number }>;
    const pnl = values.map((x) => x.profit).filter((x): x is number => x != null && Number.isFinite(x));
    if (pnl.length === 0) continue;
    const mae = pnl.reduce((lowest, value) => Math.min(lowest, value), 0);
    const mfe = pnl.reduce((highest, value) => Math.max(highest, value), 0);
    rows.push({
      ticket: trade.orderId,
      symbol: trade.symbol,
      side: trade.side,
      ts: trade.ts,
      exitPnl: trade.realized,
      mae,
      mfe,
      capturePct: mfe > 0 ? (trade.realized / mfe) * 100 : null,
      observations: pnl.length,
    });
  }
  if (rows.length === 0) return null;
  const captures = rows.map((x) => x.capturePct).filter((x): x is number => x != null && Number.isFinite(x));
  return {
    rows,
    closedTrades: trades.length,
    sampledTrades: rows.length,
    coveragePct: trades.length > 0 ? (rows.length / trades.length) * 100 : 0,
    averageMae: rows.reduce((a, x) => a + x.mae, 0) / rows.length,
    averageMfe: rows.reduce((a, x) => a + x.mfe, 0) / rows.length,
    averageCapturePct: captures.length > 0 ? captures.reduce((a, x) => a + x, 0) / captures.length : null,
    sampled: true,
  };
}

export interface ExecutionQuality {
  submitted: number;
  accepted: number;
  filled: number;
  rejected: number;
  rejectionRate: number | null;
  averageAcceptMs: number | null;
  p95FillMs: number | null;
  averageAdverseSlippage: number | null;
  slippageSample: number;
}

/** Order lifecycle latency and price slippage reconstructed from stored events. */
export function executionQuality(db: Db, f: AnalyticsFilter): ExecutionQuality {
  const cl = ["instance_id=@instanceId", "type='order.submit'", "COALESCE(strategy_id,json_extract(payload,'$.strategyId'))=@strategyId"];
  if (f.from != null) cl.push("ts>=@from");
  if (f.to != null) cl.push("ts<=@to");
  const submits = db.prepare(`SELECT ts, payload FROM events WHERE ${cl.join(" AND ")} ORDER BY ts`).all(f) as Array<{ ts: number; payload: string }>;
  const events = db.prepare(
    `SELECT type, ts, payload FROM events
     WHERE instance_id=? AND type IN ('order.accepted','order.filled','order.partially_filled','order.rejected')
     ORDER BY ts ASC`,
  ).all(f.instanceId) as Array<{ type: string; ts: number; payload: string }>;
  const byOrder = new Map<string, Array<{ type: string; ts: number; payload: Record<string, unknown> }>>();
  for (const event of events) {
    const payload = JSON.parse(event.payload) as Record<string, unknown>;
    if (typeof payload.orderId !== "string") continue;
    const list = byOrder.get(payload.orderId) ?? [];
    list.push({ ...event, payload });
    byOrder.set(payload.orderId, list);
  }
  const accepts: number[] = [], fills: number[] = [], slippage: number[] = [];
  let accepted = 0, filled = 0, rejected = 0;
  for (const submit of submits) {
    const p = JSON.parse(submit.payload) as Record<string, unknown>;
    if (typeof p.orderId !== "string") continue;
    const lifecycle = (byOrder.get(p.orderId) ?? []).filter((x) => x.ts >= submit.ts);
    const accept = lifecycle.find((x) => x.type === "order.accepted");
    const fill = lifecycle.find((x) => x.type === "order.filled" || x.type === "order.partially_filled");
    const reject = lifecycle.find((x) => x.type === "order.rejected");
    if (accept) { accepted++; accepts.push(accept.ts - submit.ts); }
    if (fill) {
      filled++;
      fills.push(fill.ts - submit.ts);
      const expected = finite(p.entryPrice) ?? finite(p.limitPrice) ?? finite(p.stopPrice);
      const actual = finite(fill.payload.price);
      if (expected != null && actual != null && (p.side === "BUY" || p.side === "SELL")) {
        slippage.push(p.side === "BUY" ? actual - expected : expected - actual);
      }
    }
    if (reject) rejected++;
  }
  return {
    submitted: submits.length,
    accepted,
    filled,
    rejected,
    rejectionRate: submits.length > 0 ? (rejected / submits.length) * 100 : null,
    averageAcceptMs: accepts.length > 0 ? accepts.reduce((a, b) => a + b, 0) / accepts.length : null,
    p95FillMs: percentile(fills, 0.95),
    averageAdverseSlippage: slippage.length > 0 ? slippage.reduce((a, b) => a + b, 0) / slippage.length : null,
    slippageSample: slippage.length,
  };
}

function finite(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function percentile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)]!;
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
