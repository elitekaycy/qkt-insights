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

export function ingestEvents(db: Db, instanceId: string, events: Envelope[]): number {
  const insEvent = db.prepare(
    "INSERT OR IGNORE INTO events (id, instance_id, type, strategy_id, seq, ts, payload) VALUES (?,?,?,?,?,?,?)",
  );
  const insFts = db.prepare("INSERT INTO events_fts (text, instance_id, event_rowid) VALUES (?,?,?)");
  const upInstance = db.prepare(
    `INSERT INTO instances (id, first_seen, last_seen, last_seq) VALUES (@id,@ts,@ts,@seq)
     ON CONFLICT(id) DO UPDATE SET last_seen=max(last_seen,@ts), last_seq=max(last_seq,@seq)`,
  );
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
      if (e.type === "snapshot.equity") {
        const p = e.payload;
        insEquity.run(instanceId, p.strategyId, e.ts, p.realized, p.unrealized, p.equity);
        setEquity.run({ i: instanceId, s: p.strategyId, eq: p.equity, sb: p.startingBalance });
      }
    }
    return accepted;
  });
  return tx(events);
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
  };
  if (!existing) {
    db.prepare(
      `INSERT INTO orders (instance_id, order_id, strategy_id, symbol, side, type, state, qty, cum_qty, avg_price, created_ts, updated_ts, last_event_seq)
       VALUES (@i,@o,@s,@sym,@side,@t,@st,@qty,@cum,@avg,@ts,@ts,@seq)`,
    ).run({ ...fields, st: state, cum: cumFinal, seq: e.seq });
  } else if (e.seq >= existing.last_event_seq) {
    db.prepare(
      `UPDATE orders SET state=@st, cum_qty=@cum, last_event_seq=@seq, updated_ts=@ts,
         strategy_id=COALESCE(strategy_id,@s), symbol=COALESCE(symbol,@sym), side=COALESCE(side,@side),
         type=COALESCE(type,@t), qty=COALESCE(qty,@qty), avg_price=COALESCE(@avg, avg_price)
       WHERE instance_id=@i AND order_id=@o`,
    ).run({ ...fields, st: state, cum: cumFinal, seq: e.seq });
  } else {
    db.prepare(
      `UPDATE orders SET strategy_id=COALESCE(strategy_id,@s), symbol=COALESCE(symbol,@sym),
         side=COALESCE(side,@side), type=COALESCE(type,@t), qty=COALESCE(qty,@qty), avg_price=COALESCE(avg_price,@avg)
       WHERE instance_id=@i AND order_id=@o`,
    ).run(fields);
  }
}
