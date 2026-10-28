import { describe, it, expect } from "vitest";
import type { Envelope } from "@qkt-insights/contract";
import { openDb, ingestEvents, accountSummary, costDecomposition, listDeals, roundTripDetail, strategyStats, type Db } from "../src/index.js";

const I = "soak";
const S = "perp_pair";
const T0 = Date.UTC(2026, 9, 12, 8);
const H = 3_600_000;
let seq = 1;

function deal(p: { ticket: string; position: string; entry: "IN" | "OUT" | "ADJUSTMENT"; ts: number; profit?: number; broker?: string;
  costs?: Array<{ kind: string; amount: number; currency?: string }>; swap?: number }): Envelope {
  const broker = p.broker ?? "DERIBIT";
  return {
    v: 1, instanceId: I, id: `deal-${broker}-${p.ticket}`, seq: seq++, ts: p.ts, type: "broker.deal", strategyId: S,
    payload: {
      broker, dealTicket: p.ticket, positionId: p.position, symbol: `${broker}:BTC_USDC_PERPETUAL`, side: p.entry === "OUT" ? "SELL" : "BUY",
      legEntry: p.entry, qty: p.entry === "ADJUSTMENT" ? 0 : 0.01, price: p.entry === "ADJUSTMENT" ? 0 : 67000, profit: p.profit ?? 0,
      commission: 0, swap: p.swap ?? 0, strategyId: S, attribution: "order", accountId: "vgp:00000000000000aa", ts: p.ts,
      ...(p.costs ? { costs: p.costs } : {}),
    },
  } as Envelope;
}

function seed(db: Db): void {
  ingestEvents(db, I, [
    deal({ ticket: "1", position: "P#1", entry: "IN", ts: T0, costs: [{ kind: "COMMISSION", amount: 0.25, currency: "USDC" }] }),
    // funding paid twice and credited once while it was open, booked on the closing leg; qkt repeats it in `swap`
    deal({ ticket: "2", position: "P#1", entry: "OUT", ts: T0 + 9 * H, profit: 40, swap: -0.9, costs: [
      { kind: "COMMISSION", amount: 0.25, currency: "USDC" }, { kind: "FUNDING", amount: 0.7, currency: "USDC" },
      { kind: "FUNDING", amount: 0.5, currency: "USDC" }, { kind: "FUNDING", amount: -0.3, currency: "USDC" },
    ] }),
  ]);
}

describe("perpetual funding is funding, not swap", () => {
  it("files a deal's FUNDING costs as funding and its SWAP costs as swap, with the net unchanged", () => {
    const db = openDb(":memory:");
    seed(db);
    ingestEvents(db, I, [
      deal({ ticket: "m1", position: "M#1", entry: "IN", ts: T0, broker: "EXNESS" }),
      deal({ ticket: "m2", position: "M#1", entry: "OUT", ts: T0 + H, broker: "EXNESS", profit: 5, costs: [{ kind: "SWAP", amount: 0.4, currency: "USD" }] }),
    ]);
    // a deal row is the venue's amounts as stated (unrounded); every total rounds at the minor unit
    const deals = new Map(listDeals(db, { instanceId: I, limit: 10 }).map((d) => [d.dealTicket, d]));
    expect(deals.get("2")!.swap).toBeCloseTo(0, 9);
    expect(deals.get("2")!.funding).toBeCloseTo(-0.9, 9);
    expect(deals.get("1")).toMatchObject({ swap: 0, funding: 0 });
    expect(deals.get("m2")).toMatchObject({ swap: -0.4, funding: 0 });
    expect(accountSummary(db, { instanceId: I }).costs).toEqual({ grossProfit: 45, commission: -0.5, swap: -0.4, funding: -0.9, fee: 0, net: 43.2 });
  });

  it("splits funding out of a strategy's cost decomposition and a round trip's legs", () => {
    const db = openDb(":memory:");
    seed(db);
    const c = costDecomposition(db, { instanceId: I, strategyId: S })!.total;
    expect(c).toMatchObject({ grossProfit: 40, commission: -0.5, fee: 0 });
    expect(c.swap).toBeCloseTo(0, 9);
    expect(c.funding).toBeCloseTo(-0.9, 9);
    expect(c.net).toBeCloseTo(38.6, 9);
    const legs = roundTripDetail(db, I, "P#1")!.legs;
    expect(legs.map((l) => l.dealTicket)).toEqual(["1", "2"]);
    expect(legs[0]).toMatchObject({ swap: 0, funding: 0, net: -0.25 });
    expect(legs[1]!.swap).toBeCloseTo(0, 9);
    expect(legs[1]!.funding).toBeCloseTo(-0.9, 9);
    expect(legs[1]!.net).toBeCloseTo(38.85, 9);
    expect(strategyStats(db, { instanceId: I, strategyId: S }).realizedPnl).toBe(38.6);
  });

  it("counts funding qkt books as its own venue booking (an ADJUSTMENT deal) in the strategy's net, as funding", () => {
    const db = openDb(":memory:");
    seed(db);
    ingestEvents(db, I, [deal({ ticket: "f-1", position: "P#1", entry: "ADJUSTMENT", ts: T0 + 4 * H, costs: [{ kind: "FUNDING", amount: 0.11, currency: "USDC" }] })]);
    expect(accountSummary(db, { instanceId: I })).toMatchObject({ totalNet: 38.49, costs: { funding: -1.01, swap: 0, net: 38.49 } });
  });
});
