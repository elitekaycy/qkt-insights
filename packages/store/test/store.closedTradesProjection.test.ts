import { describe, it, expect } from "vitest";
import {
  openDb, ingestEvents, dealClosedTrades, closedTrades, fullyClosedPositions, rebuildProjection, refreshProjections,
  accountSummary, type Db,
} from "../src/index.js";
import type { Envelope } from "@qkt-insights/contract";

const H = 3_600_000;
const T0 = Date.UTC(2026, 4, 11);
const I = "i1";
const S = "alpha";

let seq = 0;
function deal(p: {
  ticket: string; position?: string | null; entry: "IN" | "OUT" | "INOUT" | "OUT_BY"; side: "BUY" | "SELL"; ts: number;
  qty?: number; price?: number; profit?: number; commission?: number; strategyId?: string | null; broker?: string; id?: string;
  comment?: string;
}): Envelope {
  return {
    v: 1, instanceId: I, id: p.id ?? `deal-${p.broker ?? "B"}-${p.ticket}`, seq: seq++, ts: p.ts, type: "broker.deal",
    payload: {
      broker: p.broker ?? "B", dealTicket: p.ticket, ...(p.position === null ? {} : { positionTicket: p.position ?? "P1" }),
      symbol: "B:XAUUSD", side: p.side, entry: p.entry, qty: p.qty ?? 1, price: p.price ?? 4000, profit: p.profit ?? 0,
      commission: p.commission ?? 0, comment: p.comment ?? "manual",
      ...(p.strategyId === null ? {} : { strategyId: p.strategyId ?? S }), ts: p.ts,
    },
  } as Envelope;
}

function fresh(): Db {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO strategies (instance_id, strategy_id, first_seen, last_seen) VALUES (?,?,?,?)").run(I, S, T0, T0);
  return db;
}

const F = { instanceId: I, strategyId: S };

/** Every closed_trades row, as stored. */
function stored(db: Db): unknown[] {
  refreshProjections(db);
  return db.prepare("SELECT * FROM closed_trades ORDER BY deal_rowid").all();
}

describe("closed_trades projection", () => {
  it("keeps one row per closing leg, charging each its share of the IN cost by closed volume", () => {
    const db = fresh();
    ingestEvents(db, I, [
      deal({ ticket: "1", entry: "IN", side: "BUY", ts: T0, qty: 2, commission: -1 }),
      deal({ ticket: "2", entry: "OUT", side: "SELL", ts: T0 + H, qty: 1, profit: 5, commission: -0.5 }),
      deal({ ticket: "3", entry: "OUT", side: "SELL", ts: T0 + 2 * H, qty: 1, profit: 3 }),
    ]);
    const rows = dealClosedTrades(db, F);
    expect(rows.map((r) => [r.ts, r.realized, r.side, r.entryTs, r.entryPrice])).toEqual([
      [T0 + H, 4, "BUY", T0, 4000],
      [T0 + 2 * H, 2.5, "BUY", T0, 4000],
    ]);
  });

  it("charges a scaled-in position every entry's costs, so its closes add up to its round trip", () => {
    const db = fresh();
    ingestEvents(db, I, [
      deal({ ticket: "1", entry: "IN", side: "BUY", ts: T0, qty: 1, commission: -0.7 }),
      deal({ ticket: "2", entry: "IN", side: "BUY", ts: T0 + H, qty: 3, price: 4004, commission: -2.1 }),
      deal({ ticket: "3", entry: "OUT", side: "SELL", ts: T0 + 2 * H, qty: 4, price: 4010, profit: 28, commission: -2.8 }),
      // A copy from a second broker profile: counted once.
      deal({ ticket: "2", id: "copy-2", broker: "C", entry: "IN", side: "BUY", ts: T0 + H, qty: 3, price: 4004, commission: -2.1 }),
    ]);
    const rows = dealClosedTrades(db, F);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.realized).toBeCloseTo(28 - 2.8 - 0.7 - 2.1, 9);
    const trip = db.prepare("SELECT realized FROM round_trips WHERE position_ticket='P1'").get() as { realized: number };
    expect(rows[0]!.realized).toBeCloseTo(trip.realized, 9);

    // Closed in parts: each close pays its volume's share, and the parts still add up.
    const parts = fresh();
    ingestEvents(parts, I, [
      deal({ ticket: "1", entry: "IN", side: "BUY", ts: T0, qty: 1, commission: -0.7 }),
      deal({ ticket: "2", entry: "IN", side: "BUY", ts: T0 + H, qty: 3, commission: -2.1 }),
      deal({ ticket: "3", entry: "OUT", side: "SELL", ts: T0 + 2 * H, qty: 1, profit: 10 }),
      deal({ ticket: "4", entry: "OUT", side: "SELL", ts: T0 + 3 * H, qty: 3, profit: 6 }),
    ]);
    const split = dealClosedTrades(parts, F).map((r) => r.realized);
    expect(split[0]).toBeCloseTo(10 - 2.8 / 4, 9);
    expect(split[1]).toBeCloseTo(6 - 2.8 * 3 / 4, 9);
    const partsTrip = parts.prepare("SELECT realized FROM round_trips WHERE position_ticket='P1'").get() as { realized: number };
    expect(split[0]! + split[1]!).toBeCloseTo(partsTrip.realized, 9);
  });

  it("fills in the entry once the IN leg arrives after its close", () => {
    const db = fresh();
    ingestEvents(db, I, [deal({ ticket: "2", entry: "OUT", side: "SELL", ts: T0 + H, profit: 5 })]);
    expect(dealClosedTrades(db, F)[0]).toMatchObject({ entryTs: null, entryPrice: null, side: "BUY", realized: 5 });
    ingestEvents(db, I, [deal({ ticket: "1", entry: "IN", side: "BUY", ts: T0, price: 3990, commission: -2 })]);
    expect(dealClosedTrades(db, F)[0]).toMatchObject({ entryTs: T0, entryPrice: 3990, side: "BUY", realized: 3, holdMs: H });
  });

  it("moves a close to its strategy when a sibling leg attributes it later", () => {
    const db = fresh();
    ingestEvents(db, I, [deal({ ticket: "2", entry: "OUT", side: "SELL", ts: T0 + H, profit: 5, strategyId: null, comment: "[tp 4005]" })]);
    expect(dealClosedTrades(db, F)).toEqual([]);
    expect(accountSummary(db, { instanceId: I }).byStrategy.map((b) => b.key)).toEqual([null]);
    ingestEvents(db, I, [deal({ ticket: "1", entry: "IN", side: "BUY", ts: T0 })]);
    expect(dealClosedTrades(db, F).map((r) => r.realized)).toEqual([5]);
    expect(accountSummary(db, { instanceId: I }).byStrategy.map((b) => b.key)).toEqual([S]);
  });

  it("stores a redelivered deal and a second profile's copy once", () => {
    const db = fresh();
    const legs = [deal({ ticket: "1", entry: "IN", side: "BUY", ts: T0 }), deal({ ticket: "2", entry: "OUT", side: "SELL", ts: T0 + H, profit: 5 })];
    ingestEvents(db, I, legs);
    const once = stored(db);
    ingestEvents(db, I, legs);
    ingestEvents(db, I, [deal({ ticket: "2", entry: "OUT", side: "SELL", ts: T0 + H, profit: 5, broker: "B2", id: "copy-2" })]);
    expect(stored(db)).toEqual(once);
    expect(closedTrades(db, F)).toHaveLength(1);
  });

  it("sees rows written by plain SQL on the next read", () => {
    const db = fresh();
    const ins = db.prepare(
      "INSERT INTO deals (id, instance_id, broker, deal_ticket, position_ticket, side, entry, qty, price, profit, strategy_id, ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    ins.run("a", I, "B", "1", "P9", "SELL", "IN", 1, 4000, 0, S, T0);
    ins.run("b", I, "B", "2", "P9", "BUY", "OUT", 1, 3990, 10, S, T0 + H);
    expect(dealClosedTrades(db, F)).toMatchObject([{ orderId: "P9", side: "SELL", realized: 10 }]);
    db.prepare("UPDATE deals SET profit=? WHERE id='b'").run(12);
    expect(dealClosedTrades(db, F)).toMatchObject([{ realized: 12 }]);
    db.prepare("DELETE FROM deals WHERE id='b'").run();
    expect(dealClosedTrades(db, F)).toEqual([]);
  });

  it("promotes the next copy when the canonical one is removed", () => {
    const db = fresh();
    ingestEvents(db, I, [
      deal({ ticket: "1", entry: "IN", side: "BUY", ts: T0 }),
      deal({ ticket: "2", entry: "OUT", side: "SELL", ts: T0 + H, profit: 5 }),
      deal({ ticket: "2", entry: "OUT", side: "SELL", ts: T0 + H, profit: 5, broker: "B2", id: "copy-2" }),
    ]);
    db.prepare("DELETE FROM deals WHERE id='deal-B-2'").run();
    expect(db.prepare("SELECT canonical FROM deals WHERE id='copy-2'").get()).toEqual({ canonical: 0 });
    expect(dealClosedTrades(db, F).map((r) => r.realized)).toEqual([5]);
    expect(db.prepare("SELECT canonical FROM deals WHERE id='copy-2'").get()).toEqual({ canonical: 1 });
  });

  it("keeps a leg without a position ticket as its own close", () => {
    const db = fresh();
    ingestEvents(db, I, [deal({ ticket: "7", position: null, entry: "OUT", side: "SELL", ts: T0, profit: 2, commission: -0.25 })]);
    expect(dealClosedTrades(db, F)).toMatchObject([{ orderId: null, realized: 1.75, entryTs: null }]);
  });

  it("knows when a position was fully closed, partially closed or reopened", () => {
    const db = fresh();
    ingestEvents(db, I, [
      deal({ ticket: "1", entry: "IN", side: "BUY", ts: T0, qty: 2 }),
      deal({ ticket: "2", entry: "OUT", side: "SELL", ts: T0 + H, qty: 1, profit: 1 }),
      deal({ ticket: "3", entry: "OUT", side: "SELL", ts: T0 + 2 * H, qty: 1, profit: 1 }),
      deal({ ticket: "4", entry: "IN", side: "BUY", ts: T0 + 3 * H, qty: 1 }),
      deal({ ticket: "5", entry: "OUT", side: "SELL", ts: T0 + 4 * H, qty: 1, profit: 1 }),
      deal({ ticket: "6", position: "R", entry: "IN", side: "BUY", ts: T0, qty: 1 }),
      deal({ ticket: "7", position: "R", entry: "INOUT", side: "SELL", ts: T0 + H, qty: 2, profit: 1 }),
    ]);
    const closedAt = (to: number) => [...fullyClosedPositions(db, { instanceId: I, to })];
    expect(closedAt(T0 + H)).toEqual([]);
    expect(closedAt(T0 + 2 * H)).toEqual(["P1"]);
    expect(closedAt(T0 + 3 * H)).toEqual([]);
    expect(closedAt(T0 + 4 * H)).toEqual(["P1"]);
    expect(closedTrades(db, { ...F, to: T0 + 3 * H, closedPositionsOnly: true })).toEqual([]);
    expect(closedTrades(db, { ...F, to: T0 + 2 * H + 1, closedPositionsOnly: true }).map((r) => r.ts)).toEqual([T0 + 2 * H, T0 + H]);
  });

  it("rebuilds from the deals to the rows ingest maintained, and resumes an interrupted rebuild", () => {
    const db = fresh();
    const legs: Envelope[] = [];
    for (let p = 0; p < 30; p++) {
      legs.push(deal({ ticket: `${p}-in`, position: `P${p}`, entry: "IN", side: p % 2 ? "BUY" : "SELL", ts: T0 + p * H, qty: 2, commission: -0.5 }));
      legs.push(deal({ ticket: `${p}-a`, position: `P${p}`, entry: "OUT", side: "BUY", ts: T0 + p * H + 60_000, qty: 1, profit: p - 10 }));
      legs.push(deal({ ticket: `${p}-b`, position: `P${p}`, entry: "OUT_BY", side: "BUY", ts: T0 + p * H + 120_000, qty: 1, profit: 3 }));
    }
    legs.push(deal({ ticket: "loose", position: null, entry: "OUT", side: "BUY", ts: T0, profit: 1 }));
    ingestEvents(db, I, legs);
    const maintained = stored(db);
    const closures = db.prepare("SELECT * FROM position_closures ORDER BY position_ticket").all();
    expect(maintained).toHaveLength(61);

    const progress = rebuildProjection(db, "closed_trades", { batch: 7, force: true });
    expect(progress.batches).toBeGreaterThan(4);
    expect(stored(db)).toEqual(maintained);
    expect(db.prepare("SELECT * FROM position_closures ORDER BY position_ticket").all()).toEqual(closures);

    // Stop after two batches, as a crash would, then let the next open finish it.
    let batches = 0;
    expect(() => rebuildProjection(db, "closed_trades", { batch: 5, force: true, onBatch: () => { if (++batches === 2) throw new Error("stop"); } })).toThrow("stop");
    expect(db.prepare("SELECT rebuilt_at r, cursor FROM projections WHERE name='closed_trades'").get()).toMatchObject({ r: null });
    expect((db.prepare("SELECT COUNT(*) n FROM closed_trades").get() as { n: number }).n).toBeLessThan(61);
    rebuildProjection(db, "closed_trades", { batch: 5 });
    expect(stored(db)).toEqual(maintained);
  });
});
