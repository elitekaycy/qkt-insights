import type { Db } from "./db.js";
import type { Envelope } from "@qkt-insights/contract";

/** A flat position still records one valuation this often so its holding period is visible. */
const VALUATION_HEARTBEAT_MS = 5 * 60_000;

/** Last valuation row written per `instance|broker|ticket`; restart simply writes once more. */
const lastValuationWrite = new Map<string, number>();

function ftsText(e: Envelope): string {
  const p: any = e.payload;
  return [e.type, e.strategyId, p.symbol, p.side, p.orderId, p.brokerOrderId, p.reason]
    .filter(Boolean).join(" ");
}

const ORDER_STATE: Record<string, string> = {
  "order.submit": "SUBMITTED",
  "order.accepted": "WORKING",
  "order.partially_filled": "PARTIALLY_FILLED",
  "order.filled": "FILLED",
  "order.cancelled": "CANCELLED",
  "order.rejected": "REJECTED",
};

const UP_INSTANCE_SQL =
  `INSERT INTO instances (id, first_seen, last_seen, last_seq) VALUES (@id,@ts,@ts,@seq)
   ON CONFLICT(id) DO UPDATE SET last_seen=max(last_seen,@ts), last_seq=max(last_seq,@seq)`;

const OBS_SQL =
  `INSERT INTO ingest_observations
     (instance_id, kind, event_id, type, seq, previous_seq, expected_seq, ts, detail)
   VALUES (@instanceId,@kind,@eventId,@type,@seq,@previousSeq,@expectedSeq,@ts,@detail)`;

function observeDuplicate(db: Db, instanceId: string, e: Envelope): void {
  db.prepare(OBS_SQL).run({
    instanceId,
    kind: "duplicate",
    eventId: e.id,
    type: e.type,
    seq: e.seq,
    previousSeq: null,
    expectedSeq: null,
    ts: e.ts,
    detail: null,
  });
}

function decimalText(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  return null;
}

/**
 * Bump an instance's heartbeat (last_seen/last_seq) without writing an event.
 * The collector calls this for state.* envelopes — they carry no durable row but
 * are the freshest proof the instance is alive (the broker poller hits every 10s),
 * so Health reads the live poller, not the last trade hours ago.
 */
export function touchInstance(db: Db, instanceId: string, ts: number, seq: number): void {
  db.prepare(UP_INSTANCE_SQL).run({ id: instanceId, ts, seq });
}

export function persistStateEvent(db: Db, instanceId: string, e: Envelope): void {
  if (e.type !== "state.positions") return;
  const p = e.payload;
  const positions = p.positions ?? [];
  const upCurrent = db.prepare(
    `INSERT INTO positions_current
       (instance_id, broker, ticket, symbol, side, qty, entry_price, current_price, profit, swap, opened_at, strategy_id, last_seen, last_seq,
        qty_decimal, entry_price_decimal, current_price_decimal, profit_decimal, swap_decimal)
     VALUES (@instanceId,@broker,@ticket,@symbol,@side,@qty,@entryPrice,@currentPrice,@profit,@swap,@openedAt,@strategyId,@ts,@seq,
       @qtyDecimal,@entryPriceDecimal,@currentPriceDecimal,@profitDecimal,@swapDecimal)
     ON CONFLICT(instance_id, broker, ticket) DO UPDATE SET
       symbol=excluded.symbol,
       side=excluded.side,
       qty=excluded.qty,
       entry_price=excluded.entry_price,
       current_price=excluded.current_price,
       profit=excluded.profit,
       swap=excluded.swap,
       qty_decimal=excluded.qty_decimal,
       entry_price_decimal=excluded.entry_price_decimal,
       current_price_decimal=excluded.current_price_decimal,
       profit_decimal=excluded.profit_decimal,
       swap_decimal=excluded.swap_decimal,
       opened_at=excluded.opened_at,
       strategy_id=excluded.strategy_id,
       last_seen=excluded.last_seen,
       last_seq=excluded.last_seq`,
  );
  const insValuation = db.prepare(
    `INSERT OR IGNORE INTO position_valuations
       (instance_id, broker, ticket, ts, symbol, side, qty, entry_price, current_price, profit, swap, strategy_id,
        qty_decimal, entry_price_decimal, current_price_decimal, profit_decimal, swap_decimal)
     VALUES (@instanceId,@broker,@ticket,@ts,@symbol,@side,@qty,@entryPrice,@currentPrice,@profit,@swap,@strategyId,
       @qtyDecimal,@entryPriceDecimal,@currentPriceDecimal,@profitDecimal,@swapDecimal)`,
  );
  const tx = db.transaction(() => {
    const existing = db.prepare(
      `SELECT ticket, strategy_id strategyId, current_price currentPrice, profit, swap, qty
       FROM positions_current WHERE instance_id=? AND broker=?`,
    ).all(instanceId, p.broker) as Array<{
      ticket: string; strategyId: string | null; currentPrice: number | null; profit: number | null;
      swap: number | null; qty: number;
    }>;
    const knownStrategies = new Map(existing.map((row) => [row.ticket, row.strategyId]));
    const previous = new Map(existing.map((row) => [row.ticket, row]));
    const tickets = new Set<string>();
    for (const pos of positions) {
      tickets.add(pos.ticket);
      const strategyId = pos.strategyId ?? knownStrategies.get(pos.ticket) ?? null;
      const row = {
        instanceId,
        broker: p.broker,
        ticket: pos.ticket,
        symbol: pos.symbol,
        side: pos.side,
        qty: pos.qty,
        entryPrice: pos.entryPrice,
        currentPrice: pos.currentPrice ?? null,
        profit: pos.profit ?? null,
        swap: pos.swap ?? null,
        openedAt: pos.openedAt ?? null,
        strategyId,
        qtyDecimal: decimalText(pos.qty),
        entryPriceDecimal: decimalText(pos.entryPrice),
        currentPriceDecimal: decimalText(pos.currentPrice),
        profitDecimal: decimalText(pos.profit),
        swapDecimal: decimalText(pos.swap),
        ts: e.ts,
        seq: e.seq,
      };
      upCurrent.run(row);
      // A valuation row per poll per position was the largest table by far, and most
      // rows repeated the previous one. Keep the ones that move the excursion curve,
      // plus a heartbeat so a flat position still shows it was held.
      const prior = previous.get(pos.ticket);
      const key = `${instanceId}|${p.broker}|${pos.ticket}`;
      const lastWrite = lastValuationWrite.get(key);
      const changed =
        prior == null ||
        lastWrite == null ||
        prior.currentPrice !== row.currentPrice ||
        prior.profit !== row.profit ||
        prior.swap !== row.swap ||
        prior.qty !== row.qty ||
        e.ts - lastWrite >= VALUATION_HEARTBEAT_MS;
      if (changed) {
        insValuation.run(row);
        lastValuationWrite.set(key, e.ts);
      }
      if (strategyId) knownStrategies.set(pos.ticket, strategyId);
    }
    const del = db.prepare("DELETE FROM positions_current WHERE instance_id=? AND broker=? AND ticket=?");
    for (const row of existing) {
      if (!tickets.has(row.ticket)) {
        del.run(instanceId, p.broker, row.ticket);
        lastValuationWrite.delete(`${instanceId}|${p.broker}|${row.ticket}`);
      }
    }
  });
  tx();
}

export function ingestEvents(db: Db, instanceId: string, events: Envelope[]): number {
  const insEvent = db.prepare(
    "INSERT OR IGNORE INTO events (id, instance_id, type, strategy_id, seq, ts, payload) VALUES (?,?,?,?,?,?,?)",
  );
  const insFts = db.prepare("INSERT INTO events_fts (text, instance_id, event_rowid) VALUES (?,?,?)");
  const upHealth = db.prepare(
    `INSERT INTO instance_health (instance_id, ts, seq, payload) VALUES (@i, @ts, @seq, @payload)
     ON CONFLICT(instance_id) DO UPDATE SET ts=excluded.ts, seq=excluded.seq, payload=excluded.payload
     WHERE excluded.ts >= instance_health.ts`,
  );
  const upInstance = db.prepare(UP_INSTANCE_SQL);
  const upStrategy = db.prepare(
    `INSERT INTO strategies (instance_id, strategy_id, first_seen, last_seen) VALUES (@i,@s,@ts,@ts)
     ON CONFLICT(instance_id,strategy_id) DO UPDATE SET last_seen=max(last_seen,@ts)`,
  );
  const upStrategyMetadata = db.prepare(
    `INSERT INTO strategies (instance_id, strategy_id, first_seen, last_seen, metadata)
     VALUES (@i,@s,@ts,@ts,@metadata)
     ON CONFLICT(instance_id,strategy_id) DO UPDATE SET
       last_seen=max(last_seen,@ts),
       metadata=@metadata`,
  );
  const setEquity = db.prepare(
    "UPDATE strategies SET equity=@eq, starting_balance=@sb WHERE instance_id=@i AND strategy_id=@s",
  );
  const insEquity = db.prepare(
    `INSERT INTO equity_snapshots
       (instance_id, strategy_id, ts, realized, unrealized, equity, realized_decimal, unrealized_decimal, equity_decimal)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );

  const insLog = db.prepare(
    "INSERT OR IGNORE INTO logs (id, instance_id, strategy_id, level, logger, message, ts, seq) VALUES (?,?,?,?,?,?,?,?)",
  );
  const insLogFts = db.prepare("INSERT INTO logs_fts (text, instance_id, log_rowid) VALUES (?,?,?)");
  const insClose = db.prepare(
    "INSERT OR IGNORE INTO trade_closes (id, instance_id, strategy_id, symbol, side, qty, price, realized, entry_ts, ts, order_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  );
  const insDeal = db.prepare(
    `INSERT OR IGNORE INTO deals
       (id, instance_id, broker, deal_ticket, position_ticket, order_ticket, symbol, side, entry,
        qty, price, profit, commission, swap, fee, magic, comment, strategy_id, ts,
        qty_decimal, price_decimal, profit_decimal, commission_decimal, swap_decimal, fee_decimal)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );

  const tx = db.transaction((evs: Envelope[]) => {
    let accepted = 0;
    for (const e of evs) {
      // Logs are high-volume operational data, not trading history: they get their
      // own table + FTS index and stay out of the events record.
      if (e.type === "log") {
        const p = e.payload;
        const info = insLog.run(e.id, instanceId, e.strategyId ?? null, p.level, p.logger, p.message, e.ts, e.seq);
        if (info.changes === 0) {
          observeDuplicate(db, instanceId, e);
          continue;
        }
        accepted++;
        insLogFts.run(`${p.logger} ${p.message}`, instanceId, info.lastInsertRowid as number);
        upInstance.run({ id: instanceId, ts: e.ts, seq: e.seq });
        // Logs never create strategy rows: their attribution is looser than trading
        // events (qkt once shipped the deploy name in the MDC), and a mislabeled log
        // line must not grow a ghost strategy with no equity in the dashboard.
        continue;
      }
      // Live last-value state belongs to the in-memory store; the collector routes
      // state.* envelopes before ingest, this branch is defense in depth.
      if (e.type.startsWith("state.")) continue;
      // Deals are durable broker history with their own table, same rule as logs:
      // no events row, no FTS row, idempotent by deterministic id.
      if (e.type === "broker.deal") {
        const p = e.payload;
        const strategyId = p.strategyId ?? resolveDealStrategy(db, instanceId, p.positionTicket ?? null, p.comment ?? null);
        if (!isDealLocalToInstance(db, instanceId, strategyId)) continue;
        const info = insDeal.run(e.id, instanceId, p.broker, p.dealTicket, p.positionTicket ?? null, p.orderTicket ?? null,
          p.symbol ?? null, p.side ?? null, p.entry ?? null, p.qty, p.price, p.profit, p.commission ?? null,
          p.swap ?? null, p.fee ?? null, p.magic ?? null, p.comment ?? null, strategyId, p.ts,
          decimalText(p.qty), decimalText(p.price), decimalText(p.profit), decimalText(p.commission), decimalText(p.swap),
          decimalText(p.fee));
        if (info.changes === 0) {
          observeDuplicate(db, instanceId, e);
          // Re-ingested deal (the 30d backfill re-runs on every restart). If it
          // first stored unattributed but now resolves — its strategies row
          // appeared, or a sibling got attributed — fill the NULL instead of skipping.
          if (strategyId) {
            db.prepare("UPDATE deals SET strategy_id=? WHERE id=? AND strategy_id IS NULL").run(strategyId, e.id);
            if (p.positionTicket)
              db.prepare("UPDATE deals SET strategy_id=? WHERE instance_id=? AND position_ticket=? AND strategy_id IS NULL")
                .run(strategyId, instanceId, p.positionTicket);
          }
          continue;
        }
        accepted++;
        upInstance.run({ id: instanceId, ts: e.ts, seq: e.seq });
        if (strategyId) {
          upStrategy.run({ i: instanceId, s: strategyId, ts: e.ts });
          // Earlier legs of the same position may have arrived unattributable
          // (venue-closed before their IN): adopt them now.
          if (p.positionTicket) {
            db.prepare("UPDATE deals SET strategy_id=? WHERE instance_id=? AND position_ticket=? AND strategy_id IS NULL")
              .run(strategyId, instanceId, p.positionTicket);
          }
        }
        continue;
      }
      // Equity snapshots are a sampled time series; they live in equity_snapshots
      // only — writing each one to events + FTS tripled the storage for no reader.
      if (e.type === "snapshot.equity") {
        const p = e.payload;
        accepted++;
        upInstance.run({ id: instanceId, ts: e.ts, seq: e.seq });
        upStrategy.run({ i: instanceId, s: p.strategyId, ts: e.ts });
        insEquity.run(instanceId, p.strategyId, e.ts, p.realized, p.unrealized, p.equity,
          decimalText(p.realized), decimalText(p.unrealized), decimalText(p.equity));
        setEquity.run({ i: instanceId, s: p.strategyId, eq: p.equity, sb: p.startingBalance });
        continue;
      }
      if (e.type === "snapshot.position") {
        upInstance.run({ id: instanceId, ts: e.ts, seq: e.seq });
        continue;
      }
      if (e.type === "insights.health") {
        accepted++;
        upHealth.run({ i: instanceId, ts: e.ts, seq: e.seq, payload: JSON.stringify(e.payload) });
        upInstance.run({ id: instanceId, ts: e.ts, seq: e.seq });
        continue;
      }
      const info = insEvent.run(e.id, instanceId, e.type, e.strategyId ?? null, e.seq, e.ts, JSON.stringify(e.payload));
      if (info.changes === 0) {
        observeDuplicate(db, instanceId, e);
        continue; // duplicate id, skip the rest of the fold
      }
      accepted++;
      if (e.type === "trade.closed") {
        const p = e.payload;
        insClose.run(e.id, instanceId, e.strategyId ?? null, p.symbol, p.side, p.qty, p.price, p.realized, p.entryTs ?? null, p.ts, p.orderId);
      }
      insFts.run(ftsText(e), instanceId, info.lastInsertRowid as number);
      upInstance.run({ id: instanceId, ts: e.ts, seq: e.seq });
      if (e.type === "strategy.started") {
        const strategyId = (e.payload as any).strategyId ?? e.strategyId;
        if (strategyId) upStrategyMetadata.run({ i: instanceId, s: strategyId, ts: e.ts, metadata: JSON.stringify(e.payload) });
      } else if (e.strategyId) {
        upStrategy.run({ i: instanceId, s: e.strategyId, ts: e.ts });
      }
      foldOrder(db, instanceId, e);
      foldPosition(db, instanceId, e);
      foldRisk(db, instanceId, e);
      foldPortfolio(db, instanceId, e);
    }
    return accepted;
  });
  return tx(events);
}

function isDealLocalToInstance(db: Db, instanceId: string, strategyId: string | null): boolean {
  const known = db.prepare("SELECT strategy_id strategyId FROM strategies WHERE instance_id=?").all(instanceId) as { strategyId: string }[];
  if (known.length === 0) return true;
  return strategyId != null && known.some((row) => row.strategyId === strategyId);
}

// MT5 overwrites the close-leg comment when SL/TP fires (e.g. "[tp 4332.689]"),
// so a venue-closed deal can never name its strategy itself. Two recoveries, in
// order of trust: any attributed sibling of the same position (the IN leg keeps
// the original comment-derived attribution), else a "dsl-<strategy>" comment
// prefix-matched against the instance's known strategies — both directions,
// because MT5 truncates comments to 31 chars; only a unique match wins.
function resolveDealStrategy(db: Db, instanceId: string, positionTicket: string | null, comment: string | null): string | null {
  if (positionTicket) {
    const hit = db.prepare(
      "SELECT strategy_id s FROM deals WHERE instance_id=? AND position_ticket=? AND strategy_id IS NOT NULL LIMIT 1",
    ).get(instanceId, positionTicket) as { s: string } | undefined;
    if (hit) return hit.s;
  }
  if (comment != null && comment.startsWith("dsl-") && comment.length > 4) {
    const tag = comment.slice(4);
    const matches = (db.prepare("SELECT strategy_id s FROM strategies WHERE instance_id=?").all(instanceId) as { s: string }[])
      .map((r) => r.s)
      .filter((s) => s.startsWith(tag) || tag.startsWith(s));
    if (matches.length === 1) return matches[0]!;
  }
  return null;
}

// Events can reach the collector out of order because qkt's bus dispatch is re-entrant,
// and bus sequences restart for each strategy session. Event time is authoritative
// across sessions; seq breaks ties within one clock instant. Older stragglers only
// backfill fields the row is missing.
function foldOrder(db: Db, instanceId: string, e: Envelope): void {
  const state = ORDER_STATE[e.type];
  if (!state) return;
  const p: any = e.payload;
  const orderId = p.orderId as string;
  const existing: any = db.prepare("SELECT * FROM orders WHERE instance_id=? AND order_id=?").get(instanceId, orderId);
  const filledQty = e.type === "order.filled" || e.type === "order.partially_filled" ? p.qty : 0;
  const cum = (existing?.cum_qty ?? 0) + (e.type === "order.partially_filled" ? filledQty : 0);
  const cumFinal = e.type === "order.filled" ? (p.qty ?? cum) : cum;
  const fields = {
    i: instanceId, o: orderId, s: e.strategyId ?? null, sym: p.symbol ?? null, side: p.side ?? null,
    t: p.orderType ?? null, qty: e.type === "order.submit" ? (p.qty ?? null) : null, avg: p.price ?? null, ts: e.ts,
    b: p.brokerOrderId ?? null,
  };
  if (!existing) {
    db.prepare(
      `INSERT INTO orders
         (instance_id, order_id, strategy_id, symbol, side, type, state, qty, cum_qty, avg_price, broker_order_id,
          created_ts, updated_ts, last_event_seq, qty_decimal, cum_qty_decimal, avg_price_decimal)
       VALUES (@i,@o,@s,@sym,@side,@t,@st,@qty,@cum,@avg,@b,@ts,@ts,@seq,@qtyDecimal,@cumDecimal,@avgDecimal)`,
    ).run({ ...fields, st: state, cum: cumFinal, seq: e.seq,
      qtyDecimal: decimalText(fields.qty), cumDecimal: decimalText(cumFinal), avgDecimal: decimalText(fields.avg) });
  } else if (e.ts > existing.updated_ts || (e.ts === existing.updated_ts && e.seq >= existing.last_event_seq)) {
    db.prepare(
      `UPDATE orders SET state=@st, cum_qty=@cum, last_event_seq=@seq, updated_ts=@ts,
         strategy_id=COALESCE(strategy_id,@s), symbol=COALESCE(symbol,@sym), side=COALESCE(side,@side),
         type=COALESCE(type,@t), qty=COALESCE(qty,@qty), avg_price=COALESCE(@avg, avg_price),
         broker_order_id=COALESCE(broker_order_id,@b),
         qty_decimal=COALESCE(qty_decimal,@qtyDecimal),
         cum_qty_decimal=@cumDecimal,
         avg_price_decimal=COALESCE(@avgDecimal, avg_price_decimal)
       WHERE instance_id=@i AND order_id=@o`,
    ).run({ ...fields, st: state, cum: cumFinal, seq: e.seq,
      qtyDecimal: decimalText(fields.qty), cumDecimal: decimalText(cumFinal), avgDecimal: decimalText(fields.avg) });
  } else {
    db.prepare(
      `UPDATE orders SET strategy_id=COALESCE(strategy_id,@s), symbol=COALESCE(symbol,@sym),
         side=COALESCE(side,@side), type=COALESCE(type,@t), qty=COALESCE(qty,@qty), avg_price=COALESCE(avg_price,@avg),
         broker_order_id=COALESCE(broker_order_id,@b),
         qty_decimal=COALESCE(qty_decimal,@qtyDecimal),
         avg_price_decimal=COALESCE(avg_price_decimal,@avgDecimal)
       WHERE instance_id=@i AND order_id=@o`,
    ).run({ ...fields, qtyDecimal: decimalText(fields.qty), avgDecimal: decimalText(fields.avg) });
  }
}

function foldPosition(db: Db, instanceId: string, e: Envelope): void {
  const p: any = e.payload;
  if (e.type === "position.reconciled") {
    db.prepare(
      `INSERT OR IGNORE INTO position_reconciliations
         (instance_id, event_id, strategy_id, symbol, old_qty, new_qty, old_avg_px, new_avg_px, source, reason, ts, seq,
          old_qty_decimal, new_qty_decimal, old_avg_px_decimal, new_avg_px_decimal)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(instanceId, e.id, e.strategyId ?? null, p.symbol, p.oldQty ?? p.before ?? null, p.newQty ?? p.after,
      p.oldAvgPx ?? null, p.newAvgPx ?? null, p.source ?? null, p.reason ?? null, e.ts, e.seq,
      decimalText(p.oldQty ?? p.before), decimalText(p.newQty ?? p.after), decimalText(p.oldAvgPx), decimalText(p.newAvgPx));
    return;
  }
  if (!["position.opened", "position.updated", "position.closed", "position.valued"].includes(e.type)) return;
  const broker = p.broker ?? p.source ?? "unknown";
  const ticket = p.ticket ?? `${p.symbol}:${e.strategyId ?? "global"}`;
  if (e.type === "position.closed") {
    db.prepare("DELETE FROM positions_current WHERE instance_id=? AND broker=? AND ticket=?")
      .run(instanceId, broker, ticket);
    return;
  }
  const row = {
    instanceId,
    broker,
    ticket,
    symbol: p.symbol,
    side: p.side ?? "BUY",
    qty: p.qty,
    entryPrice: p.entryPrice ?? p.price ?? 0,
    currentPrice: p.currentPrice ?? p.price ?? null,
    profit: p.profit ?? null,
    swap: p.swap ?? null,
    openedAt: p.openedAt ?? null,
    strategyId: p.strategyId ?? e.strategyId ?? null,
    qtyDecimal: decimalText(p.qty),
    entryPriceDecimal: decimalText(p.entryPrice ?? p.price),
    currentPriceDecimal: decimalText(p.currentPrice ?? p.price),
    profitDecimal: decimalText(p.profit),
    swapDecimal: decimalText(p.swap),
    ts: e.ts,
    seq: e.seq,
  };
  db.prepare(
    `INSERT INTO positions_current
       (instance_id, broker, ticket, symbol, side, qty, entry_price, current_price, profit, swap, opened_at, strategy_id, last_seen, last_seq,
        qty_decimal, entry_price_decimal, current_price_decimal, profit_decimal, swap_decimal)
     VALUES (@instanceId,@broker,@ticket,@symbol,@side,@qty,@entryPrice,@currentPrice,@profit,@swap,@openedAt,@strategyId,@ts,@seq,
       @qtyDecimal,@entryPriceDecimal,@currentPriceDecimal,@profitDecimal,@swapDecimal)
     ON CONFLICT(instance_id, broker, ticket) DO UPDATE SET
       symbol=excluded.symbol, side=excluded.side, qty=excluded.qty, entry_price=excluded.entry_price,
       current_price=excluded.current_price, profit=excluded.profit, swap=excluded.swap,
       qty_decimal=excluded.qty_decimal, entry_price_decimal=excluded.entry_price_decimal,
       current_price_decimal=excluded.current_price_decimal, profit_decimal=excluded.profit_decimal, swap_decimal=excluded.swap_decimal,
       opened_at=COALESCE(excluded.opened_at, opened_at), strategy_id=COALESCE(excluded.strategy_id, strategy_id),
       last_seen=excluded.last_seen, last_seq=excluded.last_seq`,
  ).run(row);
  if (e.type === "position.valued") {
    db.prepare(
      `INSERT OR IGNORE INTO position_valuations
         (instance_id, broker, ticket, ts, symbol, side, qty, entry_price, current_price, profit, swap, strategy_id,
          qty_decimal, entry_price_decimal, current_price_decimal, profit_decimal, swap_decimal)
       VALUES (@instanceId,@broker,@ticket,@ts,@symbol,@side,@qty,@entryPrice,@currentPrice,@profit,@swap,@strategyId,
         @qtyDecimal,@entryPriceDecimal,@currentPriceDecimal,@profitDecimal,@swapDecimal)`,
    ).run(row);
  }
}

function foldRisk(db: Db, instanceId: string, e: Envelope): void {
  if (!["risk.rejected", "risk.halted", "risk.resumed", "risk.snapshot"].includes(e.type)) return;
  const p: any = e.payload;
  if (e.type === "risk.snapshot") {
    db.prepare(
      "INSERT OR IGNORE INTO risk_snapshots (instance_id, event_id, strategy_id, ts, seq, payload) VALUES (?,?,?,?,?,?)",
    ).run(instanceId, e.id, p.strategyId ?? e.strategyId ?? null, e.ts, e.seq, JSON.stringify(p));
    return;
  }
  db.prepare(
    `INSERT OR IGNORE INTO risk_events
       (instance_id, event_id, strategy_id, kind, reason, symbol, side, qty, ts, seq, payload, qty_decimal)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(instanceId, e.id, p.strategyId ?? e.strategyId ?? null, e.type, p.reason ?? null,
    p.symbol ?? null, p.side ?? null, p.qty ?? null, e.ts, e.seq, JSON.stringify(p), decimalText(p.qty));
}

function foldPortfolio(db: Db, instanceId: string, e: Envelope): void {
  const p: any = e.payload;
  if (e.type === "portfolio.configured" || e.type === "portfolio.allocation.updated") {
    db.prepare(
      "INSERT OR IGNORE INTO portfolio_allocations (instance_id, event_id, portfolio_id, ts, seq, payload) VALUES (?,?,?,?,?,?)",
    ).run(instanceId, e.id, p.portfolioId, e.ts, e.seq, JSON.stringify(p));
    return;
  }
  if (e.type === "portfolio.exposure.updated") {
    db.prepare(
      "INSERT OR IGNORE INTO portfolio_exposure (instance_id, event_id, portfolio_id, ts, seq, payload) VALUES (?,?,?,?,?,?)",
    ).run(instanceId, e.id, p.portfolioId, e.ts, e.seq, JSON.stringify(p));
    return;
  }
  if (e.type === "portfolio.equity.updated") {
    db.prepare(
      `INSERT OR IGNORE INTO portfolio_equity
         (instance_id, event_id, portfolio_id, ts, seq, equity, realized, unrealized, payload,
          equity_decimal, realized_decimal, unrealized_decimal)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(instanceId, e.id, p.portfolioId, e.ts, e.seq, p.equity ?? null, p.realized ?? null, p.unrealized ?? null, JSON.stringify(p),
      decimalText(p.equity), decimalText(p.realized), decimalText(p.unrealized));
  }
}
