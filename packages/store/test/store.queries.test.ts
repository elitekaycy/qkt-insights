import { describe, it, expect, beforeEach } from "vitest";
import { openDb, ingestEvents, listInstances, listStrategies, listOrders, listTrades, searchEvents, equityCurve, instanceHealth } from "../src/index.js";
import type { Db } from "../src/index.js";
import type { Envelope } from "@qkt-insights/contract";

function env(p: any): Envelope {
  return { v: 1, instanceId: "qkt-prod", id: Math.random().toString(36).slice(2), seq: p.seq ?? 1, ts: p.ts ?? 1718000000000, ...p } as Envelope;
}

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
  ingestEvents(db, "qkt-prod", [
    env({ strategyId: "latch", type: "order.submit", payload: { orderId: "o1", orderType: "Market", symbol: "XAUUSD", side: "BUY", qty: 0.1 } }),
    env({ strategyId: "latch", type: "order.filled", payload: { orderId: "o1", brokerOrderId: "b1", symbol: "XAUUSD", price: 2350, qty: 0.1 } }),
    env({ strategyId: "latch", type: "trade", ts: 1718000001000, payload: { orderId: "o1", symbol: "XAUUSD", side: "BUY", price: 2350, qty: 0.1, ts: 1718000001000 } }),
    env({ strategyId: "latch", type: "snapshot.equity", ts: 1718000002000, payload: { strategyId: "latch", realized: 5, unrealized: 0, equity: 1005, startingBalance: 1000 } }),
  ]);
  ingestEvents(db, "qkt-demo", [
    env({ instanceId: "qkt-demo", strategyId: "macd", type: "trade", payload: { orderId: "x1", symbol: "EURUSD", side: "SELL", price: 1.08, qty: 1, ts: 1718000000000 } }),
  ]);
});

describe("queries", () => {
  it("lists instances", () => {
    expect(listInstances(db).map((i) => i.id).sort()).toEqual(["qkt-demo", "qkt-prod"]);
  });
  it("lists strategies for an instance", () => {
    expect(listStrategies(db, "qkt-prod").map((s) => s.strategyId)).toEqual(["latch"]);
  });
  it("lists orders filtered by instance and state", () => {
    const rows = listOrders(db, { instanceId: "qkt-prod", state: "FILLED", limit: 50 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.orderId).toBe("o1");
  });
  it("lists trades filtered by symbol", () => {
    const rows = listTrades(db, { instanceId: "qkt-prod", symbol: "XAUUSD", limit: 50 });
    expect(rows).toHaveLength(1);
  });
  it("full-text searches events scoped to instance", () => {
    const hits = searchEvents(db, { q: "XAUUSD", instanceId: "qkt-prod", limit: 50 });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.every((h) => h.instanceId === "qkt-prod")).toBe(true);
  });
  it("returns equity curve points ordered by ts", () => {
    const pts = equityCurve(db, { instanceId: "qkt-prod", strategyId: "latch" });
    expect(pts).toEqual([{ ts: 1718000002000, equity: 1005, realized: 5, unrealized: 0 }]);
  });
  it("reports instance health with last seen and seq", () => {
    const h = instanceHealth(db);
    const prod = h.find((x) => x.instanceId === "qkt-prod")!;
    expect(prod.lastSeq).toBeGreaterThanOrEqual(1);
    expect(prod.strategies).toBe(1);
  });

  it("downsamples a dense equity curve to real bucketed snapshots", () => {
    const T0 = 1718100000000;
    for (let batch = 0; batch < 3; batch++) {
      ingestEvents(db, "qkt-prod", Array.from({ length: 1000 }, (_, j) => {
        const i = batch * 1000 + j;
        return env({ strategyId: "dense", type: "snapshot.equity", ts: T0 + i * 5000,
          payload: { strategyId: "dense", realized: i, unrealized: 0, equity: 1000 + i, startingBalance: 1000 } });
      }));
    }
    const pts = equityCurve(db, { instanceId: "qkt-prod", strategyId: "dense", points: 500 });
    expect(pts.length).toBeLessThanOrEqual(501);
    expect(pts.length).toBeGreaterThanOrEqual(400);
    // Endpoints survive: the newest snapshot is always the last bucket's last row.
    expect(pts[pts.length - 1]).toMatchObject({ ts: T0 + 2999 * 5000, equity: 3999 });
    // Every point is a stored row, never an interpolation.
    for (const p of pts) expect(p.equity - 1000).toBe((p.ts - T0) / 5000);
    // Order preserved.
    for (let i = 1; i < pts.length; i++) expect(pts[i]!.ts).toBeGreaterThan(pts[i - 1]!.ts);
  });

  it("returns the full curve when under the point budget", () => {
    const pts = equityCurve(db, { instanceId: "qkt-prod", strategyId: "latch", points: 1000 });
    expect(pts).toHaveLength(1);
  });

  it("does not grow strategy rows from log envelopes", () => {
    ingestEvents(db, "qkt-prod", [
      env({ strategyId: "latch-deploy-name", type: "log", ts: 1718000003000,
        payload: { level: "INFO", logger: "com.qkt.x", message: "hello", ts: 1718000003000 } }),
    ]);
    expect(listStrategies(db, "qkt-prod").map((s) => s.strategyId)).toEqual(["latch"]);
  });
});
