import { describe, it, expect } from "vitest";
import { openDb, ingestEvents, persistStateEvent, positionPath, pruneRetention, moneyPerPointOf, stopStyleOf, type Db } from "../src/index.js";
import type { Envelope } from "@qkt-insights/contract";

const M = 60_000;
const T0 = Date.UTC(2026, 2, 2, 8);
const I = "i1";
const S = "alpha";
let seq = 0;

function deal(id: string, entry: "IN" | "OUT", ts: number, price: number, qty = 1, side: "BUY" | "SELL" = entry === "IN" ? "BUY" : "SELL"): Envelope {
  return {
    v: 1, instanceId: I, id: `deal-${id}-${seq}`, seq: seq++, ts, type: "broker.deal",
    payload: { broker: "B", dealTicket: id, positionTicket: "P1", symbol: "B:XAUUSD", side, entry, qty, price, profit: 0, strategyId: S, ts },
  } as Envelope;
}

/** A poll of the long P1 (entry 2000, 1 lot = 100 oz): profit is 100 per price unit. */
function poll(db: Db, ts: number, price: number, stopLoss?: number, takeProfit?: number): void {
  persistStateEvent(db, I, {
    v: 1, instanceId: I, id: `p-${seq}`, seq: seq++, ts, type: "state.positions",
    payload: { broker: "B", positions: [{ ticket: "P1", symbol: "B:XAUUSD", side: "BUY", qty: 1, entryPrice: 2000, currentPrice: price, profit: (price - 2000) * 100, strategyId: S, stopLoss, takeProfit }] },
  } as Envelope);
}

function open(): Db {
  seq = 0;
  const db = openDb(":memory:");
  ingestEvents(db, I, [deal("1", "IN", T0, 2000)]);
  return db;
}

describe("venue stop and target steps", () => {
  it("stores a row only when the venue's stop or target changes, and the path draws them as steps", () => {
    const db = open();
    poll(db, T0 + 1 * M, 2001, 1990, 2030);
    poll(db, T0 + 2 * M, 2003, 1990, 2030); // unchanged: no row
    poll(db, T0 + 3 * M, 2008, 1998, 2030); // trailed up
    poll(db, T0 + 4 * M, 2012, 2002, 2030); // trailed again
    poll(db, T0 + 5 * M, 2010, 2002, 0); // target removed: 0 is none
    const p = positionPath(db, I, "P1", undefined, T0 + 6 * M)!;
    expect(p.levelSteps).toEqual([
      { ts: T0 + 1 * M, stop: 1990, target: 2030 },
      { ts: T0 + 3 * M, stop: 1998, target: 2030 },
      { ts: T0 + 4 * M, stop: 2002, target: 2030 },
      { ts: T0 + 5 * M, stop: 2002, target: null },
    ]);
    // no entry order is linked: the initial levels are the first the venue held
    expect(p.levelSource).toBe("venue");
    expect(p.stopPrice).toBe(1990);
    expect(p.targetPrice).toBe(2030);
    expect(p.moneyPerPoint).toBe(100);
  });

  it("stores nothing for a position the venue never protected", () => {
    const db = open();
    poll(db, T0 + M, 2001);
    poll(db, T0 + 2 * M, 2002, 0, 0);
    const p = positionPath(db, I, "P1", undefined, T0 + 3 * M)!;
    expect(p.levelSteps).toEqual([]);
    expect(p.levelSource).toBeNull();
    expect(p.stopPrice).toBeNull();
  });

  it("lists partial closes before the final exit once each, even when the venue repeats a deal", () => {
    const db = open();
    poll(db, T0 + M, 2005, 1990);
    ingestEvents(db, I, [deal("2", "OUT", T0 + 2 * M, 2006, 0.4), deal("2", "OUT", T0 + 2 * M, 2006, 0.4)]);
    const p = positionPath(db, I, "P1", undefined, T0 + 3 * M)!;
    expect(p.partials).toEqual([{ ts: T0 + 2 * M, price: 2006, qty: 0.4 }]);
  });

  it("prunes the steps of closed positions with their marks, never an open one's", () => {
    const db = open();
    poll(db, T0 + M, 2001, 1990);
    const later = T0 + 40 * 86_400_000;
    pruneRetention(db, later);
    expect((db.prepare("SELECT COUNT(*) n FROM position_levels").get() as { n: number }).n).toBe(1);
    // the position closes (the poll no longer lists it): its steps go with its marks
    persistStateEvent(db, I, { v: 1, instanceId: I, id: "empty", seq: seq++, ts: T0 + 2 * M, type: "state.positions", payload: { broker: "B", positions: [] } } as Envelope);
    pruneRetention(db, later);
    expect((db.prepare("SELECT COUNT(*) n FROM position_levels").get() as { n: number }).n).toBe(0);
  });
});

describe("stopStyleOf", () => {
  it("reads the stop qkt submitted: fixed, trailing, stepped, tightening", () => {
    expect(stopStyleOf({ stopLoss: { type: "Fixed", price: 3808.51 } })).toEqual({ kind: "fixed" });
    expect(stopStyleOf({ stopLoss: { type: "ArmedTrail", trailDistance: 5, mfeThreshold: 10 } })).toEqual({ kind: "trailing", trailDistance: 5, armAt: 10 });
    expect(stopStyleOf({ stopLoss: { type: "SteppedStop", initialDistance: 8, steps: [{ mfeThreshold: 4, profitDistance: 0 }, { mfeThreshold: 8, profitDistance: 4 }] } }))
      .toEqual({ kind: "stepped", steps: 2, armAt: 4 });
    expect(stopStyleOf({ stopLoss: { type: "TimeTighten", initialDistance: 8, tightenBy: 1, intervalMs: 3_600_000, floorDistance: 2 } }))
      .toEqual({ kind: "tightening", intervalMs: 3_600_000 });
    expect(stopStyleOf({ stopLoss: 1990 })).toBeNull();
    expect(stopStyleOf({})).toBeNull();
  });
});

describe("moneyPerPointOf", () => {
  it("divides the furthest mark's P&L by its move, long and short", () => {
    expect(moneyPerPointOf("long", 2000, [{ price: 2001, pnl: 100 }, { price: 1995, pnl: -500 }])).toBe(100);
    expect(moneyPerPointOf("short", 1.1, [{ price: 1.099, pnl: 100 }])).toBeCloseTo(100_000, 6);
    expect(moneyPerPointOf("long", 2000, [{ price: 2000, pnl: 0 }])).toBeNull();
    expect(moneyPerPointOf("long", null, [{ price: 2001, pnl: 100 }])).toBeNull();
  });
});
