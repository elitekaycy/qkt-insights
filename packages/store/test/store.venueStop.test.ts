import { describe, it, expect } from "vitest";
import type { Envelope } from "@qkt-insights/contract";
import { parseQuery } from "@qkt-insights/contract/query";
import { openDb, ingestEvents, listRoundTrips, roundTripDetail, roundTripTotals, type Db } from "../src/index.js";

/*
 * qkt states the engine's stop unrounded (0.582774) while the venue holds it at the instrument's tick
 * (0.58277). Money at risk and R are measured to the stop the venue holds, so the stop the trade
 * drawer prints reproduces the risk beside it. Synthetic fixture only.
 */

const I = "qkt-venue-stop";
const T0 = Date.UTC(2026, 9, 19, 4);
let seq = 1;

function env(type: string, ts: number, payload: Record<string, unknown>, strategyId?: string): Envelope {
  return { v: 1, instanceId: I, id: `e${seq}`, seq: seq++, ts, type, strategyId, payload } as Envelope;
}

/** A short NZDUSD position, 2.93 lots, stop stated unrounded and no stated risk: MT5's shape. */
function fixture(stop: number): Db {
  seq = 1;
  const db = openDb(":memory:");
  const s = "fx3_nzdusd", pos = "MT5:NZDUSD#1";
  const facts = { positionId: pos, attribution: "order", strategyId: s };
  const deal = (k: string, entry: "IN" | "OUT", ts: number, price: number, profit: number) => env("broker.deal", ts, {
    broker: "MT5", dealTicket: `d${k}`, positionTicket: pos, orderTicket: `o${k}`, symbol: "NZDUSD",
    side: entry === "IN" ? "SELL" : "BUY", entry, qty: 2.93, price, profit, commission: 0, swap: 0, comment: "", ts,
    legEntry: entry, ...facts,
  }, s);
  ingestEvents(db, I, [
    env("order.filled", T0, { orderId: `dsl-${s}--1`, symbol: "NZDUSD", price: 0.56573, qty: 2.93, legEntry: "IN", initialStop: stop, ...facts }, s),
    deal("a", "IN", T0, 0.56573, 0),
    deal("b", "OUT", T0 + 44 * 3_600_000, 0.56782, -612.37),
  ]);
  return db;
}

const q = (text = "") => ({ instanceId: I, filter: parseQuery(text).filter, sort: "entry" as const, dir: "asc" as const });
// (0.58277 - 0.56573) x 2.93 lots x 100,000 units
const VENUE_RISK = 4992.72;

describe("risk and R to the stop the venue holds", () => {
  it("rounds the stated stop to the instrument's tick before measuring the risk", () => {
    const row = listRoundTrips(fixture(0.582774), q()).rows[0]!;
    expect(row.risk).toBeCloseTo(VENUE_RISK, 6);
    expect(row.r).toBeCloseTo(-612.37 / VENUE_RISK, 10);
    expect(row.stopPrice).toBe(0.582774); // the stated level is kept; the drawer prints it at the tick
  });

  it("matches the detail drawer and the r: filter", () => {
    const db = fixture(0.582774);
    expect(roundTripDetail(db, I, "MT5:NZDUSD#1")!.trip.risk).toBeCloseTo(VENUE_RISK, 6);
    // -612.37 / 4992.72 = -0.12265; to the unrounded stop it would be -0.12262
    expect(roundTripTotals(db, q("r:<-0.12264")).matched).toBe(1);
  });

  it("leaves a stop already on the tick unchanged", () => {
    expect(listRoundTrips(fixture(0.58277), q()).rows[0]!.risk).toBeCloseTo(VENUE_RISK, 6);
  });
});
