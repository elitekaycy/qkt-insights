import type { Db } from "./db.js";
import { tradePnls } from "./analytics.js";

export interface InstanceRow { id: string; name: string | null; firstSeen: number; lastSeen: number; lastSeq: number }
export interface StrategyRow { strategyId: string; firstSeen: number; lastSeen: number; equity: number | null; startingBalance: number | null }
export interface OrderRow { orderId: string; strategyId: string | null; symbol: string | null; side: string | null; type: string | null; state: string; qty: number | null; cumQty: number; avgPrice: number | null; createdTs: number; updatedTs: number }
export interface TradeRow { id: string; strategyId: string | null; ts: number; payload: unknown }
export interface SearchHit { id: string; instanceId: string; type: string; ts: number; payload: unknown }
export interface EquityPoint { ts: number; equity: number; realized: number; unrealized: number }
export interface HealthRow { instanceId: string; lastSeen: number; lastSeq: number; strategies: number }

export function listInstances(db: Db): InstanceRow[] {
  return db.prepare("SELECT id, name, first_seen firstSeen, last_seen lastSeen, last_seq lastSeq FROM instances ORDER BY id").all() as InstanceRow[];
}

export function listStrategies(db: Db, instanceId: string): StrategyRow[] {
  return db.prepare(
    "SELECT strategy_id strategyId, first_seen firstSeen, last_seen lastSeen, equity, starting_balance startingBalance FROM strategies WHERE instance_id=? ORDER BY strategy_id",
  ).all(instanceId) as StrategyRow[];
}

export function listOrders(db: Db, f: { instanceId: string; strategyId?: string; symbol?: string; state?: string; limit: number }): OrderRow[] {
  const cl: string[] = ["instance_id=@instanceId"];
  if (f.strategyId) cl.push("strategy_id=@strategyId");
  if (f.symbol) cl.push("symbol=@symbol");
  if (f.state) cl.push("state=@state");
  return db.prepare(
    `SELECT order_id orderId, strategy_id strategyId, symbol, side, type, state, qty, cum_qty cumQty, avg_price avgPrice, created_ts createdTs, updated_ts updatedTs
     FROM orders WHERE ${cl.join(" AND ")} ORDER BY updated_ts DESC LIMIT @limit`,
  ).all(f) as OrderRow[];
}

// qkt's TradeEvent carries no strategyId; attribute through the originating order.
const TRADE_STRATEGY =
  "COALESCE(e.strategy_id, (SELECT o.strategy_id FROM orders o WHERE o.instance_id=e.instance_id AND o.order_id=json_extract(e.payload,'$.orderId')))";

export function listTrades(db: Db, f: { instanceId: string; strategyId?: string; symbol?: string; limit: number }): TradeRow[] {
  const cl: string[] = ["e.instance_id=@instanceId", "e.type='trade'"];
  if (f.strategyId) cl.push(`${TRADE_STRATEGY}=@strategyId`);
  if (f.symbol) cl.push("json_extract(e.payload,'$.symbol')=@symbol");
  const rows = db.prepare(
    `SELECT e.id, ${TRADE_STRATEGY} strategyId, e.ts, e.payload FROM events e WHERE ${cl.join(" AND ")} ORDER BY e.ts DESC LIMIT @limit`,
  ).all(f) as any[];
  return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}

export function searchEvents(db: Db, f: { q: string; instanceId?: string; limit: number }): SearchHit[] {
  const rows = db.prepare(
    `SELECT e.id, e.instance_id instanceId, e.type, e.ts, e.payload
     FROM events_fts f JOIN events e ON e.rowid = f.event_rowid
     WHERE events_fts MATCH @q ${f.instanceId ? "AND e.instance_id=@instanceId" : ""}
     ORDER BY e.ts DESC LIMIT @limit`,
  ).all(f) as any[];
  return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}

export function equityCurve(db: Db, f: { instanceId: string; strategyId: string; from?: number; to?: number }): EquityPoint[] {
  const cl: string[] = ["instance_id=@instanceId", "strategy_id=@strategyId"];
  if (f.from != null) cl.push("ts>=@from");
  if (f.to != null) cl.push("ts<=@to");
  return db.prepare(
    `SELECT ts, equity, realized, unrealized FROM equity_snapshots WHERE ${cl.join(" AND ")} ORDER BY ts ASC`,
  ).all(f) as EquityPoint[];
}

export function instanceHealth(db: Db): HealthRow[] {
  return db.prepare(
    `SELECT i.id instanceId, i.last_seen lastSeen, i.last_seq lastSeq,
            (SELECT COUNT(*) FROM strategies s WHERE s.instance_id=i.id) strategies
     FROM instances i ORDER BY i.id`,
  ).all() as HealthRow[];
}

export interface LogRow { id: string; strategyId: string | null; level: string; logger: string; message: string; ts: number }

export function listLogs(db: Db, f: { instanceId: string; strategyId?: string; level?: string; q?: string; limit: number }): LogRow[] {
  if (f.q) {
    const rows = db.prepare(
      `SELECT l.id, l.strategy_id strategyId, l.level, l.logger, l.message, l.ts
       FROM logs_fts ft JOIN logs l ON l.rowid = ft.log_rowid
       WHERE logs_fts MATCH @q AND l.instance_id=@instanceId
         ${f.strategyId ? "AND l.strategy_id=@strategyId" : ""}
         ${f.level ? "AND l.level=@level" : ""}
       ORDER BY l.ts DESC LIMIT @limit`,
    ).all(f) as LogRow[];
    return rows;
  }
  const cl: string[] = ["instance_id=@instanceId"];
  if (f.strategyId) cl.push("strategy_id=@strategyId");
  if (f.level) cl.push("level=@level");
  return db.prepare(
    `SELECT id, strategy_id strategyId, level, logger, message, ts FROM logs
     WHERE ${cl.join(" AND ")} ORDER BY ts DESC LIMIT @limit`,
  ).all(f) as LogRow[];
}

export interface StrategyStats {
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  volume: number;
  realizedPnl: number | null;
  equity: number | null;
  startingBalance: number | null;
  returnPct: number | null;
  winRate: number | null;
  maxDrawdownPct: number | null;
  sharpe: number | null;
}

/**
 * Per-strategy performance summary derived from stored trades and equity snapshots.
 *
 * - winRate: share of winning trades, from the same per-trade P&L series the
 *   performance report uses (exact trade.closed rows when they cover the whole
 *   history, realized-delta approximation otherwise) — the overview and
 *   performance tabs must never disagree on the same number.
 * - sharpe: annualized from end-of-day equity returns (sqrt(252)); null when fewer
 *   than 5 daily points exist — too little data to pretend.
 * - maxDrawdownPct: largest peak-to-trough equity drop over the snapshot series.
 */
export function strategyStats(db: Db, f: { instanceId: string; strategyId: string }): StrategyStats {
  const t: any = db.prepare(
    `SELECT COUNT(*) c,
            SUM(CASE WHEN json_extract(payload,'$.side')='BUY' THEN 1 ELSE 0 END) buys,
            SUM(CASE WHEN json_extract(payload,'$.side')='SELL' THEN 1 ELSE 0 END) sells,
            COALESCE(SUM(json_extract(payload,'$.qty')),0) vol
     FROM events e WHERE e.instance_id=@instanceId AND e.type='trade'
       AND COALESCE(e.strategy_id, (SELECT o.strategy_id FROM orders o
             WHERE o.instance_id=e.instance_id AND o.order_id=json_extract(e.payload,'$.orderId')))=@strategyId`,
  ).get(f);
  const snaps = db.prepare(
    "SELECT ts, equity, realized FROM equity_snapshots WHERE instance_id=@instanceId AND strategy_id=@strategyId ORDER BY ts ASC",
  ).all(f) as { ts: number; equity: number; realized: number }[];
  const strat: any = db.prepare(
    "SELECT equity, starting_balance sb FROM strategies WHERE instance_id=@instanceId AND strategy_id=@strategyId",
  ).get(f);

  const { pnls } = tradePnls(db, f);
  const wins = pnls.filter((d) => d > 0).length;
  const winRate = pnls.length > 0 ? wins / pnls.length : null;

  let peak = -Infinity, maxDd = 0;
  for (const s of snaps) {
    peak = Math.max(peak, s.equity);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - s.equity) / peak);
  }

  const byDay = new Map<number, number>();
  for (const s of snaps) byDay.set(Math.floor(s.ts / 86_400_000), s.equity);
  const daily = [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([, eq]) => eq);
  let sharpe: number | null = null;
  if (daily.length >= 5) {
    const rets: number[] = [];
    for (let i = 1; i < daily.length; i++) {
      const prev = daily[i - 1]!;
      if (prev !== 0) rets.push(daily[i]! / prev - 1);
    }
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
    sharpe = sd > 0 ? (mean / sd) * Math.sqrt(252) : null;
  }

  const last = snaps[snaps.length - 1];
  const sb = strat?.sb ?? null;
  const equity = strat?.equity ?? last?.equity ?? null;
  return {
    tradeCount: t?.c ?? 0,
    buyCount: t?.buys ?? 0,
    sellCount: t?.sells ?? 0,
    volume: t?.vol ?? 0,
    realizedPnl: last?.realized ?? null,
    equity,
    startingBalance: sb,
    returnPct: sb && equity != null && sb !== 0 ? (equity - sb) / sb : null,
    winRate,
    maxDrawdownPct: snaps.length > 0 ? maxDd : null,
    sharpe,
  };
}
