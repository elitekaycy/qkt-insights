import { describe, it, expect } from "vitest";
import {
  openDb, ingestEvents, listDeals, dealClosedTrades, costDecomposition, LiveStateStore, type Db,
} from "../src/index.js";
import type { Envelope } from "@qkt-insights/contract";

const T0 = Date.UTC(2026, 6, 6); // Mon 2026-07-06
const HOUR = 3_600_000;

function seedStrategy(db: Db): void {
  db.prepare(
    "INSERT INTO strategies (instance_id, strategy_id, first_seen, last_seen, starting_balance) VALUES (?,?,?,?,?)",
  ).run("qkt-prod", "latch", T0, T0, 10000);
}

let seq = 0;
function env(type: string, payload: Record<string, unknown>, ts = T0): Envelope {
  return { v: 1, instanceId: "qkt-prod", id: `rt-${++seq}`, seq, ts, type, payload } as Envelope;
}

describe("deal fee round-trip (#781)", () => {
  it("stores fee on the deal row and folds it into realized and cost decomposition", () => {
    const db = openDb(":memory:");
    seedStrategy(db);
    ingestEvents(db, "qkt-prod", [
      env("broker.deal", {
        broker: "EX", dealTicket: "1", positionTicket: "9", symbol: "EX:XAUUSD", side: "BUY",
        entry: "IN", qty: 0.01, price: 4300, profit: 0, strategyId: "latch", ts: T0,
      }, T0),
      env("broker.deal", {
        broker: "EX", dealTicket: "2", positionTicket: "9", symbol: "EX:XAUUSD", side: "SELL",
        entry: "OUT", qty: 0.01, price: 4310, profit: 10, commission: -0.5, swap: -0.25,
        fee: -0.75, clientOrderId: "qkt-abc-123", strategyId: "latch", ts: T0 + HOUR,
      }, T0 + HOUR),
    ]);
    const deals = listDeals(db, { instanceId: "qkt-prod", limit: 10 });
    expect(deals.find((d) => d.dealTicket === "2")!.fee).toBe(-0.75);

    const f = { instanceId: "qkt-prod", strategyId: "latch" };
    const closes = dealClosedTrades(db, f);
    expect(closes).toHaveLength(1);
    expect(closes[0]!.realized).toBeCloseTo(10 - 0.5 - 0.25 - 0.75);

    const c = costDecomposition(db, f)!;
    expect(c.total.fee).toBeCloseTo(-0.75);
    expect(c.total.net).toBeCloseTo(closes[0]!.realized);
  });

  it("treats absent fee as zero — pre-migration history unchanged", () => {
    const db = openDb(":memory:");
    seedStrategy(db);
    ingestEvents(db, "qkt-prod", [
      env("broker.deal", { broker: "EX", dealTicket: "1", positionTicket: "9", symbol: "EX:XAUUSD",
        side: "BUY", entry: "IN", qty: 0.01, price: 4300, profit: 0, strategyId: "latch", ts: T0 }, T0),
      env("broker.deal", { broker: "EX", dealTicket: "2", positionTicket: "9", symbol: "EX:XAUUSD",
        side: "SELL", entry: "OUT", qty: 0.01, price: 4310, profit: 10, commission: -0.5,
        strategyId: "latch", ts: T0 + HOUR }, T0 + HOUR),
    ]);
    const f = { instanceId: "qkt-prod", strategyId: "latch" };
    expect(dealClosedTrades(db, f)[0]!.realized).toBeCloseTo(9.5);
    expect(costDecomposition(db, f)!.total.fee).toBe(0);
  });
});

describe("state.positions risk fields (#780)", () => {
  it("keeps venue and requested SL/TP plus identity fields in the live snapshot", () => {
    const live = new LiveStateStore();
    const changed = live.upsert("qkt-prod", env("state.positions", {
      broker: "EX",
      positions: [{
        ticket: "77", symbol: "EX:XAUUSD", side: "BUY", qty: 0.02, entryPrice: 4300,
        currentPrice: 4310, profit: 20, stopLoss: 4290, takeProfit: 4350,
        requestedStopLoss: 4291, requestedTakeProfit: 4350, magic: 777001, clientOrderId: "qkt-ord-1",
      }],
    }));
    expect(changed).toBe(true);
    const pos = live.snapshot(T0).positions[0]!.list[0]!;
    expect(pos).toMatchObject({
      ticket: "77", stopLoss: 4290, takeProfit: 4350,
      requestedStopLoss: 4291, requestedTakeProfit: 4350, magic: 777001, clientOrderId: "qkt-ord-1",
    });
  });
});

describe("state.orders (#782)", () => {
  it("holds the pending-order list per broker, full-replace, with staleness", () => {
    const live = new LiveStateStore();
    const order = {
      ticket: "501", symbol: "EX:XAUUSD", side: "BUY", orderType: "ORDER_TYPE_BUY_LIMIT",
      qty: 0.01, price: 4250, stopLoss: 4200, takeProfit: 4400, expiresAt: T0 + 12 * HOUR,
      createdAt: T0, magic: 777001, clientOrderId: "qkt-ord-2",
    };
    expect(live.upsert("qkt-prod", env("state.orders", { broker: "EX", orders: [order] }))).toBe(true);
    const snap = live.snapshot(T0 + 1000);
    expect(snap.orders).toHaveLength(1);
    expect(snap.orders[0]!.list[0]).toMatchObject({ ticket: "501", expiresAt: T0 + 12 * HOUR, stopLoss: 4200 });
    expect(snap.orders[0]!.stale).toBe(false);

    // Full replace: an empty list clears it; unchanged replace reports no change.
    expect(live.upsert("qkt-prod", env("state.orders", { broker: "EX", orders: [order] }))).toBe(false);
    expect(live.upsert("qkt-prod", env("state.orders", { broker: "EX", orders: [] }))).toBe(true);
    expect(live.snapshot(T0 + 2000).orders[0]!.list).toHaveLength(0);

    // Stale after the poller stops reporting.
    expect(live.snapshot(T0 + 60_000).orders[0]!.stale).toBe(true);
  });
});
