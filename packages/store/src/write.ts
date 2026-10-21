import type { Db } from "./db.js";
import { isLiveStateType, type Envelope, type QuarantinedEnvelope } from "@qkt-insights/contract";

/** A flat position still records one valuation this often so its holding period is visible. */
/** A flat position is still re-marked this often, so a stored mark proves it was held. */
export const VALUATION_HEARTBEAT_MS = 5 * 60_000;

/** Last valuation row written per `instance|broker|ticket`; restart simply writes once more. */
const lastValuationWrite = new Map<string, number>();

/** `strategy.started` carries the configured starting balance under `risk.startingBalance`. */
export function startingBalanceOf(payload: unknown): number | null {
  const risk = (payload as { risk?: { startingBalance?: unknown } } | null)?.risk;
  const v = risk?.startingBalance;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

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
  `INSERT INTO instances (id, first_seen, last_seen, last_seq, heard_at) VALUES (@id,@ts,@ts,@seq,@heardAt)
   ON CONFLICT(id) DO UPDATE SET last_seen=max(last_seen,@ts), last_seq=max(last_seq,@seq), heard_at=@heardAt`;

/**
 * Bump an instance's heartbeat (last_seen/last_seq) without writing an event.
 * The collector calls this for state.* envelopes — they carry no durable row but
 * are the freshest proof the instance is alive (the broker poller hits every 10s),
 * so Health reads the live poller, not the last trade hours ago.
 */
export function touchInstance(db: Db, instanceId: string, ts: number, seq: number, heardAt = Date.now()): void {
  db.prepare(UP_INSTANCE_SQL).run({ id: instanceId, ts, seq, heardAt });
}

/**
 * Bump the roster timestamp for each currently-deployed strategy. Additive, not a
 * wholesale replace: one daemon fans an instance across several sessions that each
 * announce only their own ids, so replacing would let them clobber each other. A
 * strategy counts as live while its bumped `ts` stays within the freshness window of
 * the instance's newest bump (see `listStrategies`); one left behind by a reshard
 * stops being bumped and ages out. Empty roster is a no-op.
 */
export function upsertRoster(db: Db, instanceId: string, strategyIds: string[], ts: number): void {
  if (strategyIds.length === 0) return;
  const ins = db.prepare(
    `INSERT INTO instance_roster (instance_id, strategy_id, ts) VALUES (?,?,?)
     ON CONFLICT(instance_id, strategy_id) DO UPDATE SET ts=excluded.ts WHERE excluded.ts > ts`,
  );
  db.transaction(() => {
    for (const s of strategyIds) ins.run(instanceId, s, ts);
  })();
}

/** Replace the operator-declared capitals wholesale: a strategy dropped from the map falls back to its starting balance. */
export function replaceStrategyCapital(db: Db, capitals: Record<string, number>): void {
  const ins = db.prepare("INSERT INTO strategy_capital (strategy_id, capital) VALUES (?, ?)");
  db.transaction(() => {
    db.prepare("DELETE FROM strategy_capital").run();
    for (const [strategyId, capital] of Object.entries(capitals)) ins.run(strategyId, capital);
  })();
}

export function persistStateEvent(db: Db, instanceId: string, e: Envelope): void {
  if (e.type !== "state.positions") return;
  const p = e.payload;
  const positions = p.positions ?? [];
  const upCurrent = db.prepare(
    `INSERT INTO positions_current
       (instance_id, broker, ticket, symbol, side, qty, entry_price, current_price, profit, swap, opened_at, strategy_id, last_seen, last_seq)
     VALUES (@instanceId,@broker,@ticket,@symbol,@side,@qty,@entryPrice,@currentPrice,@profit,@swap,@openedAt,@strategyId,@ts,@seq)
     ON CONFLICT(instance_id, broker, ticket) DO UPDATE SET
       symbol=excluded.symbol,
       side=excluded.side,
       qty=excluded.qty,
       entry_price=excluded.entry_price,
       current_price=excluded.current_price,
       profit=excluded.profit,
       swap=excluded.swap,
       opened_at=excluded.opened_at,
       strategy_id=excluded.strategy_id,
       last_seen=excluded.last_seen,
       last_seq=excluded.last_seq`,
  );
  const insValuation = db.prepare(
    `INSERT OR IGNORE INTO position_valuations
       (instance_id, broker, ticket, ts, symbol, side, qty, entry_price, current_price, profit, swap, strategy_id)
     VALUES (@instanceId,@broker,@ticket,@ts,@symbol,@side,@qty,@entryPrice,@currentPrice,@profit,@swap,@strategyId)`,
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
      const strategyId = resolvePositionStrategy(
        db,
        instanceId,
        pos.ticket,
        pos.strategyId ?? knownStrategies.get(pos.ticket) ?? null,
      );
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

/** What ingest did with one envelope: stored, or already stored under the same id. */
export type IngestStatus = "accepted" | "duplicate";

export interface IngestOutcome {
  /** Envelopes that wrote a new row. */
  accepted: number;
  /** One status per input envelope, in input order. */
  statuses: IngestStatus[];
}

export function ingestEvents(db: Db, instanceId: string, events: Envelope[], heardAt = Date.now()): number {
  return ingestEnvelopes(db, instanceId, events, heardAt).accepted;
}

export function ingestEnvelopes(db: Db, instanceId: string, events: Envelope[], heardAt = Date.now()): IngestOutcome {
  const insEvent = db.prepare(
    "INSERT OR IGNORE INTO events (id, instance_id, type, strategy_id, seq, ts, payload) VALUES (?,?,?,?,?,?,?)",
  );
  const insFts = db.prepare("INSERT INTO events_fts (text, instance_id, event_rowid) VALUES (?,?,?)");
  const upHealth = db.prepare(
    `INSERT INTO instance_health (instance_id, ts, seq, payload) VALUES (@i, @ts, @seq, @payload)
     ON CONFLICT(instance_id) DO UPDATE SET ts=excluded.ts, seq=excluded.seq, payload=excluded.payload
     WHERE excluded.ts >= instance_health.ts`,
  );
  const setStartingBalance = db.prepare(
    "UPDATE strategies SET starting_balance=@sb WHERE instance_id=@i AND strategy_id=@s AND starting_balance IS NULL",
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
    "INSERT INTO equity_snapshots (instance_id, strategy_id, ts, realized, unrealized, equity) VALUES (?,?,?,?,?,?)",
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
        qty, price, profit, commission, swap, fee, magic, comment, strategy_id, ts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );

  const tx = db.transaction((evs: Envelope[]): IngestOutcome => {
    let accepted = 0;
    const statuses: IngestStatus[] = evs.map(() => "accepted");
    for (const [i, e] of evs.entries()) {
      const duplicate = () => {
        statuses[i] = "duplicate";
      };
      // Logs are high-volume operational data, not trading history: they get their
      // own table + FTS index and stay out of the events record.
      if (e.type === "log") {
        const p = e.payload;
        const info = insLog.run(e.id, instanceId, e.strategyId ?? null, p.level, p.logger, p.message, e.ts, e.seq);
        if (info.changes === 0) {
          duplicate();
          continue;
        }
        accepted++;
        insLogFts.run(`${p.logger} ${p.message}`, instanceId, info.lastInsertRowid as number);
        upInstance.run({ id: instanceId, ts: e.ts, seq: e.seq , heardAt });
        // Logs never create strategy rows: their attribution is looser than trading
        // events (qkt once shipped the deploy name in the MDC), and a mislabeled log
        // line must not grow a ghost strategy with no equity in the dashboard.
        continue;
      }
      // Live last-value state belongs to the in-memory store; the collector routes
      // state.* envelopes before ingest, this branch is defense in depth.
      if (isLiveStateType(e.type)) continue;
      // Deals are durable broker history with their own table, same rule as logs:
      // no events row, no FTS row, idempotent by deterministic id.
      if (e.type === "broker.deal") {
        const p = e.payload;
        const strategyId = p.strategyId ?? resolveDealStrategy(db, instanceId, p.dealTicket, p.positionTicket ?? null, p.comment ?? null);
        if (!isDealLocalToInstance(db, instanceId, strategyId)) continue;
        const info = insDeal.run(e.id, instanceId, p.broker, p.dealTicket, p.positionTicket ?? null, p.orderTicket ?? null,
          p.symbol ?? null, p.side ?? null, p.entry ?? null, p.qty, p.price, p.profit, p.commission ?? null,
          p.swap ?? null, p.fee ?? null, p.magic ?? null, p.comment ?? null, strategyId, p.ts);
        if (info.changes === 0) {
          duplicate();
          // Re-ingested deal (the 30d backfill re-runs on every restart). If it
          // first stored unattributed but now resolves — its strategies row
          // appeared, or a sibling got attributed — fill the NULL instead of skipping.
          if (strategyId) adoptUnattributed(db, instanceId, strategyId, p.dealTicket, p.positionTicket ?? null);
          continue;
        }
        accepted++;
        upInstance.run({ id: instanceId, ts: e.ts, seq: e.seq , heardAt });
        if (strategyId) {
          upStrategy.run({ i: instanceId, s: strategyId, ts: e.ts });
          adoptUnattributed(db, instanceId, strategyId, p.dealTicket, p.positionTicket ?? null);
        }
        continue;
      }
      // Equity snapshots are a sampled time series; they live in equity_snapshots
      // only — writing each one to events + FTS tripled the storage for no reader.
      if (e.type === "snapshot.equity") {
        const p = e.payload;
        accepted++;
        upInstance.run({ id: instanceId, ts: e.ts, seq: e.seq , heardAt });
        upStrategy.run({ i: instanceId, s: p.strategyId, ts: e.ts });
        insEquity.run(instanceId, p.strategyId, e.ts, p.realized, p.unrealized, p.equity);
        setEquity.run({ i: instanceId, s: p.strategyId, eq: p.equity, sb: p.startingBalance });
        continue;
      }
      if (e.type === "snapshot.position") {
        upInstance.run({ id: instanceId, ts: e.ts, seq: e.seq , heardAt });
        continue;
      }
      if (e.type === "insights.health") {
        accepted++;
        upHealth.run({ i: instanceId, ts: e.ts, seq: e.seq, payload: JSON.stringify(e.payload) });
        upInstance.run({ id: instanceId, ts: e.ts, seq: e.seq , heardAt });
        continue;
      }
      const info = insEvent.run(e.id, instanceId, e.type, e.strategyId ?? null, e.seq, e.ts, JSON.stringify(e.payload));
      if (info.changes === 0) {
        duplicate();
        continue; // duplicate id, skip the rest of the fold
      }
      accepted++;
      if (e.type === "trade.closed") {
        const p = e.payload;
        insClose.run(e.id, instanceId, e.strategyId ?? null, p.symbol, p.side, p.qty, p.price, p.realized, p.entryTs ?? null, p.ts, p.orderId);
      }
      insFts.run(ftsText(e), instanceId, info.lastInsertRowid as number);
      upInstance.run({ id: instanceId, ts: e.ts, seq: e.seq , heardAt });
      if (e.type === "strategy.started") {
        const strategyId = (e.payload as any).strategyId ?? e.strategyId;
        if (strategyId) {
          upStrategyMetadata.run({ i: instanceId, s: strategyId, ts: e.ts, metadata: JSON.stringify(e.payload) });
          // The deploy provenance carries the configured starting balance; anchor the
          // equity curve from it when no snapshot.equity has set one yet.
          const sb = startingBalanceOf(e.payload);
          if (sb != null) setStartingBalance.run({ i: instanceId, s: strategyId, sb });
        }
      } else if (e.strategyId) {
        upStrategy.run({ i: instanceId, s: e.strategyId, ts: e.ts });
      }
      foldOrder(db, instanceId, e);
      foldPosition(db, instanceId, e);
      foldRisk(db, instanceId, e);
      foldPortfolio(db, instanceId, e);
    }
    return { accepted, statuses };
  });
  return tx(events);
}

/**
 * Keep envelopes ingest could not project, raw, once per (instance, id). Returns how many were
 * stored for the first time; a redelivered one leaves its first row untouched.
 */
export function quarantineEnvelopes(db: Db, instanceId: string, envelopes: Array<QuarantinedEnvelope & { id: string }>, receivedAt = Date.now()): number {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO quarantined_events (instance_id, id, type, v, ts, received_at, reason, envelope)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  return db.transaction(() => {
    let stored = 0;
    for (const q of envelopes) {
      stored += ins.run(instanceId, q.id, q.type, q.v, q.ts, receivedAt, q.reason, JSON.stringify(q.raw)).changes;
    }
    return stored;
  })();
}

// qkt sends every deal on the account and names the strategy only when it knows it
// (#1143): a close after a restart, a retired strategy's close, a manual close or another
// tool's trade on the same account arrives with no strategy. Such a deal is kept unattributed:
// it moved the account's balance, so the account totals show it as "Unattributed", and its owner
// is adopted later when a sibling leg resolves. Only a deal explicitly named for a strategy this
// instance does not run is dropped: it is another instance's, attributed there.
function isDealLocalToInstance(db: Db, instanceId: string, strategyId: string | null): boolean {
  if (strategyId == null) return true;
  const known = db.prepare("SELECT strategy_id strategyId FROM strategies WHERE instance_id=?").all(instanceId) as { strategyId: string }[];
  return known.length === 0 || known.some((row) => row.strategyId === strategyId);
}

// A deal is sent once per broker profile that shares the account, so the same deal
// ticket can sit in several rows; analytics reads the oldest row. Every row of the
// ticket and every earlier leg of the position takes the owner as soon as one copy
// knows it, so the row analytics picks is never the unattributed one.
function adoptUnattributed(db: Db, instanceId: string, strategyId: string, dealTicket: string, positionTicket: string | null): void {
  db.prepare("UPDATE deals SET strategy_id=? WHERE instance_id=? AND deal_ticket=? AND strategy_id IS NULL")
    .run(strategyId, instanceId, dealTicket);
  if (positionTicket)
    db.prepare("UPDATE deals SET strategy_id=? WHERE instance_id=? AND position_ticket=? AND strategy_id IS NULL")
      .run(strategyId, instanceId, positionTicket);
}

// MT5 overwrites the close-leg comment when SL/TP fires (e.g. "[tp 4332.689]"),
// so a venue-closed deal can never name its strategy itself. Two recoveries, in
// order of trust: any attributed sibling of the same position (the IN leg keeps
// the original comment-derived attribution), else a "dsl-<strategy>" comment
// prefix-matched against the instance's known strategies — both directions,
// because MT5 truncates comments to 31 chars; only a unique match wins.
function resolveDealStrategy(db: Db, instanceId: string, dealTicket: string, positionTicket: string | null, comment: string | null): string | null {
  const copy = db.prepare(
    "SELECT strategy_id s FROM deals WHERE instance_id=? AND deal_ticket=? AND strategy_id IS NOT NULL ORDER BY rowid LIMIT 1",
  ).get(instanceId, dealTicket) as { s: string } | undefined;
  if (copy) return copy.s;
  if (positionTicket) {
    const hit = db.prepare(
      "SELECT strategy_id s FROM deals WHERE instance_id=? AND position_ticket=? AND strategy_id IS NOT NULL ORDER BY rowid LIMIT 1",
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
          created_ts, updated_ts, last_event_seq)
       VALUES (@i,@o,@s,@sym,@side,@t,@st,@qty,@cum,@avg,@b,@ts,@ts,@seq)`,
    ).run({ ...fields, st: state, cum: cumFinal, seq: e.seq });
  } else if (e.ts > existing.updated_ts || (e.ts === existing.updated_ts && e.seq >= existing.last_event_seq)) {
    db.prepare(
      `UPDATE orders SET state=@st, cum_qty=@cum, last_event_seq=@seq, updated_ts=@ts,
         strategy_id=COALESCE(strategy_id,@s), symbol=COALESCE(symbol,@sym), side=COALESCE(side,@side),
         type=COALESCE(type,@t), qty=COALESCE(qty,@qty), avg_price=COALESCE(@avg, avg_price),
         broker_order_id=COALESCE(broker_order_id,@b)
       WHERE instance_id=@i AND order_id=@o`,
    ).run({ ...fields, st: state, cum: cumFinal, seq: e.seq });
  } else {
    db.prepare(
      `UPDATE orders SET strategy_id=COALESCE(strategy_id,@s), symbol=COALESCE(symbol,@sym),
         side=COALESCE(side,@side), type=COALESCE(type,@t), qty=COALESCE(qty,@qty), avg_price=COALESCE(avg_price,@avg),
         broker_order_id=COALESCE(broker_order_id,@b)
       WHERE instance_id=@i AND order_id=@o`,
    ).run(fields);
  }
}

// The engine tags a live position with the DSL stream alias it was opened by (e.g. "fx2_NZDUSD_0"),
// while its deals, trades and the strategy list all use the sleeve id (e.g. "forward_bench_2:s0").
// Left unresolved, a position shows a name that matches nothing in the Strategies tab. The deals for
// the same broker position ticket carry the authoritative sleeve attribution, so prefer that; fall
// back to the raw id when no deal has landed yet (corrected on the next position update).
// e.g. position ticket 3079627120 tagged "fx2_NZDUSD_0" but its IN deal is "forward_bench_2:s0" -> the latter.
function resolvePositionStrategy(db: Db, instanceId: string, ticket: string, raw: string | null): string | null {
  const viaDeal = db.prepare(
    "SELECT strategy_id s FROM deals WHERE instance_id=? AND position_ticket=? AND strategy_id IS NOT NULL ORDER BY rowid LIMIT 1",
  ).get(instanceId, ticket) as { s: string } | undefined;
  return viaDeal?.s ?? raw;
}

// Open positions come from state.positions (persistStateEvent). The position.opened/updated/closed/valued
// types stay in the contract so an old producer is never refused, and are kept as events only.
function foldPosition(db: Db, instanceId: string, e: Envelope): void {
  if (e.type !== "position.reconciled") return;
  const p: any = e.payload;
  db.prepare(
    `INSERT OR IGNORE INTO position_reconciliations
       (instance_id, event_id, strategy_id, symbol, old_qty, new_qty, old_avg_px, new_avg_px, source, reason, ts, seq)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(instanceId, e.id, e.strategyId ?? null, p.symbol, p.oldQty ?? p.before ?? null, p.newQty ?? p.after,
    p.oldAvgPx ?? null, p.newAvgPx ?? null, p.source ?? null, p.reason ?? null, e.ts, e.seq);
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
       (instance_id, event_id, strategy_id, kind, reason, symbol, side, qty, ts, seq, payload)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(instanceId, e.id, p.strategyId ?? e.strategyId ?? null, e.type, p.reason ?? null,
    p.symbol ?? null, p.side ?? null, p.qty ?? null, e.ts, e.seq, JSON.stringify(p));
}

// portfolio.exposure.updated is accepted and kept as an event; qkt does not emit it, so it has no table.
function foldPortfolio(db: Db, instanceId: string, e: Envelope): void {
  const p: any = e.payload;
  if (e.type === "portfolio.configured" || e.type === "portfolio.allocation.updated") {
    db.prepare(
      "INSERT OR IGNORE INTO portfolio_allocations (instance_id, event_id, portfolio_id, ts, seq, payload) VALUES (?,?,?,?,?,?)",
    ).run(instanceId, e.id, p.portfolioId, e.ts, e.seq, JSON.stringify(p));
    return;
  }
  if (e.type === "portfolio.equity.updated") {
    db.prepare(
      `INSERT OR IGNORE INTO portfolio_equity
         (instance_id, event_id, portfolio_id, ts, seq, equity, realized, unrealized, payload)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(instanceId, e.id, p.portfolioId, e.ts, e.seq, p.equity ?? null, p.realized ?? null, p.unrealized ?? null, JSON.stringify(p));
  }
}
