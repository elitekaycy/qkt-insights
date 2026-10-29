import { describe, it, expect } from "vitest";
import type { Envelope } from "@qkt-insights/contract";
import { parseQuery } from "@qkt-insights/contract/query";
import { openDb, ingestEvents, listRoundTrips, listStrategies, LiveStateStore } from "../src/index.js";

const I = "soak";
const T0 = Date.UTC(2026, 9, 12, 14);
const H = 3_600_000;
let seq = 1;

function deal(ticket: string, position: string, entry: "IN" | "OUT", symbol: string, strategyId: string, instrument: Record<string, unknown>): Envelope {
  const ts = entry === "IN" ? T0 + seq * 1000 : T0 + H + seq * 1000;
  return {
    v: 1, instanceId: I, id: `deal-${ticket}`, seq: seq++, ts, type: "broker.deal",
    payload: {
      broker: symbol.split(":")[0], dealTicket: ticket, positionId: position, symbol, side: entry === "IN" ? "BUY" : "SELL", legEntry: entry, qty: 1, price: 100,
      profit: entry === "OUT" ? 5 : 0, commission: 0, swap: 0, strategyId, attribution: "order", ts, instrument,
    },
  } as Envelope;
}

function started(strategyId: string): Envelope {
  return { v: 1, instanceId: I, id: `started-${strategyId}`, seq: seq++, ts: T0, strategyId, type: "strategy.started", payload: { strategyId } } as Envelope;
}

function seed() {
  const db = openDb(":memory:");
  // a deal counts on this instance once its strategy has started here
  ingestEvents(db, I, ["stocks", "gold", "perp", "old"].map(started));
  ingestEvents(db, I, [
    deal("1", "501", "IN", "EXNESS:AAPL", "stocks", { kind: "cfd", category: "Stocks", contractSize: 1 }),
    deal("2", "501", "OUT", "EXNESS:AAPL", "stocks", { kind: "cfd", category: "Stocks", contractSize: 1 }),
    deal("3", "502", "IN", "EXNESS:XAUUSD", "gold", { kind: "cfd", category: "Metals", contractSize: 100 }),
    deal("4", "503", "IN", "DERIBIT:BTC_USDC_PERPETUAL", "perp", { kind: "perpetual", contractSize: 0.001 }),
    deal("5", "504", "IN", "OLD:EURUSD", "old", {}),
  ]);
  return db;
}

const ids = (db: ReturnType<typeof openDb>, q: string) =>
  listRoundTrips(db, { instanceId: I, filter: parseQuery(q).filter }).rows.map((r) => r.id).sort();

describe("instrument types", () => {
  it("keeps the venue folder qkt states on each deal and its round trip", () => {
    const db = seed();
    const rows = new Map(listRoundTrips(db, { instanceId: I }).rows.map((r) => [r.id, [r.kind, r.category]]));
    expect(rows.get("501")).toEqual(["cfd", "Stocks"]);
    expect(rows.get("502")).toEqual(["cfd", "Metals"]);
    expect(rows.get("503")).toEqual(["perpetual", null]);
    expect(rows.get("504")).toEqual([null, null]);
  });

  it("filters round trips by type: every CFD, only stock CFDs, perpetuals", () => {
    const db = seed();
    expect(ids(db, "type:cfd")).toEqual(["501", "502"]);
    expect(ids(db, "type:stock-cfd")).toEqual(["501"]);
    expect(ids(db, "type:perpetual")).toEqual(["503"]);
    expect(ids(db, "type:option")).toEqual([]);
  });

  it("lists what each strategy has traded, by symbol, from its deals", () => {
    const db = seed();
    const byId = new Map(listStrategies(db, I).map((s) => [s.strategyId, s.instruments]));
    expect(byId.get("stocks")).toEqual([{ symbol: "EXNESS:AAPL", broker: "EXNESS", kind: "cfd", category: "Stocks", contractSize: 1, unit: "lots" }]);
    expect(byId.get("perp")).toEqual([{ symbol: "DERIBIT:BTC_USDC_PERPETUAL", broker: "DERIBIT", kind: "perpetual", category: null, contractSize: 0.001, unit: "contracts" }]);
    expect(byId.get("old")).toEqual([]);
  });

  it("carries an open position's venue folder into the live state", () => {
    const store = new LiveStateStore();
    store.upsert(I, { v: 1, instanceId: I, id: "p", seq: 1, ts: T0, type: "state.positions", payload: { broker: "EXNESS", positions: [
      { ticket: "7", symbol: "EXNESS:AAPL", side: "BUY", qty: 0.5, entryPrice: 228, instrument: { kind: "cfd", category: "Stocks", contractSize: 1 } },
    ] } } as Envelope);
    expect(store.snapshot(T0).positions[0]!.list[0]).toMatchObject({ kind: "cfd", category: "Stocks", unit: "lots", contractSize: 1 });
  });
});
