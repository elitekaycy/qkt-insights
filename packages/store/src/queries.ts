import type { Db } from "./db.js";

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

export function listTrades(db: Db, f: { instanceId: string; strategyId?: string; symbol?: string; limit: number }): TradeRow[] {
  const cl: string[] = ["instance_id=@instanceId", "type='trade'"];
  if (f.strategyId) cl.push("strategy_id=@strategyId");
  if (f.symbol) cl.push("json_extract(payload,'$.symbol')=@symbol");
  const rows = db.prepare(
    `SELECT id, strategy_id strategyId, ts, payload FROM events WHERE ${cl.join(" AND ")} ORDER BY ts DESC LIMIT @limit`,
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
