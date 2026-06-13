import { describe, it, expect } from "vitest";
import {
  openDb, ingestEvents, dealClosedTrades, strategyEquityCurve, performanceReport, dailyNets,
  drawdownPeriods, tradeBreakdowns, closedTrades, equityCurve, strategyStats, type Db,
} from "../src/index.js";
import type { Envelope } from "@qkt-insights/contract";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 4, 11); // Mon 2026-05-11

function dealEnv(p: {
  ticket: string; positionTicket: string; entry: "IN" | "OUT" | "INOUT" | "OUT_BY"; side: "BUY" | "SELL";
  ts: number; price: number; qty?: number; profit?: number; commission?: number; swap?: number;
  strategyId?: string;
}): Envelope {
  return {
    v: 1, instanceId: "qkt-prod", id: `deal-EXNESS-${p.ticket}`, seq: 1, ts: p.ts,
    type: "broker.deal",
    payload: {
      broker: "EXNESS", dealTicket: p.ticket, positionTicket: p.positionTicket,
      symbol: "EXNESS:XAUUSD", side: p.side, entry: p.entry, qty: p.qty ?? 0.01, price: p.price,
      profit: p.profit ?? 0, commission: p.commission ?? 0, swap: p.swap ?? 0,
      comment: "dsl-hedge_straddle", strategyId: p.strategyId ?? "hedge_straddle", ts: p.ts,
    },
  } as Envelope;
}

function seedStrategy(db: Db, id: string, sb: number | null): void {
  db.prepare(
    "INSERT INTO strategies (instance_id, strategy_id, first_seen, last_seen, starting_balance) VALUES (?,?,?,?,?)",
  ).run("qkt-prod", id, T0, T0, sb);
}

/**
 * Three positions for hedge_straddle (sb 10000):
 * - pos 1: long, opened T0, closed T0+1h at +9.81 (10 - 0.07 - 0.12)
 * - pos 2: short, opened T0+2h, closed T0+DAY at -10.07 (-10 - 0.07)
 * - pos 3: long 0.02, opened T0+DAY+1h, two partial closes the next day: +4.93, +3
 */
function seeded(): Db {
  const db = openDb(":memory:");
  seedStrategy(db, "hedge_straddle", 10000);
  ingestEvents(db, "qkt-prod", [
    dealEnv({ ticket: "1", positionTicket: "100", entry: "IN", side: "BUY", ts: T0, price: 4300 }),
    dealEnv({ ticket: "2", positionTicket: "100", entry: "OUT", side: "SELL", ts: T0 + HOUR, price: 4310, profit: 10, commission: -0.07, swap: -0.12 }),
    dealEnv({ ticket: "3", positionTicket: "101", entry: "IN", side: "SELL", ts: T0 + 2 * HOUR, price: 4320 }),
    dealEnv({ ticket: "4", positionTicket: "101", entry: "OUT", side: "BUY", ts: T0 + DAY, price: 4330, profit: -10, commission: -0.07 }),
    dealEnv({ ticket: "5", positionTicket: "102", entry: "IN", side: "BUY", ts: T0 + DAY + HOUR, price: 4340, qty: 0.02 }),
    dealEnv({ ticket: "6", positionTicket: "102", entry: "OUT", side: "SELL", ts: T0 + 2 * DAY, price: 4350, profit: 5, commission: -0.07 }),
    dealEnv({ ticket: "7", positionTicket: "102", entry: "OUT_BY", side: "SELL", ts: T0 + 2 * DAY + HOUR, price: 4355, profit: 3 }),
  ]);
  return db;
}

const F = { instanceId: "qkt-prod", strategyId: "hedge_straddle" };

describe("dealClosedTrades", () => {
  it("pairs each closing leg with its position's IN, oldest first", () => {
    const rows = dealClosedTrades(seeded(), F);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      orderId: "100", symbol: "EXNESS:XAUUSD", side: "BUY", qty: 0.01,
      entryPrice: 4300, exitPrice: 4310, price: 4310,
      entryTs: T0, ts: T0 + HOUR, holdMs: HOUR,
    });
    expect(rows[0]!.realized).toBeCloseTo(9.81);
    expect(rows[1]).toMatchObject({ orderId: "101", side: "SELL", entryPrice: 4320, exitPrice: 4330 });
    expect(rows[1]!.realized).toBeCloseTo(-10.07);
  });

  it("pairs every partial close of a position with the single IN", () => {
    const rows = dealClosedTrades(seeded(), F);
    const partials = rows.filter((r) => r.orderId === "102");
    expect(partials).toHaveLength(2);
    for (const p of partials) {
      expect(p.entryTs).toBe(T0 + DAY + HOUR);
      expect(p.entryPrice).toBe(4340);
      expect(p.side).toBe("BUY");
    }
    expect(partials[0]!.realized).toBeCloseTo(4.93);
    expect(partials[1]!.realized).toBeCloseTo(3);
  });

  it("honors from/to on the close timestamp", () => {
    const rows = dealClosedTrades(seeded(), { ...F, from: T0 + DAY });
    expect(rows.map((r) => r.orderId)).toEqual(["101", "102", "102"]);
  });

  it("returns empty for a strategy without closing deals", () => {
    expect(dealClosedTrades(seeded(), { instanceId: "qkt-prod", strategyId: "latch_stack" })).toEqual([]);
  });
});

describe("strategyEquityCurve", () => {
  it("anchors at the starting balance and steps by cumulative realized", () => {
    const pts = strategyEquityCurve(seeded(), F);
    expect(pts).toHaveLength(5);
    expect(pts[0]).toMatchObject({ ts: T0, equity: 10000, realized: 0, unrealized: 0 });
    expect(pts[1]!.equity).toBeCloseTo(10009.81);
    expect(pts[2]!.equity).toBeCloseTo(9999.74);
    expect(pts[4]!.equity).toBeCloseTo(10007.67);
    expect(pts[4]!.realized).toBeCloseTo(7.67);
    for (const p of pts) expect(p.unrealized).toBe(0);
  });

  it("falls back to a cumulative-P&L curve when no starting balance is stored", () => {
    const db = openDb(":memory:");
    seedStrategy(db, "bare", null);
    ingestEvents(db, "qkt-prod", [
      dealEnv({ ticket: "1", positionTicket: "100", entry: "IN", side: "BUY", ts: T0, price: 4300, strategyId: "bare" }),
      dealEnv({ ticket: "2", positionTicket: "100", entry: "OUT", side: "SELL", ts: T0 + HOUR, price: 4310, profit: 10, strategyId: "bare" }),
    ]);
    const pts = strategyEquityCurve(db, { instanceId: "qkt-prod", strategyId: "bare" });
    expect(pts[0]).toMatchObject({ ts: T0, equity: 0 });
    expect(pts[1]).toMatchObject({ equity: 10, realized: 10 });
  });

  it("is empty without closing deals", () => {
    expect(strategyEquityCurve(seeded(), { instanceId: "qkt-prod", strategyId: "latch_stack" })).toEqual([]);
  });
});

describe("deals-backed analytics", () => {
  it("performanceReport reads deals and is exact, not approximate", () => {
    const r = performanceReport(seeded(), F);
    expect(r.approximate).toBe(false);
    expect(r.wins).toBe(3);
    expect(r.losses).toBe(1);
    expect(r.totalNet).toBeCloseTo(7.67);
    expect(r.grossProfit).toBeCloseTo(9.81 + 4.93 + 3);
    expect(r.grossLoss).toBeCloseTo(10.07);
  });

  it("dailyNets groups closing deals per UTC day", () => {
    const days = dailyNets(seeded(), F);
    expect(days).toHaveLength(3);
    expect(days[0]!.net).toBeCloseTo(9.81);
    expect(days[0]!.trades).toBe(1);
    expect(days[1]!.net).toBeCloseTo(-10.07);
    expect(days[2]!.net).toBeCloseTo(7.93);
    expect(days[2]!.trades).toBe(2);
  });

  it("drawdownPeriods walks the deals curve", () => {
    const periods = drawdownPeriods(seeded(), F);
    expect(periods).toHaveLength(1);
    expect(periods[0]!.depth).toBeCloseTo(10.07);
    // The last close (10007.67) never re-reaches the 10009.81 peak: still underwater.
    expect(periods[0]!.recoveryTs).toBeNull();
  });

  it("closedTrades serves the deals rows newest first", () => {
    const rows = closedTrades(seeded(), F);
    expect(rows[0]).toMatchObject({ orderId: "102", ts: T0 + 2 * DAY + HOUR });
    expect(rows[3]).toMatchObject({ orderId: "100" });
  });

  it("tradeBreakdowns builds from the deals rows with hold times", () => {
    const b = tradeBreakdowns(seeded(), F)!;
    expect(b.bySymbol[0]).toMatchObject({ key: "EXNESS:XAUUSD", trades: 4, wins: 3 });
    expect(b.bySymbol[0]!.net).toBeCloseTo(7.67);
    expect(b.holdTime).not.toBeNull();
  });

  it("strategyStats agrees with the report through the shared rows", () => {
    const db = seeded();
    const s = strategyStats(db, F);
    const r = performanceReport(db, F);
    expect(s.tradeCount).toBe(4);
    expect(s.realizedPnl).toBeCloseTo(7.67);
    expect(s.winRate).toBeCloseTo(r.winRate! / 100);
    expect(s.startingBalance).toBe(10000);
    expect(s.equity).toBeCloseTo(10007.67);
    expect(s.returnPct).toBeCloseTo(7.67 / 10000);
    expect(s.maxDrawdownPct).toBeCloseTo(10.07 / 10009.81);
  });

  it("strategyStats derives buy/sell/volume from deal directions, not the empty events table", () => {
    const s = strategyStats(seeded(), F);
    expect(s.buyCount).toBe(3); // pos100 + pos102's two partials are long
    expect(s.sellCount).toBe(1); // pos101 is the only short
    expect(s.volume).toBeCloseTo(0.04);
  });
});

describe("equityCurve deals path", () => {
  it("serves the deals-rebuilt curve when closing deals exist", () => {
    const pts = equityCurve(seeded(), F);
    expect(pts).toHaveLength(5);
    expect(pts[0]).toMatchObject({ ts: T0, equity: 10000, realized: 0, unrealized: 0 });
    expect(pts[4]!.equity).toBeCloseTo(10007.67);
  });

  it("honors from/to on the deals curve", () => {
    const pts = equityCurve(seeded(), { ...F, from: T0 + DAY });
    expect(pts.map((p) => p.ts)).toEqual([T0 + DAY, T0 + 2 * DAY, T0 + 2 * DAY + HOUR]);
  });

  it("downsamples the deals curve to the point budget keeping endpoints", () => {
    const db = openDb(":memory:");
    seedStrategy(db, "dense", 1000);
    const events: Envelope[] = [];
    for (let i = 0; i < 40; i++) {
      events.push(dealEnv({ ticket: `i${i}`, positionTicket: `p${i}`, entry: "IN", side: "BUY", ts: T0 + i * HOUR, price: 4300, strategyId: "dense" }));
      events.push(dealEnv({ ticket: `o${i}`, positionTicket: `p${i}`, entry: "OUT", side: "SELL", ts: T0 + i * HOUR + 1000, price: 4301, profit: 1, strategyId: "dense" }));
    }
    ingestEvents(db, "qkt-prod", events);
    const pts = equityCurve(db, { instanceId: "qkt-prod", strategyId: "dense", points: 10 });
    expect(pts.length).toBeLessThanOrEqual(11);
    expect(pts[pts.length - 1]).toMatchObject({ ts: T0 + 39 * HOUR + 1000, equity: 1040 });
    for (let i = 1; i < pts.length; i++) expect(pts[i]!.ts).toBeGreaterThan(pts[i - 1]!.ts);
  });

  it("keeps the snapshot path for strategies without deals", () => {
    const db = openDb(":memory:");
    ingestEvents(db, "qkt-prod", [
      { v: 1, instanceId: "qkt-prod", id: "s1", seq: 1, ts: T0, strategyId: "paper", type: "snapshot.equity",
        payload: { strategyId: "paper", realized: 5, unrealized: 0, equity: 1005, startingBalance: 1000 } } as Envelope,
    ]);
    expect(equityCurve(db, { instanceId: "qkt-prod", strategyId: "paper" })).toEqual([
      { ts: T0, equity: 1005, realized: 5, unrealized: 0 },
    ]);
  });
});

describe("engine order linking", () => {
  const order = (orderId: string, brokerOrderId: string, side: "BUY" | "SELL", ts: number): Envelope[] => [
    { v: 1, instanceId: "qkt-prod", id: `${orderId}-submit`, seq: 1, ts, strategyId: "hedge_straddle",
      type: "order.submit", payload: { orderId, orderType: "Market", symbol: "EXNESS:XAUUSD", side, qty: 0.01 } } as Envelope,
    { v: 1, instanceId: "qkt-prod", id: `${orderId}-accept`, seq: 2, ts: ts + 1,
      type: "order.accepted", payload: { orderId, brokerOrderId } } as Envelope,
    { v: 1, instanceId: "qkt-prod", id: `${orderId}-fill`, seq: 3, ts: ts + 2,
      type: "order.filled", payload: { orderId, brokerOrderId, symbol: "EXNESS:XAUUSD", price: 4300, qty: 0.01 } } as Envelope,
  ];

  it("foldOrder persists the broker order id from accept and fill events", () => {
    const db = openDb(":memory:");
    ingestEvents(db, "qkt-prod", order("eng-1", "777", "BUY", T0));
    expect(db.prepare("SELECT broker_order_id b FROM orders WHERE order_id='eng-1'").get()).toMatchObject({ b: "777" });
  });

  it("foldOrder backfills the broker order id when accept arrives after the fill", () => {
    const db = openDb(":memory:");
    const [submit, accept, fill] = order("eng-2", "888", "SELL", T0);
    ingestEvents(db, "qkt-prod", [submit!, fill!, accept!]);
    expect(db.prepare("SELECT broker_order_id b FROM orders WHERE order_id='eng-2'").get()).toMatchObject({ b: "888" });
  });

  it("dealClosedTrades names the engine orders that opened and closed the position", () => {
    const db = openDb(":memory:");
    ingestEvents(db, "qkt-prod", [
      ...order("eng-open", "777", "BUY", T0),
      ...order("eng-close", "888", "SELL", T0 + HOUR),
      { v: 1, instanceId: "qkt-prod", id: "deal-EXNESS-31", seq: 1, ts: T0, type: "broker.deal",
        payload: { broker: "EXNESS", dealTicket: "31", positionTicket: "900", orderTicket: "777",
          symbol: "EXNESS:XAUUSD", side: "BUY", entry: "IN", qty: 0.01, price: 4300, profit: 0,
          ts: T0, strategyId: "hedge_straddle" } } as Envelope,
      { v: 1, instanceId: "qkt-prod", id: "deal-EXNESS-32", seq: 1, ts: T0 + HOUR, type: "broker.deal",
        payload: { broker: "EXNESS", dealTicket: "32", positionTicket: "900", orderTicket: "888",
          symbol: "EXNESS:XAUUSD", side: "SELL", entry: "OUT", qty: 0.01, price: 4310, profit: 10,
          ts: T0 + HOUR, strategyId: "hedge_straddle" } } as Envelope,
    ]);
    const rows = dealClosedTrades(db, F);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ orderId: "900", entryOrderId: "eng-open", exitOrderId: "eng-close" });
  });

  it("leaves the engine order ids null when no order carries the broker ticket", () => {
    const rows = dealClosedTrades(seeded(), F);
    for (const r of rows) {
      expect(r.entryOrderId).toBeNull();
      expect(r.exitOrderId).toBeNull();
    }
  });

  it("007 migration backfills broker order ids from stored events", async () => {
    const { readFileSync } = await import("node:fs");
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO orders (instance_id, order_id, state, created_ts, updated_ts) VALUES ('qkt-prod','eng-9','FILLED',1,1)",
    ).run();
    db.prepare(
      "INSERT INTO events (id, instance_id, type, seq, ts, payload) VALUES ('e9','qkt-prod','order.accepted',1,1,?)",
    ).run(JSON.stringify({ orderId: "eng-9", brokerOrderId: "999" }));
    const sql = readFileSync(new URL("../src/migrations/007_orders_broker_id.sql", import.meta.url), "utf8");
    // Re-run only the backfill: ALTER/CREATE already applied by openDb.
    for (const stmt of sql.split(";")) {
      const body = stmt.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
      if (body.toUpperCase().startsWith("UPDATE")) db.exec(body + ";");
    }
    expect(db.prepare("SELECT broker_order_id b FROM orders WHERE order_id='eng-9'").get()).toMatchObject({ b: "999" });
  });
});
