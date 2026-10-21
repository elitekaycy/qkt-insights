import { describe, it, expect } from "vitest";
import { openDb, ingestEvents, storedRoundTrips, rebuildProjection, refreshProjections, listRoundTrips, type Db } from "../src/index.js";
import type { Envelope } from "@qkt-insights/contract";

const M = 60_000;
const T0 = Date.UTC(2026, 3, 6, 8);
const I = "i1";
const S = "alpha";

let seq = 0;
function deal(p: {
  ticket: string; position?: string; entry: "IN" | "OUT" | "OUT_BY"; side: "BUY" | "SELL"; ts: number; qty: number; price: number;
  profit?: number; commission?: number; swap?: number; order?: string; comment?: string; strategyId?: string | null; broker?: string; id?: string;
}): Envelope {
  return {
    v: 1, instanceId: I, id: p.id ?? `deal-${p.ticket}`, seq: seq++, ts: p.ts, type: "broker.deal",
    payload: {
      broker: p.broker ?? "ICM", dealTicket: p.ticket, positionTicket: p.position ?? "P1", ...(p.order ? { orderTicket: p.order } : {}),
      symbol: "ICM_S05:XAUUSD", side: p.side, entry: p.entry, qty: p.qty, price: p.price, profit: p.profit ?? 0,
      commission: p.commission ?? 0, swap: p.swap ?? 0, comment: p.comment ?? "dsl-alpha",
      ...(p.strategyId === null ? {} : { strategyId: p.strategyId ?? S }), ts: p.ts,
    },
  } as Envelope;
}

function event(type: string, ts: number, payload: Record<string, unknown>, strategyId: string | undefined = S): Envelope {
  return { v: 1, instanceId: I, id: `${type}-${seq}`, seq: seq++, ts, type, ...(strategyId ? { strategyId } : {}), payload } as Envelope;
}

function seeded(): Db {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO strategies (instance_id, strategy_id, first_seen, last_seen) VALUES (?,?,?,?)").run(I, S, T0, T0);
  return db;
}

const trip = (db: Db, position = "P1") => storedRoundTrips(db, { instanceId: I }).find((r) => r.positionTicket === position);

describe("round_trips projection", () => {
  it("folds a scale-in and a scale-out into one round trip with size-weighted prices and every cost", () => {
    const db = seeded();
    ingestEvents(db, I, [
      deal({ ticket: "1", entry: "IN", side: "BUY", ts: T0, qty: 1, price: 4000, commission: -0.5 }),
      deal({ ticket: "2", entry: "IN", side: "BUY", ts: T0 + M, qty: 3, price: 4004, commission: -1.5 }),
    ]);
    expect(trip(db)).toMatchObject({ open: true, entryPrice: 4003, qty: 4, exitTs: null, holdMs: null, ended: null, realized: -2 });
    ingestEvents(db, I, [
      deal({ ticket: "3", entry: "OUT", side: "SELL", ts: T0 + 10 * M, qty: 2, price: 4010, profit: 14, commission: -1, swap: -0.25 }),
    ]);
    expect(trip(db)).toMatchObject({ open: true, exitTs: T0 + 10 * M, ended: null });
    ingestEvents(db, I, [
      deal({ ticket: "4", entry: "OUT_BY", side: "SELL", ts: T0 + 20 * M, qty: 2, price: 4016, profit: 26, comment: "[tp 4016.0]" }),
    ]);
    expect(trip(db)).toMatchObject({
      open: false, side: "long", instrument: "XAUUSD", symbol: "ICM_S05:XAUUSD", broker: "ICM", strategyId: S,
      entryTs: T0, entryPrice: 4003, exitTs: T0 + 20 * M, exitPrice: 4013, qty: 4, legs: 4,
      gross: 40, commission: -3, swap: -0.25, fee: 0, realized: 36.75, holdMs: 20 * M, ended: "tp",
    });
  });

  it("adds up to the net of the closed positions' canonical deals to the cent", () => {
    const db = seeded();
    const legs: Envelope[] = [];
    for (let p = 0; p < 40; p++) {
      const t = T0 + p * 30 * M;
      const c = -((p % 7) + 1) * 0.13;
      legs.push(deal({ ticket: `${p}a`, position: `P${p}`, entry: "IN", side: p % 2 ? "SELL" : "BUY", ts: t, qty: 0.3, price: 4000 + p, commission: c }));
      legs.push(deal({ ticket: `${p}b`, position: `P${p}`, entry: "IN", side: p % 2 ? "SELL" : "BUY", ts: t + M, qty: 0.2, price: 4001 + p, commission: c }));
      legs.push(deal({ ticket: `${p}c`, position: `P${p}`, entry: "OUT", side: p % 2 ? "BUY" : "SELL", ts: t + 5 * M, qty: 0.25, price: 4002 + p, profit: (p % 5) - 2.37, commission: c }));
      if (p % 4) legs.push(deal({ ticket: `${p}d`, position: `P${p}`, entry: "OUT", side: p % 2 ? "BUY" : "SELL", ts: t + 9 * M, qty: 0.25, price: 4003 + p, profit: 1.11 * p, swap: -0.07 }));
    }
    // A second profile's copy of every leg: counted once.
    ingestEvents(db, I, [...legs, ...legs.map((e) => ({ ...e, id: `copy-${e.id}`, payload: { ...(e.payload as object), broker: "ICM_S06" } } as Envelope))]);
    const closed = storedRoundTrips(db, { instanceId: I }).filter((r) => !r.open);
    expect(closed).toHaveLength(30);
    const net = db.prepare(
      `SELECT SUM(profit + COALESCE(commission,0) + COALESCE(swap,0) + COALESCE(fee,0)) n FROM deals
       WHERE canonical=1 AND position_ticket IN (SELECT position_ticket FROM round_trips WHERE open=0)`,
    ).get() as { n: number };
    expect(Math.round(closed.reduce((a, r) => a + r.realized, 0) * 100)).toBe(Math.round(net.n * 100));
  });

  it("takes its owner when the IN leg attributes it after the close, and settles out-of-order legs", () => {
    const db = seeded();
    ingestEvents(db, I, [deal({ ticket: "2", entry: "OUT", side: "BUY", ts: T0 + 5 * M, qty: 1, price: 3990, profit: 10, comment: "[sl 3990]", strategyId: null })]);
    expect(trip(db)).toMatchObject({ strategyId: null, open: false, side: "short", entryTs: null, ended: "stop" });
    ingestEvents(db, I, [deal({ ticket: "1", entry: "IN", side: "SELL", ts: T0, qty: 1, price: 4000 })]);
    expect(trip(db)).toMatchObject({ strategyId: S, open: false, side: "short", entryTs: T0, entryPrice: 4000, holdMs: 5 * M, realized: 10 });
    const once = storedRoundTrips(db, { instanceId: I });
    ingestEvents(db, I, [deal({ ticket: "1", entry: "IN", side: "SELL", ts: T0, qty: 1, price: 4000 })]);
    expect(storedRoundTrips(db, { instanceId: I })).toEqual(once);
  });

  it("reads the bracket of the opening order, including a broker id learned after the deal", () => {
    const db = seeded();
    ingestEvents(db, I, [
      event("order.submit", T0 - M, { orderId: "o-1", orderType: "Bracket", symbol: "ICM_S05:XAUUSD", side: "BUY", qty: 1, stopLoss: { type: "Fixed", price: 3980 }, takeProfit: 4040 }),
      deal({ ticket: "1", entry: "IN", side: "BUY", ts: T0, qty: 1, price: 4000, order: "B-77" }),
    ]);
    expect(trip(db)).toMatchObject({ entryOrderId: null, entryOrderTicket: "B-77", stopPrice: null });
    ingestEvents(db, I, [event("order.filled", T0 + 1000, { orderId: "o-1", brokerOrderId: "B-77", symbol: "ICM_S05:XAUUSD", price: 4000, qty: 1 })]);
    expect(trip(db)).toMatchObject({ entryOrderId: "o-1", entryOrderTicket: "B-77", stopPrice: 3980, targetPrice: 4040 });
  });

  it("finds the opening order from its acceptance when the order id was reused by an earlier run", () => {
    const db = seeded();
    const H = 60 * M;
    ingestEvents(db, I, [
      // An earlier engine run used the same order id for another ticket; the orders row keeps that ticket.
      event("order.submit", T0 - 5 * H, { orderId: "o-1", orderType: "Market", symbol: "ICM_S05:XAUUSD", side: "BUY", qty: 1 }),
      event("order.accepted", T0 - 5 * H + 500, { orderId: "o-1", brokerOrderId: "B-1" }),
      event("order.submit", T0 - 30_000, { orderId: "o-1", orderType: "Bracket", symbol: "ICM_S05:XAUUSD", side: "BUY", qty: 1, stopLoss: { type: "Fixed", price: 3980 }, takeProfit: 4040 }),
      event("order.accepted", T0 - 20_000, { orderId: "o-1", brokerOrderId: "B-77" }),
      // Another order accepted near the entry under a different ticket must not be taken.
      event("order.submit", T0 - 25_000, { orderId: "o-2", orderType: "Bracket", symbol: "ICM_S05:XAUUSD", side: "BUY", qty: 1, stopLoss: 3900 }),
      event("order.accepted", T0 - 15_000, { orderId: "o-2", brokerOrderId: "B-78" }),
      deal({ ticket: "1", entry: "IN", side: "BUY", ts: T0, qty: 1, price: 4000, order: "B-77" }),
      deal({ ticket: "2", entry: "OUT", side: "SELL", ts: T0 + 10 * M, qty: 1, price: 3980, profit: -20, order: "B-90", comment: "[sl 3980]" }),
    ]);
    expect(db.prepare("SELECT broker_order_id b FROM orders WHERE order_id='o-1'").get()).toEqual({ b: "B-1" });
    expect(trip(db)).toMatchObject({ entryOrderId: "o-1", entryOrderTicket: "B-77", stopPrice: 3980, targetPrice: 4040, ended: "stop" });
  });

  it("leaves the stop unknown when no acceptance near the entry carries the ticket", () => {
    const db = seeded();
    ingestEvents(db, I, [
      event("order.accepted", T0 - 300 * M, { orderId: "o-3", brokerOrderId: "B-4" }),
      event("order.submit", T0 - 30_000, { orderId: "o-3", orderType: "Bracket", symbol: "ICM_S05:XAUUSD", side: "BUY", qty: 1, stopLoss: 3980 }),
      // Accepted with this ticket, but 11 minutes before the entry: outside the window.
      event("order.accepted", T0 - 11 * M, { orderId: "o-3", brokerOrderId: "B-5" }),
      deal({ ticket: "1", entry: "IN", side: "BUY", ts: T0, qty: 1, price: 4000, order: "B-5" }),
    ]);
    expect(trip(db)).toMatchObject({ entryOrderTicket: "B-5", stopPrice: null });
  });

  it("says a strategy order or a bot close ended it, and nothing when nothing does", () => {
    const db = seeded();
    ingestEvents(db, I, [
      deal({ ticket: "1", position: "A", entry: "IN", side: "BUY", ts: T0, qty: 1, price: 4000 }),
      deal({ ticket: "2", position: "B", entry: "IN", side: "BUY", ts: T0, qty: 1, price: 4000 }),
      deal({ ticket: "3", position: "C", entry: "IN", side: "BUY", ts: T0, qty: 1, price: 4000 }),
      deal({ ticket: "4", position: "D", entry: "IN", side: "BUY", ts: T0, qty: 1, price: 4000 }),
    ]);
    ingestEvents(db, I, [
      event("order.submit", T0 + 9 * M, { orderId: "x-1", orderType: "Market", symbol: "XAUUSD", side: "SELL", qty: 1, closesTicket: "A" }),
      deal({ ticket: "5", position: "A", entry: "OUT", side: "SELL", ts: T0 + 10 * M, qty: 1, price: 4001, profit: 1, comment: "" }),
      deal({ ticket: "6", position: "B", entry: "OUT", side: "SELL", ts: T0 + 10 * M, qty: 1, price: 4001, profit: 1, comment: "" }),
      deal({ ticket: "7", position: "C", entry: "OUT", side: "SELL", ts: T0 + 10 * M, qty: 1, price: 3001, profit: -1000, comment: "[so 50%/40%]" }),
      deal({ ticket: "8", position: "D", entry: "OUT", side: "SELL", ts: T0 + 10 * M, qty: 1, price: 4001, profit: 1, comment: "" }),
    ]);
    // The bot close lands after the deal: its event marks the position again.
    ingestEvents(db, I, [event("bot.close", T0 + 10 * M + 500, { symbol: "XAUUSD", ticket: "B", ok: "true" }, undefined)]);
    expect(["A", "B", "C", "D"].map((p) => trip(db, p)?.ended)).toEqual(["signal", "manual", "so", null]);
  });

  it("lists an instance's engine closes as its round trips while it has no broker deals", () => {
    const db = seeded();
    const closed = (orderId: string, ts: number, side: "BUY" | "SELL", realized: number, entryTs?: number) =>
      ({ ...event("trade.closed", ts, { orderId, symbol: "PAPER:XAUUSD", side, qty: 0.5, price: 4010, realized, ...(entryTs != null ? { entryTs } : {}), ts }), id: `tc-${orderId}-${ts}` } as Envelope);
    ingestEvents(db, I, [closed("ORD-1", T0 + 10 * M, "SELL", 12.5, T0), closed("ORD-2", T0 + 20 * M, "BUY", -4)]);
    const page = listRoundTrips(db, { instanceId: I, sort: "exit" });
    expect(page.rows.map((r) => ({ id: r.id, side: r.side, pnl: r.pnl, holdMs: r.holdMs, source: r.source, status: r.status, instrument: r.instrument }))).toEqual([
      { id: "tc-ORD-2-" + (T0 + 20 * M), side: "short", pnl: -4, holdMs: null, source: "ledger", status: "closed", instrument: "XAUUSD" },
      { id: "tc-ORD-1-" + (T0 + 10 * M), side: "long", pnl: 12.5, holdMs: 10 * M, source: "ledger", status: "closed", instrument: "XAUUSD" },
    ]);
    expect(trip(db, `tc-ORD-1-${T0 + 10 * M}`)).toMatchObject({ entryTs: T0, exitTs: T0 + 10 * M, exitPrice: 4010, entryPrice: null, strategyId: S, gross: 12.5, legs: 1 });

    const maintained = db.prepare("SELECT * FROM round_trips ORDER BY position_ticket").all();
    rebuildProjection(db, "closed_trades", { force: true, batch: 1 });
    expect(db.prepare("SELECT * FROM round_trips ORDER BY position_ticket").all()).toEqual(maintained);

    // Once the instance stores a broker deal, its round trips are its venue positions only.
    ingestEvents(db, I, [deal({ ticket: "1", entry: "IN", side: "BUY", ts: T0 + 30 * M, qty: 1, price: 4000 })]);
    expect(storedRoundTrips(db, { instanceId: I }).map((r) => [r.positionTicket, r.source])).toEqual([["P1", "deal"]]);
    ingestEvents(db, I, [closed("ORD-3", T0 + 40 * M, "SELL", 3)]);
    expect(storedRoundTrips(db, { instanceId: I }).map((r) => r.source)).toEqual(["deal"]);
    rebuildProjection(db, "closed_trades", { force: true });
    expect(storedRoundTrips(db, { instanceId: I }).map((r) => r.source)).toEqual(["deal"]);
  });

  it("rebuilds to the rows ingest maintained", () => {
    const db = seeded();
    for (let p = 0; p < 25; p++) {
      ingestEvents(db, I, [
        deal({ ticket: `${p}i`, position: `P${p}`, entry: "IN", side: "BUY", ts: T0 + p * M, qty: 1, price: 4000 + p, commission: -0.3 }),
        ...(p % 3 ? [deal({ ticket: `${p}o`, position: `P${p}`, entry: "OUT", side: "SELL", ts: T0 + p * M + 30_000, qty: 1, price: 4001 + p, profit: p - 12, comment: p % 2 ? "[sl x]" : "[tp y]" })] : []),
      ]);
    }
    refreshProjections(db);
    const rows = () => db.prepare("SELECT * FROM round_trips ORDER BY position_ticket").all();
    const maintained = rows();
    rebuildProjection(db, "closed_trades", { force: true, batch: 4 });
    expect(rows()).toEqual(maintained);
  });
});
