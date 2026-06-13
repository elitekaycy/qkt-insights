import type { Db } from "./db.js";
import type { Envelope } from "@qkt-insights/contract";

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

/**
 * Bump an instance's heartbeat (last_seen/last_seq) without writing an event.
 * The collector calls this for state.* envelopes — they carry no durable row but
 * are the freshest proof the instance is alive (the broker poller hits every 10s),
 * so Health reads the live poller, not the last trade hours ago.
 */
export function touchInstance(db: Db, instanceId: string, ts: number, seq: number): void {
  db.prepare(UP_INSTANCE_SQL).run({ id: instanceId, ts, seq });
}

export function ingestEvents(db: Db, instanceId: string, events: Envelope[]): number {
  const insEvent = db.prepare(
    "INSERT OR IGNORE INTO events (id, instance_id, type, strategy_id, seq, ts, payload) VALUES (?,?,?,?,?,?,?)",
  );
  const insFts = db.prepare("INSERT INTO events_fts (text, instance_id, event_rowid) VALUES (?,?,?)");
  const upInstance = db.prepare(UP_INSTANCE_SQL);
  const upStrategy = db.prepare(
    `INSERT INTO strategies (instance_id, strategy_id, first_seen, last_seen) VALUES (@i,@s,@ts,@ts)
     ON CONFLICT(instance_id,strategy_id) DO UPDATE SET last_seen=max(last_seen,@ts)`,
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
    "INSERT OR IGNORE INTO deals (id, instance_id, broker, deal_ticket, position_ticket, order_ticket, symbol, side, entry, qty, price, profit, commission, swap, magic, comment, strategy_id, ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );

  const tx = db.transaction((evs: Envelope[]) => {
    let accepted = 0;
    for (const e of evs) {
      // Logs are high-volume operational data, not trading history: they get their
      // own table + FTS index and stay out of the events record.
      if (e.type === "log") {
        const p = e.payload;
        const info = insLog.run(e.id, instanceId, e.strategyId ?? null, p.level, p.logger, p.message, e.ts, e.seq);
        if (info.changes === 0) continue;
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
        const info = insDeal.run(e.id, instanceId, p.broker, p.dealTicket, p.positionTicket ?? null, p.orderTicket ?? null,
          p.symbol ?? null, p.side ?? null, p.entry ?? null, p.qty, p.price, p.profit, p.commission ?? null,
          p.swap ?? null, p.magic ?? null, p.comment ?? null, strategyId, p.ts);
        if (info.changes === 0) {
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
        insEquity.run(instanceId, p.strategyId, e.ts, p.realized, p.unrealized, p.equity);
        setEquity.run({ i: instanceId, s: p.strategyId, eq: p.equity, sb: p.startingBalance });
        continue;
      }
      if (e.type === "snapshot.position") {
        upInstance.run({ id: instanceId, ts: e.ts, seq: e.seq });
        continue;
      }
      const info = insEvent.run(e.id, instanceId, e.type, e.strategyId ?? null, e.seq, e.ts, JSON.stringify(e.payload));
      if (info.changes === 0) continue; // duplicate id, skip the rest of the fold
      accepted++;
      if (e.type === "trade.closed") {
        const p = e.payload;
        insClose.run(e.id, instanceId, e.strategyId ?? null, p.symbol, p.side, p.qty, p.price, p.realized, p.entryTs ?? null, p.ts, p.orderId);
      }
      insFts.run(ftsText(e), instanceId, info.lastInsertRowid as number);
      upInstance.run({ id: instanceId, ts: e.ts, seq: e.seq });
      if (e.strategyId) upStrategy.run({ i: instanceId, s: e.strategyId, ts: e.ts });
      foldOrder(db, instanceId, e);
    }
    return accepted;
  });
  return tx(events);
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

// Events can reach the collector out of seq order (qkt's bus dispatch is re-entrant:
// a paper fill publishes inside the submit's dispatch, so the sink sees the fill first).
// The fold therefore keys authority on seq: only an event with seq >= the last applied
// one may change state; older stragglers just backfill fields the row is missing.
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
      `INSERT INTO orders (instance_id, order_id, strategy_id, symbol, side, type, state, qty, cum_qty, avg_price, broker_order_id, created_ts, updated_ts, last_event_seq)
       VALUES (@i,@o,@s,@sym,@side,@t,@st,@qty,@cum,@avg,@b,@ts,@ts,@seq)`,
    ).run({ ...fields, st: state, cum: cumFinal, seq: e.seq });
  } else if (e.seq >= existing.last_event_seq) {
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
