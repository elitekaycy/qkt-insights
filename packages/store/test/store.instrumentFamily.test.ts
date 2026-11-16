import { describe, it, expect } from "vitest";
import type { Envelope } from "@qkt-insights/contract";
import { parseQuery } from "@qkt-insights/contract/query";
import { accountSummary, ingestEvents, listRoundTrips, listStrategies, openDb, roundTripAnalytics } from "../src/index.js";
import { familyKey } from "../src/instrumentFamily.js";

/*
 * Contracts that expire group under the family qkt states as their `root`: a strategy rolling an hourly event series
 * or a dated future trades a new contract each roll, and its history reads as one instrument. Synthetic fixtures.
 */
const I = "fam";
const T0 = Date.UTC(2026, 10, 16, 14);
const H = 3_600_000;
let seq = 1;

function deal(ticket: string, position: string, entry: "IN" | "OUT", symbol: string, strategyId: string, instrument: Record<string, unknown>, at: number): Envelope {
  return {
    v: 1, instanceId: I, id: `deal-${ticket}`, seq: seq++, ts: at, type: "broker.deal",
    payload: {
      broker: symbol.split(":")[0], dealTicket: ticket, positionId: position, symbol, side: entry === "IN" ? "BUY" : "SELL", legEntry: entry,
      qty: 0.01, price: 0.4, profit: entry === "OUT" ? 2 : 0, commission: 0, swap: 0, strategyId, attribution: "order", ts: at, instrument,
    },
  } as Envelope;
}

const started = (strategyId: string): Envelope =>
  ({ v: 1, instanceId: I, id: `started-${strategyId}`, seq: seq++, ts: T0, strategyId, type: "strategy.started", payload: { strategyId } }) as Envelope;

const EVENT = { kind: "event", root: "KALSHI:KXINXU", contractSize: 1 };

/** Two hourly contracts of one event series, two dated futures and an option on one root, a perpetual, a CFD. */
function seed() {
  const db = openDb(":memory:");
  ingestEvents(db, I, ["hourly", "futs", "perp", "gold"].map(started));
  const trip = (n: number, symbol: string, strategy: string, instrument: Record<string, unknown>) => [
    deal(`${n}a`, `p${n}`, "IN", symbol, strategy, instrument, T0 + n * H),
    deal(`${n}b`, `p${n}`, "OUT", symbol, strategy, instrument, T0 + n * H + 30 * 60_000),
  ];
  ingestEvents(db, I, [
    ...trip(1, "KALSHI:KXINXU-26NOV16H15-T6999.99", "hourly", EVENT),
    ...trip(2, "KALSHI:KXINXU-26NOV16H16-T7024.99", "hourly", EVENT),
    ...trip(3, "DERIBIT:BTC_USDC_27NOV26", "futs", { kind: "future", root: "DERIBIT:BTC", expiry: T0 }),
    ...trip(4, "DERIBIT:BTC_USDC_25DEC26", "futs", { kind: "future", root: "DERIBIT:BTC", expiry: T0 }),
    ...trip(5, "DERIBIT:BTC_USDC_27NOV26_80000_C", "futs", { kind: "option", root: "DERIBIT:BTC", strike: 80000, optionRight: "call" }),
    ...trip(6, "DERIBIT:BTC_USDC_PERPETUAL", "perp", { kind: "perpetual", root: "DERIBIT:BTC" }),
    ...trip(7, "EXNESS:XAUUSD", "gold", { kind: "cfd", category: "Metals" }),
  ]);
  return db;
}

const trips = (db: ReturnType<typeof openDb>, q = "") =>
  listRoundTrips(db, { instanceId: I, filter: parseQuery(q).filter }).rows.map((r) => [r.id, r.instrument]).sort();

describe("instrument families", () => {
  it("keys an expiring contract by its root and kind, anything else by its symbol", () => {
    expect(familyKey("KALSHI:KXINXU-26NOV16H15-T6999.99", "event", "KALSHI:KXINXU")).toBe("KXINXU@EVENT");
    expect(familyKey("CME:ESZ6", "FUTURE", "CME:ES")).toBe("ES@FUTURE");
    expect(familyKey("DERIBIT:BTC_USDC_27NOV26_80000_C", "option", "DERIBIT:BTC")).toBe("BTC@OPTION");
    expect(familyKey("DERIBIT:BTC_USDC_PERPETUAL", "perpetual", "DERIBIT:BTC")).toBe("BTC_USDC_PERPETUAL");
    expect(familyKey("CME:ESZ6", "future", null)).toBe("ESZ6");
    expect(familyKey("EXNESS:XAUUSD", null, null)).toBe("XAUUSD");
  });

  it("puts every round trip of a family under one instrument, futures and options of a root apart", () => {
    expect(trips(seed())).toEqual([
      ["p1", "KXINXU@EVENT"], ["p2", "KXINXU@EVENT"], ["p3", "BTC@FUTURE"], ["p4", "BTC@FUTURE"], ["p5", "BTC@OPTION"],
      ["p6", "BTC_USDC_PERPETUAL"], ["p7", "XAUUSD"],
    ]);
  });

  it("filters by a family or by one contract of it", () => {
    const db = seed();
    expect(trips(db, "symbol:KXINXU@EVENT").map(([id]) => id)).toEqual(["p1", "p2"]);
    expect(trips(db, "symbol:KXINXU-26NOV16H16-T7024.99").map(([id]) => id)).toEqual(["p2"]);
    expect(trips(db, "symbol:XAUUSD").map(([id]) => id)).toEqual(["p7"]);
  });

  it("buckets the trips analytics, the account and a strategy's instruments by family", () => {
    const db = seed();
    const a = roundTripAnalytics(db, { instanceId: I });
    expect(a.instrument.find((b) => b.key === "KXINXU@EVENT")).toMatchObject({ n: 2, wins: 2 });
    const account = accountSummary(db, { instanceId: I });
    expect(account.byInstrument.find((b) => b.key === "KXINXU@EVENT")).toMatchObject({ trades: 2 });
    expect(account.byInstrument.find((b) => b.key === "BTC@FUTURE")).toMatchObject({ trades: 2 });
    const hourly = listStrategies(db, I).find((s) => s.strategyId === "hourly")!;
    expect(hourly.instruments.map((i) => [i.symbol, i.kind])).toEqual([["KALSHI:KXINXU@EVENT", "event"]]);
    const futs = listStrategies(db, I).find((s) => s.strategyId === "futs")!;
    expect(futs.instruments.map((i) => i.symbol).sort()).toEqual(["DERIBIT:BTC@FUTURE", "DERIBIT:BTC@OPTION"]);
  });
});
