import type { AccountRiskRow, LiveAccount, LivePositionRow, StrategyRow } from "./api";
import { instrumentOf, openPnl } from "./format";
import { roundMoney } from "@qkt-insights/contract/money";

/*
 * Home's figures, as pure functions over what the API already returns: the account's live state,
 * its risk row (limits, day basis), and every close on the account. Nothing here reads React.
 */

const DAY_MS = 86_400_000;

/** The account's risk row for a live account: by login@server, then by label, then the only one. */
export function riskRowFor(account: Pick<LiveAccount, "broker" | "login" | "server">, rows: AccountRiskRow[]): AccountRiskRow | null {
  const identity = account.login && account.server ? `${account.login}@${account.server}` : null;
  return (identity != null ? rows.find((r) => r.account === identity) : undefined)
    ?? rows.find((r) => r.label === account.broker || r.account === account.broker)
    ?? (rows.length === 1 ? rows[0]! : null);
}

/**
 * Today on the account's own day basis: closes since the trading day began (the risk row's day
 * start, e.g. 00:00 server time) plus what is floating now. Floating is equity minus balance, the
 * venue's own figure, so swap and commission on open positions are in it.
 */
export function accountToday(account: { balance: number; equity: number }, realizedToday: number): { total: number; realized: number; floating: number } {
  const floating = account.equity - account.balance;
  return { total: realizedToday + floating, realized: realizedToday, floating };
}

export interface LimitUse {
  used: number | null;
  cap: number | null;
  /** used / cap in percent; null without a cap. */
  pct: number | null;
}

/**
 * Daily loss and drawdown against the account's limits, re-marked to the live equity when one is
 * known (the risk row is as of the last minute rollup). Same rules as the store: drawdown below the
 * start balance (static) or below the highest equity seen (peak); daily loss either day-start
 * balance minus equity (incl. floating) or the day's realized loss.
 */
export function limitUse(row: AccountRiskRow, liveEquity: number | null): { daily: LimitUse; drawdown: LimitUse } {
  const equity = liveEquity ?? row.equity;
  const reference = row.basis === "static" ? row.startBalance : row.peakEquity == null || equity == null ? row.peakEquity : Math.max(row.peakEquity, equity);
  const ddUsed = reference != null && equity != null ? Math.max(0, reference - equity) : row.drawdown.used;
  const dailyUsed = row.dailyLoss.includesFloating
    ? (row.dailyLoss.dayStartBalance != null && equity != null ? Math.max(0, row.dailyLoss.dayStartBalance - equity) : row.dailyLoss.used)
    : Math.max(0, -row.dailyLoss.realizedToday);
  const use = (used: number | null, cap: number | null): LimitUse => ({ used, cap, pct: used != null && cap != null && cap > 0 ? (used / cap) * 100 : null });
  return { daily: use(dailyUsed, row.dailyLoss.cap), drawdown: use(ddUsed, row.drawdown.cap) };
}

/** When the account's trading day begins, e.g. "day from 00:00 UTC". */
export function dayBasisLabel(row: Pick<AccountRiskRow, "dailyLoss">): string {
  return `day from ${String(row.dailyLoss.resetHour).padStart(2, "0")}:00 ${row.dailyLoss.timezone}`;
}

export interface PositionRisk {
  /** Money per 1.0 of price for the whole position, derived from the venue's own mark; null when it cannot be. */
  valuePerUnit: number | null;
  /** Money the position moves from now to its stop (negative is a loss); null without a stop or a value per unit. */
  toStop: number | null;
  noStop: boolean;
}

const direction = (side: string) => (/SELL|SHORT/i.test(side) ? -1 : 1);
const hasStop = (p: LivePositionRow) => p.stopLoss != null && p.stopLoss > 0;

/**
 * Distance to each position's stop in money. The value of one price unit comes from the venue: a
 * position's profit over its price move (profit excludes swap, so it is the pure price P&L). One
 * instrument shares a per-lot value, taken from the position with the largest mark (least rounding),
 * so a position sitting exactly at its entry is still priced by its siblings.
 */
export function positionRisks(positions: LivePositionRow[]): Map<string, PositionRisk> {
  const perLot = new Map<string, { value: number; weight: number }>();
  for (const p of positions) {
    if (p.profit == null || p.currentPrice == null || !(p.qty > 0)) continue;
    const move = (p.currentPrice - p.entryPrice) * direction(p.side);
    if (Math.abs(move) < 1e-12 || p.profit === 0) continue;
    const value = p.profit / move / p.qty;
    if (!(value > 0) || !Number.isFinite(value)) continue;
    const key = instrumentOf(p.symbol);
    const weight = Math.abs(p.profit);
    const cur = perLot.get(key);
    if (!cur || weight > cur.weight) perLot.set(key, { value, weight });
  }
  const out = new Map<string, PositionRisk>();
  for (const p of positions) {
    const lot = perLot.get(instrumentOf(p.symbol));
    const valuePerUnit = lot ? lot.value * p.qty : null;
    const noStop = !hasStop(p);
    const toStop = !noStop && valuePerUnit != null && p.currentPrice != null
      ? (p.stopLoss! - p.currentPrice) * direction(p.side) * valuePerUnit
      : null;
    out.set(p.ticket, { valuePerUnit, toStop, noStop });
  }
  return out;
}

export interface OpenRisk {
  /** Sum of every priced position's move to its stop; negative is money lost if every stop fills now. */
  toStops: number;
  /** Positions in the sum. */
  priced: number;
  /** Positions without a stop: their loss is unbounded and not in the sum. */
  noStop: number;
  /** Positions with a stop whose money value could not be derived. */
  unpriced: number;
  /** Open P&L of every position, swap included. */
  floating: number;
}

export function openRisk(positions: LivePositionRow[]): OpenRisk {
  const risks = positionRisks(positions);
  const out: OpenRisk = { toStops: 0, priced: 0, noStop: 0, unpriced: 0, floating: 0 };
  for (const p of positions) {
    const r = risks.get(p.ticket)!;
    out.floating += openPnl(p);
    if (r.noStop) out.noStop++;
    else if (r.toStop == null) out.unpriced++;
    else { out.toStops += r.toStop; out.priced++; }
  }
  return out;
}

export interface StrategyPeriods {
  /** Strategy id; null is the unattributed bucket. */
  key: string | null;
  /** Realized since the account's trading day began, plus what its open positions float now. */
  today: number;
  todayRealized: number;
  floating: number;
  /** Realized today and over the six UTC days before (sevenDayStart). */
  d7: number;
  /** Realized since the UTC month began. */
  mtd: number;
  /** Realized over every stored close. */
  all: number;
  /** Deepest fall of the cumulative realized P&L from its running peak (starting at 0), as money. */
  maxDd: number;
  trades: number;
  wins: number;
  losses: number;
  /** Wins over decided closes (breakeven excluded); null without one. */
  winRate: number | null;
  lastTs: number | null;
}

export function utcMonthStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** Where 7D begins: the UTC midnight six days before today's, so 7D is today and the six UTC days before. */
export function sevenDayStart(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS - 6 * DAY_MS;
}

/**
 * Per-strategy period sums over every close on the account, keyed by strategy id (null for closes
 * no strategy claimed), at the account currency's minor unit (`digits`, default 2). 7D is today
 * and the six UTC days before (sevenDayStart), as the P&L chart's 7D. `floating` adds open P&L to
 * Today; a strategy with only an open position gets a row.
 */
export function strategyPeriods(
  closes: ReadonlyArray<{ strategyId: string | null; ts: number; realized: number }>,
  opts: { now: number; dayStart: number; floating?: ReadonlyMap<string | null, number>; digits?: number },
): Map<string | null, StrategyPeriods> {
  const digits = opts.digits ?? 2;
  const plus = (a: number, b: number) => roundMoney(a + b, digits);
  const weekStart = sevenDayStart(opts.now);
  const monthStart = utcMonthStart(opts.now);
  const out = new Map<string | null, StrategyPeriods & { cum: number; peak: number }>();
  const row = (key: string | null) => {
    let r = out.get(key);
    if (!r) {
      r = { key, today: 0, todayRealized: 0, floating: 0, d7: 0, mtd: 0, all: 0, maxDd: 0, trades: 0, wins: 0, losses: 0, winRate: null, lastTs: null, cum: 0, peak: 0 };
      out.set(key, r);
    }
    return r;
  };
  const ordered = [...closes].filter((c) => c.ts <= opts.now).sort((a, b) => a.ts - b.ts);
  for (const c of ordered) {
    const r = row(c.strategyId);
    r.all = plus(r.all, c.realized);
    r.trades++;
    if (c.realized > 0) r.wins++;
    else if (c.realized < 0) r.losses++;
    if (c.ts >= opts.dayStart) r.todayRealized = plus(r.todayRealized, c.realized);
    if (c.ts >= weekStart) r.d7 = plus(r.d7, c.realized);
    if (c.ts >= monthStart) r.mtd = plus(r.mtd, c.realized);
    r.lastTs = c.ts;
    r.cum = plus(r.cum, c.realized);
    r.peak = Math.max(r.peak, r.cum);
    r.maxDd = Math.max(r.maxDd, plus(r.peak, -r.cum));
  }
  for (const [key, value] of opts.floating ?? []) row(key).floating = plus(row(key).floating, value);
  const result = new Map<string | null, StrategyPeriods>();
  for (const [key, { cum: _cum, peak: _peak, ...r }] of out) {
    const decided = r.wins + r.losses;
    result.set(key, { ...r, today: plus(r.todayRealized, r.floating), winRate: decided > 0 ? r.wins / decided : null });
  }
  return result;
}

/** Open P&L (swap included) per strategy id, null for positions no strategy claimed. */
export function floatingByStrategy(positions: LivePositionRow[]): Map<string | null, number> {
  const out = new Map<string | null, number>();
  for (const p of positions) {
    const key = p.strategyId ?? null;
    out.set(key, (out.get(key) ?? 0) + openPnl(p));
  }
  return out;
}

export type HomeRange = "7d" | "mtd" | "ytd" | "all";
export const HOME_RANGES: ReadonlyArray<{ key: HomeRange; label: string }> = [
  { key: "7d", label: "7D" },
  { key: "mtd", label: "MTD" },
  { key: "ytd", label: "YTD" },
  { key: "all", label: "All" },
];

/** The first UTC day (YYYY-MM-DD) a range covers; null for all. 7D is today and the six days before. */
export function rangeFirstDay(range: HomeRange, now: number): string | null {
  const d = new Date(now);
  if (range === "all") return null;
  if (range === "mtd") return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
  if (range === "ytd") return `${d.getUTCFullYear()}-01-01`;
  return new Date(sevenDayStart(now)).toISOString().slice(0, 10);
}

/** A strategy with no close and no open position yet: every period at zero. */
export function emptyPeriods(key: string | null): StrategyPeriods {
  return { key, today: 0, todayRealized: 0, floating: 0, d7: 0, mtd: 0, all: 0, maxDd: 0, trades: 0, wins: 0, losses: 0, winRate: null, lastTs: null };
}

/**
 * One line per strategy for the strategy table: every roster strategy (zeros when it has not
 * traded), then closes whose strategy left the roster, then the unattributed bucket, so the
 * column sums equal the account.
 */
export function strategyLines(rows: readonly StrategyRow[], periods: ReadonlyMap<string | null, StrategyPeriods>): Array<{ key: string | null; row: StrategyRow | null; periods: StrategyPeriods }> {
  const known = new Set(rows.map((r) => r.strategyId));
  return [
    ...rows.map((row) => ({ key: row.strategyId as string | null, row: row as StrategyRow | null, periods: periods.get(row.strategyId) ?? emptyPeriods(row.strategyId) })),
    ...[...periods.values()].filter((p) => p.key == null || !known.has(p.key)).map((p) => ({ key: p.key, row: null, periods: p })),
  ];
}
