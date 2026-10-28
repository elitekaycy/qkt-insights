import { describe, it, expect } from "vitest";
import type { Envelope } from "@qkt-insights/contract";
import { openDb, ingestEvents, listRoundTrips, roundTripDetail, LiveStateStore, quantityUnitOf } from "../src/index.js";

const I = "soak";
const T0 = Date.UTC(2026, 9, 12, 14);
const H = 3_600_000;
let seq = 1;

function deal(broker: string, ticket: string, position: string, entry: "IN" | "OUT", symbol: string, qty: number,
  instrument?: Record<string, unknown>): Envelope {
  return {
    v: 1, instanceId: I, id: `deal-${broker}-${ticket}`, seq: seq++, ts: entry === "IN" ? T0 : T0 + H, type: "broker.deal",
    payload: {
      broker, dealTicket: ticket, positionId: position, symbol, side: entry === "IN" ? "BUY" : "SELL", legEntry: entry, qty, price: 100,
      profit: 0, commission: 0, swap: 0, strategyId: "mix", attribution: "order", ts: entry === "IN" ? T0 : T0 + H,
      ...(instrument ? { instrument } : {}),
    },
  } as Envelope;
}

describe("instrument kind and quantity units", () => {
  it("names each kind's unit, a stated unit first, and nothing it cannot know", () => {
    expect(quantityUnitOf("cfd", null)).toBe("lots");
    expect(quantityUnitOf("equity", null)).toBe("shares");
    expect(quantityUnitOf("spot", null)).toBe("coins");
    expect(quantityUnitOf("perpetual", null)).toBe("contracts");
    expect(quantityUnitOf("future", null)).toBe("contracts");
    expect(quantityUnitOf("option", null)).toBe("contracts");
    expect(quantityUnitOf("PERPETUAL", "BTC")).toBe("BTC");
    expect(quantityUnitOf(null, null)).toBeNull();
    expect(quantityUnitOf("warrant", null)).toBeNull();
  });

  it("carries the kind, unit and contract size qkt states on the deals into each round trip", () => {
    const db = openDb(":memory:");
    ingestEvents(db, I, [
      deal("EXNESS_S01", "1", "501", "IN", "EXNESS_S01:AAPL", 0.1, { kind: "cfd", contractSize: 1 }),
      deal("EXNESS_S01", "2", "501", "OUT", "EXNESS_S01:AAPL", 0.1, { kind: "cfd", contractSize: 1 }),
      deal("ALPACA", "a1", "ALPACA:AAPL#1", "IN", "ALPACA:AAPL", 10, { kind: "equity" }),
      deal("DERIBIT", "d1", "DERIBIT:BTC_USDC_PERPETUAL#1", "IN", "DERIBIT:BTC_USDC_PERPETUAL", 10, { kind: "perpetual", contractSize: 0.001, quantityUnit: "contracts" }),
      deal("OLDQKT", "o1", "o-1", "IN", "OLDQKT:XAUUSD", 0.5),
    ]);
    const rows = new Map(listRoundTrips(db, { instanceId: I }).rows.map((r) => [r.id, { kind: r.kind, unit: r.unit, contractSize: r.contractSize }]));
    expect(rows.get("501")).toEqual({ kind: "cfd", unit: "lots", contractSize: 1 });
    expect(rows.get("ALPACA:AAPL#1")).toEqual({ kind: "equity", unit: "shares", contractSize: null });
    expect(rows.get("DERIBIT:BTC_USDC_PERPETUAL#1")).toEqual({ kind: "perpetual", unit: "contracts", contractSize: 0.001 });
    expect(rows.get("o-1")).toEqual({ kind: null, unit: null, contractSize: null });
    expect(roundTripDetail(db, I, "ALPACA:AAPL#1")!.trip).toMatchObject({ kind: "equity", unit: "shares" });
  });

  it("carries an open position's kind and unit into the live state", () => {
    const store = new LiveStateStore();
    store.upsert(I, { v: 1, instanceId: I, id: "p", seq: 1, ts: T0, type: "state.positions", payload: { broker: "ALPACA", positions: [
      { ticket: "ALPACA:AAPL#1", symbol: "ALPACA:AAPL", side: "BUY", qty: 10, entryPrice: 228, instrument: { kind: "equity" } },
      { ticket: "9", symbol: "EXNESS:XAUUSD", side: "BUY", qty: 0.01, entryPrice: 4000 },
    ] } } as Envelope);
    const list = store.snapshot(T0).positions[0]!.list;
    expect(list.map((p) => ({ ticket: p.ticket, kind: p.kind, unit: p.unit }))).toEqual([
      { ticket: "ALPACA:AAPL#1", kind: "equity", unit: "shares" },
      { ticket: "9", kind: undefined, unit: undefined },
    ]);
  });
});
