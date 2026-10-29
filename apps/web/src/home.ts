import type { AccountRiskRow, LiveAccount, LivePositionRow, StrategyRow } from "./api";
import { age, DASH, instrumentOf, money, openPnl, pctValue, signedMoney, ts } from "./format";
import { roundMoney } from "@qkt-insights/contract/money";

/*
 * Home's figures, as pure functions over what the API already returns: the account's live state,
 * its risk row (limits, day basis), and every close on the account. Nothing here reads React.
 */

const DAY_MS = 86_400_000;

/** The account's risk row for a live account: by its account id, then by label, then the only one. */
export function riskRowFor(account: Pick<LiveAccount, "broker" | "accountId">, rows: AccountRiskRow[]): AccountRiskRow | null {
  const identity = account.accountId ?? null;
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
  /** What used is measured from: the day-start balance (daily) or the peak or start balance (drawdown). */
  reference: number | null;
  /** used / reference in percent: the measured figure when no cap is set. */
  usedPct: number | null;
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
  const dayReference = dailyReference(row);
  const dailyUsed = row.dailyLoss.includesFloating
    ? (dayReference != null && equity != null ? Math.max(0, dayReference - equity) : row.dailyLoss.used)
    : Math.max(0, -row.dailyLoss.realizedToday);
  const use = (used: number | null, cap: number | null, base: number | null): LimitUse => ({
    used,
    cap,
    pct: used != null && cap != null && cap > 0 ? (used / cap) * 100 : null,
    reference: base,
    usedPct: used != null && base != null && base > 0 ? (used / base) * 100 : null,
  });
  return {
    daily: use(dailyUsed, row.dailyLoss.cap, dayReference),
    drawdown: use(ddUsed, row.drawdown.cap, reference ?? row.drawdown.reference),
  };
}

/** What the trading day is measured from: the day-start balance, or the higher of it and day-start equity. */
export function dailyReference(row: Pick<AccountRiskRow, "dailyLoss">): number | null {
  return row.dailyLoss.reference !== undefined ? row.dailyLoss.reference : row.dailyLoss.dayStartBalance;
}

/** Names the daily reference, e.g. "the day-start equity 50,120.00 (higher than the balance)". */
export function dailyReferenceLabel(row: Pick<AccountRiskRow, "dailyLoss">): string {
  const ref = dailyReference(row);
  if (row.dailyLoss.base !== "higher") return `the day-start balance ${money(ref)}`;
  const fromEquity = ref != null && row.dailyLoss.dayStartEquity === ref && row.dailyLoss.dayStartBalance !== ref;
  return fromEquity ? `the day-start equity ${money(ref)} (above the balance)` : `the day-start balance ${money(ref)} (at or above equity)`;
}

/** Live account state is kept in memory; an instance silent this long has none to show until it reports. */
export const SILENT_AFTER_MS = 5 * 60_000;

/** Home's line when the instance has no live account state: waiting for the first poll, or the instance went quiet. */
export function noAccountMessage(instanceId: string, lastSeen: number | null | undefined, now: number): string {
  if (lastSeen != null && now - lastSeen > SILENT_AFTER_MS) {
    return `${instanceId} last reported ${age(lastSeen)} (${ts(lastSeen)} UTC), so there is no live account state. It returns when the instance reports again; its history stays below.`;
  }
  return "No account state yet: it arrives with the next state poll from qkt.";
}

/** The daily-loss card's line under the figure: what the figure is, in words. */
export function dailyMeasured(row: Pick<AccountRiskRow, "dailyLoss">, daily: LimitUse): string {
  if (row.dailyLoss.includesFloating) {
    return dailyReference(row) == null
      ? "day-start balance not recorded yet"
      : `from ${dailyReferenceLabel(row)} to equity now`;
  }
  if (daily.used != null && daily.used > 0) return "lost today on closed trades";
  return row.dailyLoss.realizedToday > 0 ? `no loss today: closed ${signedMoney(row.dailyLoss.realizedToday)}` : "no loss today";
}

/**
 * A limit card's reading beside the account's own figure: what is left of the limit for the card,
 * how much of it is used for its info panel, e.g. { left: "3,214.11 left", used: "35.7% of the
 * 5,000.00 limit used" }, or "over the 5,000.00 limit". Null without a limit: the card then shows
 * the account figure alone.
 */
export function limitLine(use: LimitUse): { left: string; used: string; over: boolean } | null {
  if (use.cap == null) return null;
  const over = use.pct != null && use.pct >= 100;
  const used = `${use.pct == null ? DASH : pctValue(use.pct, 1)} of the ${money(use.cap)} limit used`;
  if (over) return { left: `over the ${money(use.cap)} limit`, used, over };
  return { left: `${use.used != null ? money(Math.max(0, use.cap - use.used)) : DASH} left`, used, over };
}

/** The drawdown card's line under the figure: how far below which reference equity is. */
export function drawdownMeasured(row: Pick<AccountRiskRow, "basis">, dd: LimitUse): string {
  const ref = row.basis === "static" ? "start" : "peak";
  if (dd.used == null || dd.reference == null) return `no ${ref} balance recorded yet`;
  if (dd.used === 0) return row.basis === "static" ? `at or above start ${money(dd.reference)}` : `at the peak ${money(dd.reference)}`;
  return `${money(dd.used)} below ${ref} ${money(dd.reference)}`;
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

/**
 * Why an account's floating P&L (equity - balance, the venue's figure) can differ from its listed positions: positions
 * of another system on the same account (a magic range the instance ignores) are counted but not listed, and a
 * venue that marks no position leaves its floating in equity only. Null when neither applies.
 */
export interface FloatingNote {
  /** The account's floating P&L: equity - balance. */
  account: number;
  /** Floating of the listed positions that carry a venue mark, swap included. */
  listed: number;
  /** Listed positions with a venue mark. */
  marked: number;
  /** Listed positions without a venue mark. */
  unmarked: number;
  /** Positions outside this instance; floating null when one of them has no mark. */
  outside: { count: number; floating: number | null } | null;
}

export function floatingNote(
  account: { balance: number; equity: number },
  positions: readonly LivePositionRow[],
  outside: { count: number; floating: number | null } | null | undefined,
): FloatingNote | null {
  const unmarked = positions.filter((p) => p.profit == null).length;
  const hidden = outside && outside.count > 0 ? outside : null;
  if (unmarked === 0 && !hidden) return null;
  const listed = positions.reduce((a, p) => (p.profit == null ? a : a + openPnl(p)), 0);
  return { account: account.equity - account.balance, listed, marked: positions.length - unmarked, unmarked, outside: hidden };
}

/** The note in words, e.g. "−597.30 on 1 position outside this instance · 2 listed without a venue mark". */
export function floatingNoteText(n: FloatingNote): string {
  const plural = (k: number, word: string) => `${k} ${word}${k === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (n.outside) {
    parts.push(n.outside.floating != null
      ? `${signedMoney(n.outside.floating)} on ${plural(n.outside.count, "position")} outside this instance`
      : `${plural(n.outside.count, "position")} outside this instance`);
  }
  if (n.unmarked > 0) parts.push(`${plural(n.unmarked, "listed position")} without a venue mark`);
  return parts.join(" · ");
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
