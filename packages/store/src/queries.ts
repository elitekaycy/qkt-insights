import type { Db } from "./db.js";
import { dealClosedTrades, hasClosingDeals, strategyEquityCurve, tradePnls, type StrategyEquityPoint } from "./analytics.js";

export interface InstanceRow { id: string; name: string | null; firstSeen: number; lastSeen: number; lastSeq: number }
export interface StrategyRow { strategyId: string; firstSeen: number; lastSeen: number; startingBalance: number | null; metadata: Record<string, unknown> | null; realizedNet: number | null; dealCount: number }
export interface OrderRow { orderId: string; strategyId: string | null; symbol: string | null; side: string | null; type: string | null; state: string; qty: number | null; cumQty: number; avgPrice: number | null; createdTs: number; updatedTs: number }
export interface TradeRow { id: string; strategyId: string | null; ts: number; payload: unknown }
export interface SearchHit { id: string; instanceId: string; type: string; ts: number; payload: unknown }
export interface EquityPoint { ts: number; equity: number; realized: number; unrealized: number }
export interface HealthRow { instanceId: string; lastSeen: number; lastSeq: number; strategies: number; insightsSent: number | null; insightsFailed: number | null; insightsDropped: number | null; insightsQueued: number | null; insightsJournalEnabled: number | null; insightsJournalPending: number | null; insightsHealthTs: number | null }
export interface CurrentPositionRow {
  broker: string; ticket: string; symbol: string; side: string; qty: number; entryPrice: number;
  currentPrice: number | null; profit: number | null; swap: number | null; openedAt: number | null;
  strategyId: string | null; lastSeen: number;
}
export interface RiskEventRow { id: string; strategyId: string | null; kind: string; reason: string | null; symbol: string | null; side: string | null; qty: number | null; ts: number; payload: unknown }
export interface PortfolioEquityRow { portfolioId: string; ts: number; equity: number | null; realized: number | null; unrealized: number | null; payload: unknown }
export interface IngestObservationRow {
  id: number; instanceId: string; kind: string; eventId: string | null; type: string | null;
  seq: number | null; previousSeq: number | null; expectedSeq: number | null; ts: number; detail: string | null;
}

export function listInstances(db: Db): InstanceRow[] {
  return db.prepare("SELECT id, name, first_seen firstSeen, last_seen lastSeen, last_seq lastSeq FROM instances ORDER BY id").all() as InstanceRow[];
}

export function listStrategies(db: Db, instanceId: string): StrategyRow[] {
  // realizedNet and dealCount come from the same dealClosedTrades rows every
  // other analytics number uses, so a card and its detail page can never disagree.
  const rows = db.prepare(
    `SELECT strategy_id strategyId, first_seen firstSeen, last_seen lastSeen, starting_balance startingBalance, metadata
     FROM strategies WHERE instance_id=? ORDER BY strategy_id`,
  ).all(instanceId) as Array<Omit<StrategyRow, "realizedNet" | "dealCount" | "metadata"> & { metadata: string | null }>;
  return rows.map((r) => {
    const closes = dealClosedTrades(db, { instanceId, strategyId: r.strategyId });
    const metadata = typeof r.metadata === "string" ? JSON.parse(r.metadata) as Record<string, unknown> : null;
    return {
      ...r,
      metadata,
      realizedNet: closes.length > 0 ? closes.reduce((a, c) => a + c.realized, 0) : null,
      dealCount: closes.length,
    };
  });
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

/**
 * The equity series, downsampled for charting. Strategies with closing broker
 * deals serve the deals-rebuilt curve (starting balance + cumulative realized —
 * broker truth); paper/backtest strategies keep the snapshot series. Either way,
 * when the range holds more than [points] rows (default 1000), the range is
 * cut into [points] equal time buckets and the LAST point of each bucket is kept;
 * every returned point is a real stored value, never an average. Intra-bucket
 * wiggles are invisible at chart resolution; analytics (drawdown, Sharpe) always read
 * the full series server-side, so the numbers stay exact.
 */
export function equityCurve(
  db: Db,
  f: { instanceId: string; strategyId: string; from?: number; to?: number; points?: number },
): EquityPoint[] {
  if (hasClosingDeals(db, f)) {
    const pts = strategyEquityCurve(db, f);
    const points = Math.max(2, f.points ?? 1000);
    if (pts.length <= points) return pts;
    const lo = pts[0]!.ts;
    const bucket = Math.max(1, Math.ceil((pts[pts.length - 1]!.ts - lo + 1) / points));
    const last = new Map<number, StrategyEquityPoint>();
    for (const p of pts) last.set(Math.floor((p.ts - lo) / bucket), p);
    return [...last.values()];
  }
  const cl: string[] = ["instance_id=@instanceId", "strategy_id=@strategyId"];
  if (f.from != null) cl.push("ts>=@from");
  if (f.to != null) cl.push("ts<=@to");
  const where = cl.join(" AND ");
  const points = Math.max(2, f.points ?? 1000);

  const span: any = db.prepare(
    `SELECT COUNT(*) n, MIN(ts) lo, MAX(ts) hi FROM equity_snapshots WHERE ${where}`,
  ).get(f);
  if (!span || span.n <= points) {
    return db.prepare(
      `SELECT ts, equity, realized, unrealized FROM equity_snapshots WHERE ${where} ORDER BY ts ASC`,
    ).all(f) as EquityPoint[];
  }

  const bucket = Math.max(1, Math.ceil((span.hi - span.lo + 1) / points));
  return db.prepare(
    `SELECT ts, equity, realized, unrealized FROM equity_snapshots
     WHERE ${where} AND ts IN (
       SELECT MAX(ts) FROM equity_snapshots WHERE ${where} GROUP BY CAST((ts - @lo) / @bucket AS INTEGER)
     )
     ORDER BY ts ASC`,
  ).all({ ...f, lo: span.lo, bucket }) as EquityPoint[];
}

export function instanceHealth(db: Db): HealthRow[] {
  return db.prepare(
    `SELECT i.id instanceId, i.last_seen lastSeen, i.last_seq lastSeq,
            (SELECT COUNT(*) FROM strategies s WHERE s.instance_id=i.id) strategies,
            json_extract(h.payload, '$.sent') insightsSent,
            json_extract(h.payload, '$.failed') insightsFailed,
            json_extract(h.payload, '$.dropped') insightsDropped,
            json_extract(h.payload, '$.queued') insightsQueued,
            json_extract(h.payload, '$.journalEnabled') insightsJournalEnabled,
            json_extract(h.payload, '$.journalPending') insightsJournalPending,
            h.ts insightsHealthTs
     FROM instances i
     LEFT JOIN instance_health h ON h.instance_id = i.id
     ORDER BY i.id`,
  ).all() as HealthRow[];
}

export function listCurrentPositions(db: Db, f: { instanceId: string; strategyId?: string; symbol?: string }): CurrentPositionRow[] {
  const cl: string[] = ["instance_id=@instanceId"];
  if (f.strategyId) cl.push("strategy_id=@strategyId");
  if (f.symbol) cl.push("symbol=@symbol");
  return db.prepare(
    `SELECT broker, ticket, symbol, side, qty, entry_price entryPrice, current_price currentPrice,
            profit, swap, opened_at openedAt, strategy_id strategyId, last_seen lastSeen
     FROM positions_current WHERE ${cl.join(" AND ")} ORDER BY last_seen DESC, broker, ticket`,
  ).all(f) as CurrentPositionRow[];
}

export function listRiskEvents(db: Db, f: { instanceId: string; strategyId?: string; limit: number }): RiskEventRow[] {
  const cl: string[] = ["instance_id=@instanceId"];
  if (f.strategyId) cl.push("strategy_id=@strategyId");
  const rows = db.prepare(
    `SELECT event_id id, strategy_id strategyId, kind, reason, symbol, side, qty, ts, payload
     FROM risk_events WHERE ${cl.join(" AND ")} ORDER BY ts DESC LIMIT @limit`,
  ).all(f) as Array<Omit<RiskEventRow, "payload"> & { payload: string }>;
  return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}

export function listPortfolioEquity(db: Db, f: { instanceId: string; portfolioId: string; limit: number }): PortfolioEquityRow[] {
  const rows = db.prepare(
    `SELECT portfolio_id portfolioId, ts, equity, realized, unrealized, payload
     FROM portfolio_equity WHERE instance_id=@instanceId AND portfolio_id=@portfolioId
     ORDER BY ts ASC LIMIT @limit`,
  ).all(f) as Array<Omit<PortfolioEquityRow, "payload"> & { payload: string }>;
  return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}

export function listIngestObservations(
  db: Db,
  f: { instanceId: string; kind?: string; sinceTs?: number; limit: number },
): IngestObservationRow[] {
  const cl: string[] = ["instance_id=@instanceId"];
  if (f.kind) cl.push("kind=@kind");
  if (f.sinceTs != null) cl.push("ts>=@sinceTs");
  return db.prepare(
    `SELECT id, instance_id instanceId, kind, event_id eventId, type, seq,
            previous_seq previousSeq, expected_seq expectedSeq, ts, detail
     FROM ingest_observations WHERE ${cl.join(" AND ")}
     ORDER BY id DESC LIMIT @limit`,
  ).all(f) as IngestObservationRow[];
}

export function ingestAck(db: Db, instanceId: string, sinceTs: number, limit = 100): {
  instanceId: string; lastSeq: number | null; observations: IngestObservationRow[];
} {
  const row = db.prepare("SELECT last_seq lastSeq FROM instances WHERE id=?").get(instanceId) as { lastSeq: number } | undefined;
  return {
    instanceId,
    lastSeq: row?.lastSeq ?? null,
    observations: listIngestObservations(db, { instanceId, sinceTs, limit }),
  };
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

export interface DealRow {
  id: string; broker: string; dealTicket: string; positionTicket: string | null; orderTicket: string | null;
  symbol: string | null; side: string | null; entry: string | null; qty: number | null; price: number | null;
  profit: number | null; commission: number | null; swap: number | null;
  fee: number | null; magic: number | null;
  comment: string | null; strategyId: string | null; ts: number;
}

export function listDeals(db: Db, f: { instanceId: string; strategyId?: string; limit: number; before?: number }): DealRow[] {
  const cl: string[] = ["instance_id=@instanceId"];
  if (f.strategyId) cl.push("strategy_id=@strategyId");
  if (f.before != null) cl.push("ts<@before");
  return db.prepare(
    `SELECT id, broker, deal_ticket dealTicket, position_ticket positionTicket, order_ticket orderTicket,
            symbol, side, entry, qty, price, profit, commission, swap, fee, magic, comment, strategy_id strategyId, ts
     FROM deals WHERE ${cl.join(" AND ")} ORDER BY ts DESC LIMIT @limit`,
  ).all(f) as DealRow[];
}

export interface AccountEquityPoint { broker: string; minuteTs: number; balance: number | null; equity: number | null; openProfit: number | null }

export function accountEquity(db: Db, f: { instanceId: string; from?: number; to?: number }): AccountEquityPoint[] {
  const cl: string[] = ["instance_id=@instanceId"];
  if (f.from != null) cl.push("minute_ts>=@from");
  if (f.to != null) cl.push("minute_ts<=@to");
  return db.prepare(
    `SELECT broker, minute_ts minuteTs, balance, equity, open_profit openProfit
     FROM account_equity WHERE ${cl.join(" AND ")} ORDER BY minute_ts ASC`,
  ).all(f) as AccountEquityPoint[];
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
 * Per-strategy performance summary. Broker deals are ground truth when they
 * exist; the paper ledger (snapshots + tradePnls) covers everything else.
 *
 * - tradeCount/realizedPnl/winRate: from dealClosedTrades — the same rows the
 *   performance report uses, so the overview and performance tabs must never
 *   disagree on the same number. winRate skips zero-P&L closes, like the report.
 * - maxDrawdownPct/sharpe: over the deals-rebuilt equity curve (else snapshots);
 *   sharpe is annualized from end-of-day returns (sqrt(252)), null under 5 daily
 *   points — too little data to pretend.
 * - equity/startingBalance: with deals, equity = starting balance + realized,
 *   always current because every close updates it. Without deals they come from
 *   ledger snapshots only while fresh (newest younger than 10 minutes vs [now]);
 *   qkt no longer emits snapshot.equity, so an old figure would be a frozen lie.
 */
export function strategyStats(db: Db, f: { instanceId: string; strategyId: string }, now = Date.now()): StrategyStats {
  const t: any = db.prepare(
    `SELECT COUNT(*) c,
            SUM(CASE WHEN json_extract(payload,'$.side')='BUY' THEN 1 ELSE 0 END) buys,
            SUM(CASE WHEN json_extract(payload,'$.side')='SELL' THEN 1 ELSE 0 END) sells,
            COALESCE(SUM(json_extract(payload,'$.qty')),0) vol
     FROM events e WHERE e.instance_id=@instanceId AND e.type='trade'
       AND COALESCE(e.strategy_id, (SELECT o.strategy_id FROM orders o
             WHERE o.instance_id=e.instance_id AND o.order_id=json_extract(e.payload,'$.orderId')))=@strategyId`,
  ).get(f);
  const strat: any = db.prepare(
    "SELECT starting_balance sb FROM strategies WHERE instance_id=@instanceId AND strategy_id=@strategyId",
  ).get(f);

  const dealRows = dealClosedTrades(db, f);
  const fromDeals = dealRows.length > 0;
  const snaps = fromDeals
    ? strategyEquityCurve(db, f)
    : db.prepare(
        "SELECT ts, equity, realized FROM equity_snapshots WHERE instance_id=@instanceId AND strategy_id=@strategyId ORDER BY ts ASC",
      ).all(f) as { ts: number; equity: number; realized: number }[];

  const pnls = fromDeals
    ? dealRows.map((c) => c.realized).filter((r) => r !== 0)
    : tradePnls(db, f).pnls;
  const wins = pnls.filter((x) => x > 0).length;
  const winRate = pnls.length > 0 ? wins / pnls.length : null;
  const dealRealized = dealRows.reduce((a, c) => a + c.realized, 0);

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
  const snapsFresh = last != null && now - last.ts < 10 * 60_000;
  const sb = fromDeals ? strat?.sb ?? null : snapsFresh ? strat?.sb ?? null : null;
  const equity = fromDeals ? (sb ?? 0) + dealRealized : snapsFresh ? last!.equity : null;
  return {
    tradeCount: fromDeals ? dealRows.length : t?.c ?? 0,
    buyCount: fromDeals ? dealRows.filter((c) => c.side === "BUY").length : t?.buys ?? 0,
    sellCount: fromDeals ? dealRows.filter((c) => c.side === "SELL").length : t?.sells ?? 0,
    volume: fromDeals ? dealRows.reduce((a, c) => a + (c.qty ?? 0), 0) : t?.vol ?? 0,
    realizedPnl: fromDeals ? dealRealized : (last as { realized: number } | undefined)?.realized ?? null,
    equity,
    startingBalance: sb,
    returnPct: sb && equity != null && sb !== 0 ? (equity - sb) / sb : null,
    winRate,
    maxDrawdownPct: snaps.length > 0 ? maxDd : null,
    sharpe,
  };
}
