import type { Db } from "./db.js";

/**
 * Trading-performance analytics derived from the stored series (spec 3, phase 1).
 *
 * Sources, by metric shape:
 * - money-over-time (drawdown, Sharpe, Sortino, Calmar) — the equity snapshot curve, exact;
 * - per-trade P&L (profit factor, expectancy, streaks) — realized deltas between
 *   consecutive snapshots. qkt snapshots after every fill, so each nonzero delta is
 *   one close — approximate when fills land closer than a snapshot, hence the
 *   `approximate` flag the UI surfaces as "≈". Phase 2 (trade.closed) makes it exact.
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

function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function dailyNets(db: Db, f: AnalyticsFilter): DayNet[] {
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
  const snaps = snapshots(db, f);
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
  const deltas = realizedDeltas(snapshots(db, f));
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

export interface OpenPositionRow {
  strategyId: string;
  symbol: string;
  ts: number;
  legs: { side: string; qty: number; entryPrice: number; entryTs: number }[];
}

export function openPositions(db: Db, f: { instanceId: string; strategyId?: string }): OpenPositionRow[] {
  const rows = db.prepare(
    `SELECT strategy_id strategyId, json_extract(payload,'$.symbol') symbol, ts, payload
     FROM events e
     WHERE instance_id=@instanceId AND type='snapshot.position'
       ${f.strategyId ? "AND strategy_id=@strategyId" : ""}
       AND ts = (SELECT MAX(ts) FROM events e2 WHERE e2.instance_id=e.instance_id AND e2.type='snapshot.position'
                   AND e2.strategy_id=e.strategy_id AND json_extract(e2.payload,'$.symbol')=json_extract(e.payload,'$.symbol'))
     ORDER BY strategy_id, symbol`,
  ).all(f) as any[];
  return rows
    .map((r) => ({ strategyId: r.strategyId, symbol: r.symbol, ts: r.ts, legs: JSON.parse(r.payload).legs }))
    .filter((r) => r.legs.length > 0);
}

export function performanceReport(db: Db, f: AnalyticsFilter): PerformanceReport {
  const snaps = snapshots(db, f);
  const deltas = realizedDeltas(snaps);
  const wins = deltas.filter((d) => d > 0);
  const losses = deltas.filter((d) => d < 0);
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const totalNet = snaps.length > 0 ? snaps[snaps.length - 1]!.realized - snaps[0]!.realized : 0;

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
    approximate: true,
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
