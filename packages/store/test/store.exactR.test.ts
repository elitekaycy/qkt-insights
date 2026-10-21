import { describe, it, expect } from "vitest";
import type { Envelope } from "@qkt-insights/contract";
import { parseQuery } from "@qkt-insights/contract/query";
import {
  openDb, ingestEvents, listRoundTrips, roundTripAnalytics, storedRoundTrips, refreshProjections, ensureProjections, type Db,
} from "../src/index.js";

/*
 * R is the exact realized (the unrounded sum of a position's legs incl. costs) over the risk qkt
 * stated, while money stays at the account currency's minor unit (#124). A trip a fraction of a
 * cent in size, like 0.01 ETH on a paper venue risking 0.005, must not read R 0 or -2 because its
 * money prints as 0.00 or -0.01. Synthetic fixtures only.
 */

const I = "qkt-exact-r";
const MIN = 60_000, H = 3_600_000;
const T0 = Date.UTC(2026, 9, 19, 8);
let seq = 1;

function env(type: string, ts: number, payload: Record<string, unknown>, strategyId?: string): Envelope {
  return { v: 1, instanceId: I, id: `e${seq}`, seq: seq++, ts, type, strategyId, payload } as Envelope;
}

/** One closed position: an entry fill stating its risk, then IN and OUT deals with their costs. */
function trip(n: number, t0: number, p: { entry: number; exit: number; stop: number; risk: number; profit: number; commission: number }): Envelope[] {
  const pos = `PAPER:ETH#${n}`, s = "eth_scalp";
  const facts = { positionId: pos, attribution: "order", strategyId: s };
  const deal = (k: string, entry: "IN" | "OUT", ts: number, price: number, profit: number) => env("broker.deal", ts, {
    broker: "PAPER", dealTicket: `d${n}${k}`, positionTicket: pos, orderTicket: `o${n}${k}`, symbol: "PAPER:ETHUSD",
    side: entry === "IN" ? "BUY" : "SELL", entry, qty: 0.01, price, profit, commission: p.commission, swap: 0, comment: "", ts,
    legEntry: entry, ...facts,
  }, s);
  return [
    env("order.filled", t0, { orderId: `dsl-${s}--${n}`, symbol: "PAPER:ETHUSD", price: p.entry, qty: 0.01, legEntry: "IN",
      initialStop: p.stop, riskAmount: p.risk, ...facts }, s),
    deal("a", "IN", t0, p.entry, 0),
    deal("b", "OUT", t0 + 30 * MIN, p.exit, p.profit),
  ];
}

/**
 * - 1 tiny: -0.0046 profit, 2 x -0.0005 commission: exact -0.0056 over 0.005 is R -1.12 (money -0.01)
 * - 2 tiny, under half a cent: exact -0.004 over 0.005 is R -0.8 (money 0.00, breakeven)
 * - 3 cent-sized: +0.02 profit, 2 x -0.005 commission: exact +0.01 over 0.01 is R 1
 * - 4 large: +1234.5678 profit, no cost: exact over 500 is R 2.4691356 (money 1234.57)
 */
function fixture(): Db {
  seq = 1;
  const db = openDb(":memory:");
  ingestEvents(db, I, [
    ...trip(1, T0, { entry: 2500, exit: 2499.54, stop: 2499.5, risk: 0.005, profit: -0.0046, commission: -0.0005 }),
    ...trip(2, T0 + H, { entry: 2500, exit: 2499.7, stop: 2499.5, risk: 0.005, profit: -0.003, commission: -0.0005 }),
    ...trip(3, T0 + 2 * H, { entry: 2500, exit: 2502, stop: 2499, risk: 0.01, profit: 0.02, commission: -0.005 }),
    ...trip(4, T0 + 3 * H, { entry: 2500, exit: 3734.57, stop: 2000, risk: 500, profit: 1234.5678, commission: 0 }),
  ]);
  return db;
}

const q = (text = "") => ({ instanceId: I, filter: parseQuery(text).filter, sort: "entry" as const, dir: "asc" as const });
const ids = (db: Db, text: string) => listRoundTrips(db, q(text)).rows.map((r) => r.id.split("#")[1]).sort();

describe("R from the exact realized, money at the minor unit", () => {
  it("each trip's R divides the unrounded net by the stated risk; its money stays in cents", () => {
    const rows = listRoundTrips(fixture(), q()).rows;
    expect(rows.map((r) => r.pnl)).toEqual([-0.01, 0, 0.01, 1234.57]);
    expect(rows.map((r) => r.risk)).toEqual([0.005, 0.005, 0.01, 500]);
    const r = rows.map((x) => x.r!);
    expect(r[0]).toBeCloseTo(-1.12, 10);
    expect(r[1]).toBeCloseTo(-0.8, 10);
    expect(r[2]).toBeCloseTo(1, 10);
    expect(r[3]).toBeCloseTo(1234.5678 / 500, 10);
  });

  it("stores the exact net beside the rounded one", () => {
    const rows = storedRoundTrips(fixture(), { instanceId: I }).sort((a, b) => a.entryTs! - b.entryTs!);
    expect(rows.map((x) => x.realized)).toEqual([-0.01, 0, 0.01, 1234.57]);
    [-0.0056, -0.004, 0.01, 1234.5678].forEach((v, i) => expect(rows[i]!.realizedExact).toBeCloseTo(v, 12));
  });

  it("win, loss and pnl: read the cents; r: reads the exact R at its boundaries", () => {
    const db = fixture();
    expect(ids(db, "loss")).toEqual(["1"]);
    expect(ids(db, "breakeven")).toEqual(["2"]);
    expect(ids(db, "win")).toEqual(["3", "4"]);
    expect(ids(db, "pnl:=-0.01")).toEqual(["1"]);
    expect(ids(db, "pnl:=0")).toEqual(["2"]);
    // the cent-rounded R would be -2 and 0 for the tiny trips
    expect(ids(db, "r:<-1.5")).toEqual([]);
    expect(ids(db, "r:<-1.1")).toEqual(["1"]);
    expect(ids(db, "r:<-1.13")).toEqual([]);
    expect(ids(db, "r:<0")).toEqual(["1", "2"]);
    expect(ids(db, "r:>=1")).toEqual(["3", "4"]);
    expect(ids(db, "r:>1")).toEqual(["4"]);
    expect(ids(db, "r:>2.4691")).toEqual(["4"]);
    expect(ids(db, "r:>2.4692")).toEqual([]);
  });

  it("average and total R add up the exact R of each trip", () => {
    const a = roundTripAnalytics(fixture(), q());
    const exact = -1.12 - 0.8 + 1 + 1234.5678 / 500;
    expect(a.r.n).toBe(4);
    expect(a.r.total!).toBeCloseTo(exact, 10);
    expect(a.r.avg!).toBeCloseTo(exact / 4, 10);
  });

  it("rows written before the exact net was stored rebuild with it", () => {
    const db = fixture();
    refreshProjections(db);
    db.prepare("UPDATE round_trips SET realized_exact=NULL").run();
    db.prepare("UPDATE projections SET version=6 WHERE name='closed_trades'").run();
    expect(listRoundTrips(db, q()).rows[0]!.r).toBe(-2); // the cent-rounded net over the risk
    ensureProjections(db); // what the next open does with a projection of an older version
    expect(listRoundTrips(db, q()).rows[0]!.r).toBeCloseTo(-1.12, 10);
    expect((db.prepare("SELECT COUNT(*) n FROM round_trips WHERE realized_exact IS NULL").get() as { n: number }).n).toBe(0);
  });
});
