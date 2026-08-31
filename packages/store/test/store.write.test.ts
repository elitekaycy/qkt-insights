import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import { ingestEvents, persistStateEvent } from "../src/index.js";
import { closedTrades } from "../src/analytics.js";
import type { Envelope } from "@qkt-insights/contract";

function env(p: Partial<Envelope> & { type: Envelope["type"]; payload: any }): Envelope {
  return { v: 1, instanceId: "qkt-prod", id: Math.random().toString(36).slice(2), seq: 1, ts: 1718000000000, ...p } as Envelope;
}

describe("schema", () => {
  it("creates core tables and the FTS table on open", () => {
    const db = openDb(":memory:");
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table')").all().map((r: any) => r.name);
    for (const t of ["events", "instances", "strategies", "orders", "equity_snapshots", "events_fts", "ingest_observations",
      "positions_current", "position_valuations", "position_reconciliations", "risk_events", "risk_snapshots",
      "portfolio_allocations", "portfolio_exposure", "portfolio_equity"]) {
      expect(names).toContain(t);
    }
  });

  it("enables WAL on a file-backed db", () => {
    const db = openDb(":memory:");
    // memory dbs report 'memory'; assert pragma callable and journal set on file dbs
    const mode = db.pragma("journal_mode", { simple: true });
    expect(typeof mode).toBe("string");
  });
});

describe("ingestEvents", () => {
  it("stores raw events and upserts instance/strategy", () => {
    const db = openDb(":memory:");
    ingestEvents(db, "qkt-prod", [
      env({ strategyId: "latch", type: "trade", payload: { orderId: "o1", symbol: "XAUUSD", side: "BUY", price: 2350, qty: 0.1, ts: 1718000000000 } }),
    ]);
    expect(db.prepare("SELECT COUNT(*) c FROM events").get()).toMatchObject({ c: 1 });
    expect(db.prepare("SELECT id FROM instances").get()).toMatchObject({ id: "qkt-prod" });
    expect(db.prepare("SELECT strategy_id FROM strategies").get()).toMatchObject({ strategy_id: "latch" });
  });

  it("stores strategy metadata from lifecycle start events", () => {
    const db = openDb(":memory:");
    ingestEvents(db, "qkt-prod", [
      env({ strategyId: "hedge_straddle", type: "strategy.started", payload: {
        strategyId: "hedge_straddle",
        ts: 1718000000000,
        sourcePath: "/srv/qkt/strategies/hedge.qkt",
        dslVersion: 1,
        runtimeMode: "live",
        symbols: ["EXNESS:XAUUSD"],
      } }),
    ]);
    const row = db.prepare("SELECT metadata FROM strategies WHERE strategy_id='hedge_straddle'").get() as { metadata: string };
    expect(JSON.parse(row.metadata)).toMatchObject({
      strategyId: "hedge_straddle",
      sourcePath: "/srv/qkt/strategies/hedge.qkt",
      runtimeMode: "live",
    });
  });

  it("folds order lifecycle into a single orders row reaching FILLED", () => {
    const db = openDb(":memory:");
    ingestEvents(db, "qkt-prod", [
      env({ seq: 1, type: "order.submit", payload: { orderId: "o1", orderType: "Market", symbol: "XAUUSD", side: "BUY", qty: 0.1 } }),
      env({ seq: 2, type: "order.accepted", payload: { orderId: "o1", brokerOrderId: "b1" } }),
      env({ seq: 3, type: "order.filled", payload: { orderId: "o1", brokerOrderId: "b1", symbol: "XAUUSD", price: 2350, qty: 0.1 } }),
    ]);
    const row: any = db.prepare("SELECT * FROM orders WHERE order_id='o1'").get();
    expect(row.state).toBe("FILLED");
    expect(row.cum_qty).toBe(0.1);
    expect(row.avg_price).toBe(2350);
    expect(row.cum_qty_decimal).toBe("0.1");
    expect(row.avg_price_decimal).toBe("2350");
  });

  it("appends equity snapshots and updates strategy equity", () => {
    const db = openDb(":memory:");
    ingestEvents(db, "qkt-prod", [
      env({ strategyId: "latch", type: "snapshot.equity", payload: { strategyId: "latch", realized: 10, unrealized: -2, equity: 1008, startingBalance: 1000 } }),
    ]);
    expect(db.prepare("SELECT COUNT(*) c FROM equity_snapshots").get()).toMatchObject({ c: 1 });
    expect(db.prepare("SELECT equity FROM strategies WHERE strategy_id='latch'").get()).toMatchObject({ equity: 1008 });
    expect(db.prepare("SELECT equity_decimal FROM equity_snapshots").get()).toMatchObject({ equity_decimal: "1008" });
  });

  it("indexes events into FTS so search can find them by symbol", () => {
    const db = openDb(":memory:");
    ingestEvents(db, "qkt-prod", [
      env({ type: "trade", payload: { orderId: "o1", symbol: "XAUUSD", side: "BUY", price: 2350, qty: 0.1, ts: 1718000000000 } }),
    ]);
    const hits: any[] = db.prepare("SELECT event_rowid FROM events_fts WHERE events_fts MATCH 'XAUUSD'").all();
    expect(hits.length).toBe(1);
  });

  it("is idempotent on duplicate event ids (instance-scoped)", () => {
    const db = openDb(":memory:");
    const e = env({ id: "dup", type: "trade", payload: { orderId: "o1", symbol: "X", side: "BUY", price: 1, qty: 1, ts: 1 } });
    ingestEvents(db, "qkt-prod", [e]);
    ingestEvents(db, "qkt-prod", [e]);
    expect(db.prepare("SELECT COUNT(*) c FROM events").get()).toMatchObject({ c: 1 });
  });

  it("records duplicate observations without treating producer-local seq as delivery continuity", () => {
    const db = openDb(":memory:");
    const trade = (id: string, seq: number) => env({
      id, seq, type: "trade",
      payload: { orderId: id, symbol: "XAUUSD", side: "BUY", price: 2350, qty: 0.1, ts: 1718000000000 },
    });
    ingestEvents(db, "qkt-prod", [trade("e1", 1), trade("e3", 3), trade("e2", 2), trade("e3", 3)]);
    expect(db.prepare("SELECT kind, event_id eventId, seq, previous_seq previousSeq, expected_seq expectedSeq FROM ingest_observations ORDER BY id").all()).toEqual([
      { kind: "duplicate", eventId: "e3", seq: 3, previousSeq: null, expectedSeq: null },
    ]);
  });
});

describe("broker state ingest hygiene", () => {
  const deal = () => env({ id: "deal-EXNESS-456", strategyId: "hedge_straddle", type: "broker.deal", payload: {
    broker: "EXNESS", dealTicket: "456", positionTicket: "123", orderTicket: "789",
    symbol: "EXNESS:XAUUSD", side: "SELL", entry: "OUT", qty: 0.01, price: 2310.2,
    profit: 9.7, commission: -0.07, swap: -0.12, magic: 10001,
    comment: "dsl-hedge_straddle", ts: 1781201000000, strategyId: "hedge_straddle",
  } });

  it("broker.deal persists to deals, skips events and FTS, dedupes by id", () => {
    const db = openDb(":memory:");
    expect(ingestEvents(db, "qkt-prod", [deal()])).toBe(1);
    expect(ingestEvents(db, "qkt-prod", [deal()])).toBe(0);
    expect(db.prepare("SELECT COUNT(*) c FROM deals").get()).toMatchObject({ c: 1 });
    expect(db.prepare("SELECT COUNT(*) c FROM events").get()).toMatchObject({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM events_fts").get()).toMatchObject({ c: 0 });
    expect(db.prepare("SELECT id FROM instances").get()).toMatchObject({ id: "qkt-prod" });
    expect(db.prepare("SELECT strategy_id FROM strategies").get()).toMatchObject({ strategy_id: "hedge_straddle" });
    const row: any = db.prepare("SELECT * FROM deals").get();
    expect(row).toMatchObject({ broker: "EXNESS", deal_ticket: "456", entry: "OUT", profit: 9.7, strategy_id: "hedge_straddle" });
    expect(row).toMatchObject({ qty_decimal: "0.01", price_decimal: "2310.2", profit_decimal: "9.7" });
  });

  it("snapshot.equity no longer writes events or FTS rows", () => {
    const db = openDb(":memory:");
    const accepted = ingestEvents(db, "qkt-prod", [
      env({ strategyId: "latch", type: "snapshot.equity", payload: { strategyId: "latch", realized: 10, unrealized: -2, equity: 1008, startingBalance: 1000 } }),
    ]);
    expect(accepted).toBe(1);
    expect(db.prepare("SELECT COUNT(*) c FROM equity_snapshots").get()).toMatchObject({ c: 1 });
    expect(db.prepare("SELECT equity FROM strategies WHERE strategy_id='latch'").get()).toMatchObject({ equity: 1008 });
    expect(db.prepare("SELECT COUNT(*) c FROM events").get()).toMatchObject({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM events_fts").get()).toMatchObject({ c: 0 });
  });

  it("snapshot.position is dropped entirely", () => {
    const db = openDb(":memory:");
    const accepted = ingestEvents(db, "qkt-prod", [
      env({ strategyId: "latch", type: "snapshot.position", payload: { strategyId: "latch", symbol: "XAUUSD", legs: [] } }),
    ]);
    expect(accepted).toBe(0);
    expect(db.prepare("SELECT COUNT(*) c FROM events").get()).toMatchObject({ c: 0 });
    expect(db.prepare("SELECT id FROM instances").get()).toMatchObject({ id: "qkt-prod" });
  });

  it("state.* envelopes never reach the db", () => {
    const db = openDb(":memory:");
    const accepted = ingestEvents(db, "qkt-prod", [
      env({ type: "state.account", payload: { broker: "EXNESS", currency: "USD", balance: 7824.05, equity: 7676.54 } }),
      env({ type: "state.positions", payload: { broker: "EXNESS", positions: [] } }),
    ]);
    expect(accepted).toBe(0);
    expect(db.prepare("SELECT COUNT(*) c FROM events").get()).toMatchObject({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM instances").get()).toMatchObject({ c: 0 });
  });

  it("persists state.positions into durable current and valuation projections without raw events", () => {
    const db = openDb(":memory:");
    const first = env({ id: "posn-1", seq: 10, ts: 1718000000000, type: "state.positions", payload: {
      broker: "EXNESS",
      positions: [
        { ticket: "123", symbol: "EXNESS:XAUUSD", side: "BUY", qty: 0.01, entryPrice: 2300.5, currentPrice: 2310.2, profit: 9.7, strategyId: "hedge_straddle" },
        { ticket: "124", symbol: "EXNESS:EURUSD", side: "SELL", qty: 0.02, entryPrice: 1.08, currentPrice: 1.07, profit: 20, strategyId: null },
      ],
    } });
    const second = env({ id: "posn-2", seq: 11, ts: 1718000060000, type: "state.positions", payload: {
      broker: "EXNESS",
      positions: [
        { ticket: "123", symbol: "EXNESS:XAUUSD", side: "BUY", qty: 0.01, entryPrice: 2300.5, currentPrice: 2315.2, profit: 14.7, strategyId: "hedge_straddle" },
      ],
    } });
    persistStateEvent(db, "qkt-prod", first);
    persistStateEvent(db, "qkt-prod", second);

    expect(db.prepare("SELECT COUNT(*) c FROM events").get()).toMatchObject({ c: 0 });
    expect(db.prepare("SELECT ticket, current_price, profit FROM positions_current ORDER BY ticket").all()).toEqual([
      { ticket: "123", current_price: 2315.2, profit: 14.7 },
    ]);
    expect(db.prepare("SELECT qty_decimal, current_price_decimal, profit_decimal FROM positions_current WHERE ticket='123'").get())
      .toMatchObject({ qty_decimal: "0.01", current_price_decimal: "2315.2", profit_decimal: "14.7" });
    expect(db.prepare("SELECT COUNT(*) c FROM position_valuations").get()).toMatchObject({ c: 3 });
  });

  it("resolves a position tagged with the DSL stream alias to its sleeve id via the deal", () => {
    const db = openDb(":memory:");
    // deal attributes broker position ticket 3079627120 to the sleeve forward_bench_2:s0
    ingestEvents(db, "qkt-prod", [env({ id: "deal-nz", strategyId: "forward_bench_2:s0", type: "broker.deal", payload: {
      broker: "EXNESS", dealTicket: "d1", positionTicket: "3079627120", orderTicket: "o1",
      symbol: "EXNESS_S10:NZDUSD", side: "SELL", entry: "IN", qty: 0.28, price: 0.58596,
      profit: 0, magic: 20010, comment: "dsl-fx2_NZDUSD_0--0", ts: 1718000000000, strategyId: "forward_bench_2:s0",
    } })]);
    // the live position for the same ticket arrives tagged with the DSL stream alias
    persistStateEvent(db, "qkt-prod", env({ id: "posn-nz", seq: 5, ts: 1718000060000, type: "state.positions", payload: {
      broker: "EXNESS",
      positions: [
        { ticket: "3079627120", symbol: "EXNESS_S10:NZDUSD", side: "SELL", qty: 0.28, entryPrice: 0.58596, currentPrice: 0.5918, profit: -163.52, strategyId: "fx2_NZDUSD_0" },
      ],
    } }));

    expect(db.prepare("SELECT strategy_id FROM positions_current WHERE ticket='3079627120'").get())
      .toMatchObject({ strategy_id: "forward_bench_2:s0" });
    expect(db.prepare("SELECT DISTINCT strategy_id s FROM position_valuations WHERE ticket='3079627120'").get())
      .toMatchObject({ s: "forward_bench_2:s0" });
  });

  it("keeps the raw position strategy id when no deal has attributed the ticket yet", () => {
    const db = openDb(":memory:");
    persistStateEvent(db, "qkt-prod", env({ id: "posn-raw", seq: 5, ts: 1718000060000, type: "state.positions", payload: {
      broker: "EXNESS",
      positions: [{ ticket: "999", symbol: "EXNESS:EURUSD", side: "BUY", qty: 0.1, entryPrice: 1.08, currentPrice: 1.081, profit: 10, strategyId: "some_stream" }],
    } }));
    expect(db.prepare("SELECT strategy_id FROM positions_current WHERE ticket='999'").get())
      .toMatchObject({ strategy_id: "some_stream" });
  });


  it("counts a deal once when several broker profiles polling one account store copies", () => {
    const db = openDb(":memory:");
    const dealPayload = (broker: string, strategyId: string | null, id: string) => env({ id, strategyId: strategyId ?? undefined, type: "broker.deal", payload: {
      broker, dealTicket: "777", positionTicket: "70", orderTicket: "o7",
      symbol: `${broker}:XAUUSD`, side: "SELL", entry: "OUT", qty: 0.01, price: 4460,
      profit: -18.12, commission: 0, swap: 0, magic: 20009, comment: "",
      ts: 1718000200000, strategyId,
    } });
    // the owning profile stores first with the right sleeve; a sibling profile
    // polls the same account later and guesses a different sleeve
    ingestEvents(db, "qkt-prod", [dealPayload("EXNESS_S9", "forward_bench:s9", "deal-own")]);
    ingestEvents(db, "qkt-prod", [dealPayload("EXNESS_S0", "forward_bench:s0", "deal-sibling")]);
    // write-side dedupe drops the sibling copy outright on a fresh schema; DBs
    // created before that constraint still hold copies, which canonicalDeal
    // collapses at query time — simulate one such legacy row.
    expect(db.prepare("SELECT COUNT(*) c FROM deals WHERE deal_ticket='777'").get()).toMatchObject({ c: 1 });
    db.prepare(`INSERT INTO deals (id, instance_id, broker, deal_ticket, position_ticket, order_ticket,
        symbol, side, entry, qty, price, profit, commission, swap, magic, comment, strategy_id, ts)
      VALUES ('deal-legacy-copy','qkt-prod','EXNESS_S0','777','70','o7','EXNESS_S0:XAUUSD','SELL','OUT',
        0.01,4460,-18.12,0,0,20009,'','forward_bench:s0',1718000200000)`).run();
    expect(db.prepare("SELECT COUNT(*) c FROM deals WHERE deal_ticket='777'").get()).toMatchObject({ c: 2 });

    const own = closedTrades(db, { instanceId: "qkt-prod", strategyId: "forward_bench:s9" });
    expect(own).toHaveLength(1);
    expect(own[0]!.realized).toBeCloseTo(-18.12);
    // the sibling copy is not a second trade anywhere
    expect(closedTrades(db, { instanceId: "qkt-prod", strategyId: "forward_bench:s0" })).toHaveLength(0);
  });

  it("does not lose durable position attribution to a sibling poller", () => {
    const db = openDb(":memory:");
    const attributed = env({ id: "posn-owner", seq: 10, ts: 1718000000000, type: "state.positions", payload: {
      broker: "EXNESS", positions: [
        { ticket: "123", symbol: "EXNESS:XAUUSD", side: "BUY", qty: 0.01,
          entryPrice: 2300.5, currentPrice: 2310.2, profit: 9.7, strategyId: "hedge_straddle" },
      ],
    } });
    const sibling = env({ id: "posn-sibling", seq: 11, ts: 1718000001000, type: "state.positions", payload: {
      broker: "EXNESS", positions: [
        { ticket: "123", symbol: "EXNESS:XAUUSD", side: "BUY", qty: 0.01,
          entryPrice: 2300.5, currentPrice: 2310.3, profit: 9.8, strategyId: null },
      ],
    } });

    persistStateEvent(db, "qkt-prod", attributed);
    persistStateEvent(db, "qkt-prod", sibling);

    expect(db.prepare("SELECT strategy_id, profit FROM positions_current WHERE ticket='123'").get())
      .toMatchObject({ strategy_id: "hedge_straddle", profit: 9.8 });
    expect(db.prepare("SELECT strategy_id FROM position_valuations WHERE ticket='123' ORDER BY ts DESC LIMIT 1").get())
      .toMatchObject({ strategy_id: "hedge_straddle" });
  });

  it("re-ingesting a deal upgrades the NULL strategy once it becomes resolvable", () => {
    const db = openDb(":memory:");
    // A deal whose dsl- comment names a strategy the store hasn't registered yet.
    const deal = () => env({ id: "deal-EXNESS-77", type: "broker.deal", payload: {
      broker: "EXNESS", dealTicket: "77", positionTicket: "900", orderTicket: "900",
      symbol: "EXNESS:XAUUSD", side: "BUY", entry: "IN", qty: 0.01, price: 4300,
      profit: 0, comment: "dsl-hedge_straddle", ts: 1781201000000 } });
    ingestEvents(db, "qkt-prod", [deal()]);
    // No strategies row to match the comment against → unattributed on the first pass.
    expect(db.prepare("SELECT strategy_id FROM deals WHERE deal_ticket='77'").get()).toMatchObject({ strategy_id: null });
    // The strategy registers later (its first snapshot/fill creates the row).
    db.prepare("INSERT INTO strategies (instance_id, strategy_id, first_seen, last_seen) VALUES ('qkt-prod','hedge_straddle',1,1)").run();
    // The 30d backfill re-sends the same deal → the comment now resolves and the NULL is filled.
    ingestEvents(db, "qkt-prod", [deal()]);
    expect(db.prepare("SELECT strategy_id FROM deals WHERE deal_ticket='77'").get()).toMatchObject({ strategy_id: "hedge_straddle" });
  });
});

describe("foldOrder out-of-order delivery", () => {
  it("keeps FILLED state and backfills fields when submit arrives after the fill", () => {
    const db = openDb(":memory:");
    ingestEvents(db, "qkt-prod", [
      env({ seq: 3, type: "order.accepted", payload: { orderId: "o1", brokerOrderId: "b1" } }),
      env({ seq: 4, type: "order.filled", payload: { orderId: "o1", brokerOrderId: "b1", symbol: "XAUUSD", price: 2350, qty: 0.1 } }),
      env({ seq: 2, strategyId: "latch", type: "order.submit", payload: { orderId: "o1", orderType: "Market", symbol: "XAUUSD", side: "BUY", qty: 0.1 } }),
    ]);
    const row: any = db.prepare("SELECT * FROM orders WHERE order_id='o1'").get();
    expect(row.state).toBe("FILLED");
    expect(row.side).toBe("BUY");
    expect(row.qty).toBe(0.1);
    expect(row.strategy_id).toBe("latch");
    expect(row.avg_price).toBe(2350);
  });

  it("accepts a later lifecycle event after the producer sequence restarts", () => {
    const db = openDb(":memory:");
    ingestEvents(db, "qkt-prod", [
      env({ seq: 99, ts: 1718000000000, type: "order.submit", payload: {
        orderId: "o1", orderType: "Market", symbol: "XAUUSD", side: "BUY", qty: 0.1,
      } }),
      env({ seq: 1, ts: 1718000001000, type: "order.filled", payload: {
        orderId: "o1", brokerOrderId: "b1", symbol: "XAUUSD", price: 2350, qty: 0.1,
      } }),
    ]);

    const row: any = db.prepare("SELECT * FROM orders WHERE order_id='o1'").get();
    expect(row.state).toBe("FILLED");
    expect(row.last_event_seq).toBe(1);
    expect(row.updated_ts).toBe(1718000001000);
  });
});


describe("enriched payload persistence", () => {
  it("stores additive order fields in the raw event payload", () => {
    const db = openDb(":memory:");
    ingestEvents(db, "qkt-prod", [
      env({ seq: 1, strategyId: "latch", type: "order.submit", payload: {
        orderId: "br1", orderType: "Bracket", symbol: "XAUUSD", side: "BUY", qty: 0.1,
        timeInForce: "GTC", takeProfit: 2360, stopLoss: { type: "Fixed", price: 2340 },
      } }),
    ]);
    const row = db.prepare("SELECT payload FROM events WHERE id IS NOT NULL").get() as { payload: string };
    const payload = JSON.parse(row.payload);
    expect(payload.timeInForce).toBe("GTC");
    expect(payload.stopLoss.price).toBe(2340);
  });

  it("projects position reconciliation, risk, and portfolio envelopes into durable tables", () => {
    const db = openDb(":memory:");
    ingestEvents(db, "qkt-prod", [
      env({ id: "recon-1", seq: 1, type: "position.reconciled", payload: {
        symbol: "EXNESS:XAUUSD", before: 0, after: 0.01, oldQty: 0, newQty: 0.01,
        oldAvgPx: null, newAvgPx: 2300.5, source: "EXNESS", reason: "startup",
      } }),
      env({ id: "risk-1", seq: 2, strategyId: "hedge", type: "risk.halted", payload: { strategyId: "hedge", reason: "daily-loss" } }),
      env({ id: "risk-snap-1", seq: 3, strategyId: "hedge", type: "risk.snapshot", payload: { strategyId: "hedge", equity: 980, dailyLoss: 20 } }),
      env({ id: "port-eq-1", seq: 4, type: "portfolio.equity.updated", payload: {
        portfolioId: "gold-book", equity: 10050, realized: 50, unrealized: 0,
      } }),
    ]);

    expect(db.prepare("SELECT symbol, new_qty newQty, source, reason FROM position_reconciliations").get())
      .toMatchObject({ symbol: "EXNESS:XAUUSD", newQty: 0.01, source: "EXNESS", reason: "startup" });
    expect(db.prepare("SELECT strategy_id strategyId, kind, reason FROM risk_events").get())
      .toMatchObject({ strategyId: "hedge", kind: "risk.halted", reason: "daily-loss" });
    expect(db.prepare("SELECT strategy_id strategyId FROM risk_snapshots").get())
      .toMatchObject({ strategyId: "hedge" });
    expect(db.prepare("SELECT portfolio_id portfolioId, equity FROM portfolio_equity").get())
      .toMatchObject({ portfolioId: "gold-book", equity: 10050 });
  });
});
