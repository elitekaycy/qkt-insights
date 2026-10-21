import type { Db } from "./db.js";
import { OUT_LEGS } from "./closedTrades.js";
import { refreshProjections } from "./projections.js";
import { statement } from "./statements.js";
import { dailyRows, strategyTotals, type DailyRow } from "./strategyDaily.js";
import { excursionsOf } from "./excursions.js";

export { OUT_LEGS };

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

/**
 * One request's analytics memo. Every aggregate rebuilds its figures from the same few
 * primitives (the closed-trade list, the equity series, the starting balance), so a bundle of
 * a dozen aggregates would otherwise run each primitive a dozen times over identical rows.
 * Analytics are synchronous, so the scope covers exactly the calls made inside `fn`.
 */
interface AnalyticsScope { db: Db; values: Map<string, unknown> }
let activeScope: AnalyticsScope | null = null;

/** Runs `fn` with the analytics primitives computed at most once per distinct filter. */
export function withAnalyticsScope<T>(db: Db, fn: () => T): T {
  if (activeScope) return fn();
  activeScope = { db, values: new Map() };
  try {
    return fn();
  } finally {
    activeScope = null;
  }
}

/** The memoized value of a primitive inside a scope; callers must treat it as read-only. */
function memo<T>(db: Db, name: string, f: { instanceId: string; strategyId?: string; from?: number; to?: number; closedPositionsOnly?: boolean }, compute: () => T): T {
  if (activeScope == null || activeScope.db !== db) return compute();
  const key = `${name}\u0000${f.instanceId}\u0000${f.strategyId ?? ""}\u0000${f.from ?? ""}\u0000${f.to ?? ""}\u0000${f.closedPositionsOnly ? 1 : 0}`;
  if (activeScope.values.has(key)) return activeScope.values.get(key) as T;
  const value = compute();
  activeScope.values.set(key, value);
  return value;
}

/**
 * Sharpe, Sortino and Calmar need at least this many end-of-day points (UTC days with a close);
 * below it they are null: a ratio from a handful of days says nothing.
 */
export const MIN_RATIO_DAYS = 20;

/**
 * The one win-rate definition: winning closed round trips over winning plus losing ones, in
 * percent. Breakeven closes (net exactly 0) are excluded; null when none was decided.
 */
export function winRatePct(wins: number, losses: number): number | null {
  return wins + losses > 0 ? (wins / (wins + losses)) * 100 : null;
}

export interface AnalyticsFilter {
  instanceId: string;
  strategyId: string;
  from?: number;
  to?: number;
  /**
   * Keep only positions fully closed by `to` (requires `to`): a partial close, or a close leg of a
   * position still open, is left out of every close-derived figure. Public views use it so no
   * aggregate can reveal a position that was open at their cutoff.
   */
  closedPositionsOnly?: boolean;
}

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
  /** End-of-day points the ratios use; they are null below MIN_RATIO_DAYS. */
  ratioDays: number;
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

/**
 * The money a strategy is measured against: the operator's declared capital
 * (STRATEGY_CAPITAL) when set, else the starting balance the daemon reported.
 */
export function strategyBase(db: Db, f: { instanceId: string; strategyId: string }): number | null {
  return memo(db, "strategyBase", { instanceId: f.instanceId, strategyId: f.strategyId }, () => {
    const row = db.prepare(
      `SELECT COALESCE(
         (SELECT capital FROM strategy_capital WHERE strategy_id=@strategyId),
         (SELECT starting_balance FROM strategies WHERE instance_id=@instanceId AND strategy_id=@strategyId)) base`,
    ).get({ instanceId: f.instanceId, strategyId: f.strategyId }) as { base: number | null };
    return row.base;
  });
}

/**
 * A snapshot's equity rebuilt from its own ledger (bind @base = strategyBase ?? 0).
 * The stored equity column is not trusted: under liveEquityBasis VENUE the daemon
 * writes the whole account's equity into every strategy's snapshot.
 */
export const SNAPSHOT_EQUITY = "(@base + realized + unrealized)";

function snapshots(db: Db, f: AnalyticsFilter): SnapRow[] {
  // Snapshot equity carries unrealized P&L of open positions, which closedPositionsOnly excludes.
  if (f.closedPositionsOnly) return [];
  return memo(db, "snapshots", f, () => snapshotRows(db, f));
}

function snapshotRows(db: Db, f: AnalyticsFilter): SnapRow[] {
  const cl = ["instance_id=@instanceId", "strategy_id=@strategyId"];
  if (f.from != null) cl.push("ts>=@from");
  if (f.to != null) cl.push("ts<=@to");
  return db.prepare(
    `SELECT ts, realized, ${SNAPSHOT_EQUITY} equity FROM equity_snapshots WHERE ${cl.join(" AND ")} ORDER BY ts ASC`,
  ).all({ ...f, base: strategyBase(db, f) ?? 0 }) as SnapRow[];
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

/** True when broker deals closed positions for this strategy — the deals source is authoritative then. */

/**
 * Predicate keeping ONE copy of a broker deal. Every qkt broker profile that
 * polls the same venue account reports the account's deals, so an instance
 * running several profiles (per-strategy magics, portfolio child accounts)
 * stores the same deal_ticket once per profile — with the copy's strategy
 * attribution occasionally guessed differently. The first-stored row is the
 * canonical one: it comes from the poller that owned the fill and attributed
 * it, so summing anything over deals without this predicate multiplies P&L by
 * the number of profiles. The flag is set when the row is stored (migration 028).
 */
export function canonicalDeal(alias: string): string {
  return `${alias}.canonical=1`;
}

/**
 * `alias.position_ticket` belongs to a position whose IN volume was fully matched by OUT legs at
 * or before @to. Reversal (INOUT) positions never qualify: their legs cannot be split into a
 * closed part and an open part. Reads the closure ranges stored per position (closedTrades.ts).
 */
export function fullyClosedPosition(alias: string): string {
  return `EXISTS (SELECT 1 FROM position_closures pc
    WHERE pc.instance_id=${alias}.instance_id AND pc.position_ticket=${alias}.position_ticket
      AND pc.from_ts<=@to AND (pc.until_ts IS NULL OR pc.until_ts>@to))`;
}

function requireCutoff(f: { to?: number; closedPositionsOnly?: boolean }): void {
  if (f.closedPositionsOnly && f.to == null) throw new Error("closedPositionsOnly needs a `to` cutoff");
}

/** Position tickets fully closed by `to` on the instance (see fullyClosedPosition). */
export function fullyClosedPositions(db: Db, f: { instanceId: string; to: number }): Set<string> {
  refreshProjections(db);
  const rows = statement(db,
    `SELECT pc.position_ticket p FROM position_closures pc
     WHERE pc.instance_id=@instanceId AND pc.from_ts<=@to AND (pc.until_ts IS NULL OR pc.until_ts>@to)
       AND EXISTS (SELECT 1 FROM deals d WHERE d.instance_id=pc.instance_id AND d.position_ticket=pc.position_ticket
                     AND d.entry IN ${OUT_LEGS} AND d.ts<=@to)`,
  ).all({ instanceId: f.instanceId, to: f.to }) as Array<{ p: string }>;
  return new Set(rows.map((r) => r.p));
}

export function hasClosingDeals(db: Db, f: { instanceId: string; strategyId: string; to?: number; closedPositionsOnly?: boolean }): boolean {
  requireCutoff(f);
  return memo(db, "hasClosingDeals", { instanceId: f.instanceId, strategyId: f.strategyId, to: f.to, closedPositionsOnly: f.closedPositionsOnly },
    () => closingDealExists(db, f));
}

function closingDealExists(db: Db, f: { instanceId: string; strategyId: string; to?: number; closedPositionsOnly?: boolean }): boolean {
  refreshProjections(db);
  const cl = ["ct.instance_id=@instanceId", "ct.strategy_id=@strategyId"];
  if (f.to != null) cl.push("ct.ts<=@to");
  if (f.closedPositionsOnly) cl.push(fullyClosedPosition("ct"));
  return statement(db, `SELECT 1 FROM closed_trades ct WHERE ${cl.join(" AND ")} LIMIT 1`)
    .get({ instanceId: f.instanceId, strategyId: f.strategyId, to: f.to }) != null;
}

/**
 * One row per closing deal (OUT/INOUT/OUT_BY), paired with its position's first
 * IN deal: entry price/time come from the IN leg, exit and realized money from
 * the closing leg. A position closed in parts yields one row per closing leg,
 * all sharing the same IN. side is the POSITION's direction (the IN side), not
 * the close leg's. realized is the closing leg's profit + commission + swap +
 * fee, PLUS its share (closed volume over opened volume) of every IN leg's
 * commission/swap/fee. Venues differ: Exness books commission on the close, The5ers
 * on both legs (2026-08-31..09-04 the entry legs carried -212 of -239 total), and
 * counting only the close leg reported EURUSD RSI fade at +72 when the venue said
 * -113. Sharing the IN costs by volume keeps a partially-closed position from
 * paying them per partial, and charges a scaled-in position for every entry. The
 * rows are the closed_trades projection.
 */
export function dealClosedTrades(db: Db, f: AnalyticsFilter): DealClosedTrade[] {
  requireCutoff(f);
  return memo(db, "dealClosedTrades", f, () => dealClosedTradeRows(db, f));
}

function dealClosedTradeRows(db: Db, f: AnalyticsFilter): DealClosedTrade[] {
  return closedTradeRows(db, f).map((r) => {
    const { strategyId: _owner, ...row } = r;
    closeDealRowid.set(row, closeDealRowid.get(r)!);
    return row;
  });
}

/** The closing deal behind each row the close readers return, for joins on the projection. */
const closeDealRowid = new WeakMap<object, number>();

/** The closed_trades rowid (closing deal) behind a row closedTradeRows or dealClosedTrades returned. */
export function closeDealOf(row: object): number | undefined {
  return closeDealRowid.get(row);
}

export interface CloseRowFilter {
  instanceId: string;
  strategyId?: string;
  /** JSON array of strategy ids the closes must belong to. */
  strategyIds?: string | null;
  from?: number;
  to?: number;
  closedPositionsOnly?: boolean;
}

/**
 * Closed trades from the closed_trades projection, oldest first (closes sharing a timestamp in
 * deal order), each with the canonical copy's owner (null when unattributed). One index range
 * scan; the engine order ids resolve per row through the orders index. The order-id lookups are
 * scalar subselects, NOT joins: several order rows can share a broker_order_id (one per broker
 * profile after a multi-profile deploy), and a join would fan each close out into one row per copy.
 */
export function closedTradeRows(db: Db, f: CloseRowFilter): Array<DealClosedTrade & { strategyId: string | null }> {
  refreshProjections(db);
  const cl = ["ct.instance_id=@instanceId"];
  if (f.strategyId != null) cl.push("ct.strategy_id=@strategyId");
  if (f.from != null) cl.push("ct.ts>=@from");
  if (f.to != null) cl.push("ct.ts<=@to");
  if (f.closedPositionsOnly) cl.push(fullyClosedPosition("ct"));
  if (f.strategyIds != null) cl.push("ct.strategy_id IN (SELECT value FROM json_each(@ids))");
  const rows = statement(db,
    `SELECT ct.deal_rowid dealRowid, ct.position_ticket orderId, ct.symbol, ct.out_side outSide, ct.in_side inSide, ct.qty,
            ct.strategy_id owner, ct.entry_price entryPrice, ct.exit_price exitPrice, ct.entry_ts entryTs, ct.ts, ct.realized,
            (SELECT eo.order_id FROM orders eo
              WHERE eo.instance_id=ct.instance_id AND eo.broker_order_id=ct.entry_order_ticket
              ORDER BY eo.created_ts ASC LIMIT 1) entryOrderId,
            (SELECT xo.order_id FROM orders xo
              WHERE xo.instance_id=ct.instance_id AND xo.broker_order_id=ct.exit_order_ticket
              ORDER BY xo.created_ts ASC LIMIT 1) exitOrderId
     FROM closed_trades ct
     WHERE ${cl.join(" AND ")}
     ORDER BY ct.ts ASC, ct.deal_rowid ASC`,
  ).all({ instanceId: f.instanceId, strategyId: f.strategyId, from: f.from, to: f.to, ids: f.strategyIds ?? null }) as any[];
  return rows.map((r) => {
    const row = {
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
      strategyId: r.owner ?? null,
    };
    closeDealRowid.set(row, r.dealRowid);
    return row;
  });
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
  f: { instanceId: string; strategyId: string; from?: number; to?: number; closedPositionsOnly?: boolean },
): StrategyEquityPoint[] {
  return memo(db, "strategyEquityCurve", f, () => strategyEquityPoints(db, f));
}

function strategyEquityPoints(
  db: Db,
  f: { instanceId: string; strategyId: string; from?: number; to?: number; closedPositionsOnly?: boolean },
): StrategyEquityPoint[] {
  // Rows stop at `to` (a later close must not anchor or extend the curve); `from` filters after
  // the cumulative sum so a window still shows true levels.
  const rows = closes(db, { instanceId: f.instanceId, strategyId: f.strategyId, to: f.to, closedPositionsOnly: f.closedPositionsOnly });
  if (rows.length === 0) return [];
  const sb = strategyBase(db, f) ?? 0;
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
  // trade.closed rows carry no position identity, so a partial close cannot be told from a full one.
  if (f.closedPositionsOnly) return [];
  return memo(db, "ledgerCloses", f, () => {
    const cl = ["instance_id=@instanceId", "strategy_id=@strategyId"];
    if (f.from != null) cl.push("ts>=@from");
    if (f.to != null) cl.push("ts<=@to");
    return db.prepare(
      `SELECT ts, symbol, side, qty, price, realized, entry_ts entryTs, order_id orderId FROM trade_closes WHERE ${cl.join(" AND ")} ORDER BY ts ASC`,
    ).all(f) as ClosedTradeRow[];
  });
}

/**
 * Whether the strategy's figures come from broker deals. Under closedPositionsOnly any deal by
 * `to` counts: a strategy whose only positions are still open must not fall back to engine
 * closes or equity snapshots, which would expose a partial close or unrealized equity.
 */
function dealBacked(db: Db, f: AnalyticsFilter): boolean {
  if (!f.closedPositionsOnly) return hasClosingDeals(db, f);
  requireCutoff(f);
  return memo(db, "dealBacked", f, () => db.prepare("SELECT 1 FROM deals WHERE instance_id=? AND strategy_id=? AND ts<=? LIMIT 1").get(f.instanceId, f.strategyId, f.to) != null);
}

/** Per-trade rows oldest-first: broker deals when they exist, else trade.closed rows. */
function closes(db: Db, f: AnalyticsFilter): ClosedTradeRow[] {
  return dealBacked(db, f) ? dealClosedTrades(db, f) : ledgerCloses(db, f);
}

/** The money-over-time series: the deals-rebuilt curve when it exists, else equity snapshots. */
function series(db: Db, f: AnalyticsFilter): SnapRow[] {
  return dealBacked(db, f) ? strategyEquityCurve(db, f) : snapshots(db, f);
}

/** Every closed trade in the range, newest first — the rows behind the performance numbers. */
export function closedTrades(db: Db, f: AnalyticsFilter): ClosedTradeRow[] {
  return [...closes(db, f)].reverse();
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
  return memo(db, "tradePnls", f, () => tradePnlSeries(db, f));
}

function tradePnlSeries(db: Db, f: AnalyticsFilter): { pnls: number[]; exact: boolean } {
  if (dealBacked(db, f)) {
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

/**
 * The traded instrument behind a venue symbol: qkt prefixes each symbol with the broker profile
 * that saw it ("ICM_S05:XAUUSD"), so one instrument on one account arrives under several names.
 * e.g. "ICM_S05:XAUUSD" -> "XAUUSD", "XAUUSD" -> "XAUUSD".
 */
export function instrumentOf(symbol: string | null | undefined): string {
  if (!symbol) return "";
  const i = symbol.lastIndexOf(":");
  return i >= 0 ? symbol.slice(i + 1) : symbol;
}

function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function dailyNets(db: Db, f: AnalyticsFilter): DayNet[] {
  return memo(db, "dailyNets", f, () => dayNets(db, f));
}

/**
 * The strategy_daily rows that answer `f`, when they can: the projection holds whole days of the
 * whole history, so a `from` window, a cutoff before the newest close, or closedPositionsOnly
 * (which drops closes per cutoff) is computed from the closes instead. Null also when the source
 * the strategy's figures come from has no closes (the snapshot fallback applies).
 */
function projectedDays(db: Db, f: AnalyticsFilter): { rows: DailyRow[]; dealBacked: boolean } | null {
  if (f.closedPositionsOnly || f.from != null) return null;
  const deal = dealBacked(db, f);
  refreshProjections(db);
  const totals = strategyTotals(db, f.instanceId, f.strategyId, deal ? "deal" : "ledger");
  if (!totals || (f.to != null && f.to < totals.lastTs)) return null;
  return { rows: dailyRows(db, f.instanceId, f.strategyId, deal ? "deal" : "ledger"), dealBacked: deal };
}

function dayNets(db: Db, f: AnalyticsFilter): DayNet[] {
  const projected = projectedDays(db, f);
  if (projected) return projected.rows.map((d) => ({ day: d.day, net: d.net, trades: d.trades }));
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

  // Ratios from end-of-day equity returns; null under MIN_RATIO_DAYS daily points (too little to pretend).
  const byDay = new Map<string, number>();
  for (const s of snaps) byDay.set(utcDay(s.ts), s.equity);
  const dailyEq = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, eq]) => eq);
  let sharpe: number | null = null, sortino: number | null = null, calmar: number | null = null;
  if (dailyEq.length >= MIN_RATIO_DAYS) {
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
    ratioDays: dailyEq.length,
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
  /** bySymbol only: the venue symbols (profile-prefixed) folded into this instrument. */
  venues?: string[];
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
    const cur = map.get(key) ?? { key, net: 0, trades: 0, wins: 0, se: null, ...(map === bySymbol ? { venues: [] } : {}) };
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
    acc(bySymbol, instrumentOf(r.symbol), r);
    const row = bySymbol.get(instrumentOf(r.symbol))!;
    if (!row.venues!.includes(r.symbol)) row.venues!.push(r.symbol);
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
  /** Percentage 0-100 (winRatePct); null when every close was breakeven. */
  winRate: number | null;
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
  const cells = new Map<number, DowHourCell & { wins: number; losses: number }>();
  for (const r of rows) {
    const d = new Date(r.ts);
    const dow = (d.getUTCDay() + 6) % 7;
    const hour = d.getUTCHours();
    const k = dow * 24 + hour;
    const cur = cells.get(k) ?? { dow, hour, n: 0, net: 0, mean: 0, winRate: null, wins: 0, losses: 0 };
    cur.n++;
    cur.net += r.realized;
    if (r.realized > 0) cur.wins++;
    else if (r.realized < 0) cur.losses++;
    cells.set(k, cur);
  }
  return [...cells.values()]
    .sort((a, b) => a.dow * 24 + a.hour - (b.dow * 24 + b.hour))
    .map(({ wins, losses, ...c }) => ({ ...c, mean: c.net / c.n, winRate: winRatePct(wins, losses) }));
}

export interface RollingPoint {
  day: string;
  /** Annualized (√252) Sharpe over the window's daily equity returns; null during warmup. */
  sharpe: number | null;
  /** Percentage of traded days in the window that were net-positive (winning days, not trades); null when none traded. */
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
  const eqByDay = endOfDayEquity(db, f);
  if (eqByDay.size === 0) return [];
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

/**
 * Last equity of each UTC day in the money-over-time series (series()). For the deals-rebuilt
 * curve that is the starting base plus the running realized total at the day's last close, with
 * the base itself on the day the first traded position opened: strategy_daily holds the running
 * totals, so this is O(days). Snapshot series are read as before.
 */
function endOfDayEquity(db: Db, f: AnalyticsFilter): Map<string, number> {
  const projected = projectedDays(db, f);
  if (projected?.dealBacked) {
    const totals = strategyTotals(db, f.instanceId, f.strategyId, "deal")!;
    const sb = strategyBase(db, f) ?? 0;
    const out = new Map<string, number>();
    const anchor = totals.firstEntryTs ?? totals.firstTs;
    if (f.to == null || anchor <= f.to) out.set(utcDay(anchor), sb);
    for (const d of projected.rows) out.set(d.day, sb + d.closeCum);
    return out;
  }
  const out = new Map<string, number>();
  for (const s of series(db, f)) out.set(utcDay(s.ts), s.equity);
  return out;
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
 * Gross-vs-cost decomposition per UTC month of the leg that booked it. Deals
 * source only — trade_closes rows carry realized with no cost split — so this is
 * null for paper instances; the payload's absence tells the UI why. Every leg
 * counts: a venue that books commission on the opening leg (The5ers) would
 * otherwise show half its costs, and gross profit is unaffected because IN legs
 * carry profit 0. `trades` counts closing legs only.
 */
export function costDecomposition(db: Db, f: AnalyticsFilter): CostDecomposition | null {
  if (!hasClosingDeals(db, f)) return null;
  const cl = ["instance_id=@instanceId", "strategy_id=@strategyId", canonicalDeal("deals")];
  if (f.from != null) cl.push("ts>=@from");
  if (f.to != null) cl.push("ts<=@to");
  if (f.closedPositionsOnly) cl.push(fullyClosedPosition("deals"));
  const rows = db.prepare(
    `SELECT strftime('%Y-%m', ts/1000, 'unixepoch') key,
            SUM(profit) grossProfit,
            SUM(COALESCE(commission,0)) commission,
            SUM(COALESCE(swap,0)) swap,
            SUM(COALESCE(fee,0)) fee,
            SUM(profit + COALESCE(commission,0) + COALESCE(swap,0) + COALESCE(fee,0)) net,
            SUM(CASE WHEN entry IN ${OUT_LEGS} THEN 1 ELSE 0 END) trades
     FROM deals WHERE ${cl.join(" AND ")}
     GROUP BY key ORDER BY key ASC`,
  ).all({ instanceId: f.instanceId, strategyId: f.strategyId, from: f.from, to: f.to }) as CostRow[];
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
  /** bySymbol only: the venue symbols (profile-prefixed) folded into this instrument. */
  venues?: string[];
  net: number;
  trades: number;
  /** Percentage 0-100 (winRatePct); null when every close was breakeven. */
  winRate: number | null;
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
 * Where the money comes from: ranked net contribution by instrument and by
 * position direction, each row carrying expectancy and n so size-driven
 * contribution is distinguishable from per-trade edge. share is signed —
 * a profitable symbol inside a losing total reports a negative share.
 */
export function contributionRanking(db: Db, f: AnalyticsFilter): ContributionRanking | null {
  const rows = closes(db, f);
  if (rows.length === 0) return null;
  const totalNet = rows.reduce((a, r) => a + r.realized, 0);
  const build = (key: (r: ClosedTradeRow) => string, venues: boolean): ContributionRow[] => {
    const m = new Map<string, { net: number; trades: number; wins: number; losses: number; venues: Set<string> }>();
    for (const r of rows) {
      const k = key(r);
      const cur = m.get(k) ?? { net: 0, trades: 0, wins: 0, losses: 0, venues: new Set<string>() };
      cur.net += r.realized;
      cur.trades++;
      if (r.realized > 0) cur.wins++;
      else if (r.realized < 0) cur.losses++;
      cur.venues.add(r.symbol);
      m.set(k, cur);
    }
    return [...m.entries()]
      .map(([k, v]) => ({
        key: k,
        ...(venues ? { venues: [...v.venues] } : {}),
        net: v.net,
        trades: v.trades,
        winRate: winRatePct(v.wins, v.losses),
        expectancy: v.net / v.trades,
        share: totalNet !== 0 ? v.net / totalNet : null,
      }))
      .sort((a, b) => b.net - a.net);
  };
  return { bySymbol: build((r) => instrumentOf(r.symbol), true), byDirection: build((r) => r.side, false), totalNet };
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
  /**
   * Median of exit P&L / MFE over winning trades that had a favorable excursion. A mean over all
   * trades is meaningless: a loser with a tiny MFE scores -900%.
   */
  medianWinnerCapturePct: number | null;
  /** Winning trades behind the median. */
  winnersWithCapture: number;
  sampled: true;
}

/**
 * Sampled MAE/MFE from the broker position poll. Values between polls are not
 * observed, so coverage and the sampled flag are part of the result contract.
 * Each close's lowest and highest mark inside its held window (entry to this close; a ticket
 * closed in parts is measured once per close) come from the position_excursions projection.
 */
export function excursionStats(db: Db, f: AnalyticsFilter): ExcursionStats | null {
  if (!hasClosingDeals(db, f)) return null;
  const trades = dealClosedTrades(db, f);
  const marks = excursionsOf(db, trades.map((t) => closeDealRowid.get(t)!));
  const rows: ExcursionRow[] = [];
  for (const trade of trades) {
    const m = marks.get(closeDealRowid.get(trade)!);
    if (!trade.orderId || m == null || m.marks === 0) continue;
    const mae = Math.min(m.lowest ?? 0, 0);
    const mfe = Math.max(m.highest ?? 0, 0);
    rows.push({
      ticket: trade.orderId,
      symbol: trade.symbol,
      side: trade.side,
      ts: trade.ts,
      exitPnl: trade.realized,
      mae,
      mfe,
      capturePct: mfe > 0 ? (trade.realized / mfe) * 100 : null,
      observations: m.marks,
    });
  }
  if (rows.length === 0) return null;
  const captures = rows.filter((x) => x.exitPnl > 0).map((x) => x.capturePct)
    .filter((x): x is number => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  const mid = Math.floor(captures.length / 2);
  return {
    rows,
    closedTrades: trades.length,
    sampledTrades: rows.length,
    coveragePct: trades.length > 0 ? (rows.length / trades.length) * 100 : 0,
    averageMae: rows.reduce((a, x) => a + x.mae, 0) / rows.length,
    averageMfe: rows.reduce((a, x) => a + x.mfe, 0) / rows.length,
    medianWinnerCapturePct: captures.length === 0 ? null : captures.length % 2 ? captures[mid]! : (captures[mid - 1]! + captures[mid]!) / 2,
    winnersWithCapture: captures.length,
    sampled: true,
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
