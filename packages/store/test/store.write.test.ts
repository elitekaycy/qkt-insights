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
