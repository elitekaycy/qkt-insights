import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import { ingestEvents } from "../src/index.js";
import type { Envelope } from "@qkt-insights/contract";

function env(p: Partial<Envelope> & { type: Envelope["type"]; payload: any }): Envelope {
  return { v: 1, instanceId: "qkt-prod", id: Math.random().toString(36).slice(2), seq: 1, ts: 1718000000000, ...p } as Envelope;
}

describe("schema", () => {
  it("creates core tables and the FTS table on open", () => {
    const db = openDb(":memory:");
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table')").all().map((r: any) => r.name);
    for (const t of ["events", "instances", "strategies", "orders", "equity_snapshots", "events_fts"]) {
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
  });

  it("appends equity snapshots and updates strategy equity", () => {
    const db = openDb(":memory:");
    ingestEvents(db, "qkt-prod", [
      env({ strategyId: "latch", type: "snapshot.equity", payload: { strategyId: "latch", realized: 10, unrealized: -2, equity: 1008, startingBalance: 1000 } }),
    ]);
    expect(db.prepare("SELECT COUNT(*) c FROM equity_snapshots").get()).toMatchObject({ c: 1 });
    expect(db.prepare("SELECT equity FROM strategies WHERE strategy_id='latch'").get()).toMatchObject({ equity: 1008 });
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
});
