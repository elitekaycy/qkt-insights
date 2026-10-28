import { describe, it, expect } from "vitest";
import type { Envelope } from "@qkt-insights/contract";
import { openDb, ingestEvents, persistStateEvent, instanceCurrencies, listInstances, listRoundTrips, roundTripTotals, roundTripAnalytics, type Db } from "../src/index.js";

const I = "soak";
const T0 = Date.UTC(2026, 9, 12, 14);
const H = 3_600_000;
let seq = 1;

function account(broker: string, currency: string, accountId?: string): Envelope {
  return { v: 1, instanceId: I, id: `acct-${broker}-${seq}`, seq: seq++, ts: T0, type: "state.account",
    payload: { broker, currency, balance: 1000, equity: 1000, ...(accountId ? { accountId } : {}) } } as Envelope;
}

function trip(db: Db, broker: string, n: string, profit: number, accountId?: string): void {
  const leg = (ticket: string, entry: "IN" | "OUT", ts: number, p: number): Envelope => ({
    v: 1, instanceId: I, id: `deal-${broker}-${ticket}`, seq: seq++, ts, type: "broker.deal",
    payload: { broker, dealTicket: ticket, positionId: `${broker}#${n}`, symbol: `${broker}:BTCUSD`, side: entry === "IN" ? "BUY" : "SELL", legEntry: entry,
      qty: 1, price: 100, profit: p, commission: 0, swap: 0, strategyId: "mix", attribution: "order", ts, ...(accountId ? { accountId } : {}) },
  } as Envelope);
  ingestEvents(db, I, [leg(`${n}-in`, "IN", T0, 0), leg(`${n}-out`, "OUT", T0 + H, profit)]);
}

describe("money in more than one currency", () => {
  it("remembers each venue account's currency, by its id or else its label", () => {
    const db = openDb(":memory:");
    ingestEvents(db, I, [{ v: 1, instanceId: I, id: "s", seq: seq++, ts: T0, type: "strategy.started", strategyId: "mix", payload: { strategyId: "mix" } } as Envelope]);
    persistStateEvent(db, I, account("EXNESS", "USD"));
    persistStateEvent(db, I, account("DERIBIT", "USDC", "vgp:00000000000000aa"));
    persistStateEvent(db, I, account("BYBIT_LINEAR", "USDT", "vgp:00000000000000bb"));
    persistStateEvent(db, I, account("BYBIT_LINEAR", "USDT", "vgp:00000000000000bb"));
    expect(instanceCurrencies(db, I)).toEqual(["USD", "USDC", "USDT"]);
    expect(listInstances(db).find((r) => r.id === I)!.currencies).toEqual(["USD", "USDC", "USDT"]);
  });

  it("never adds two currencies into one total: the round trips carry their currency and the totals split by it", () => {
    const db = openDb(":memory:");
    persistStateEvent(db, I, account("EXNESS", "USD"));
    persistStateEvent(db, I, account("DERIBIT", "USDC", "vgp:00000000000000aa"));
    trip(db, "EXNESS", "1", 7);
    trip(db, "EXNESS", "2", -1.25);
    trip(db, "DERIBIT", "3", -3.9, "vgp:00000000000000aa");
    const rows = new Map(listRoundTrips(db, { instanceId: I }).rows.map((r) => [r.id, r.currency]));
    expect(rows).toEqual(new Map([["EXNESS#1", "USD"], ["EXNESS#2", "USD"], ["DERIBIT#3", "USDC"]]));
    const byCurrency = [{ currency: "USD", net: 5.75, n: 2 }, { currency: "USDC", net: -3.9, n: 1 }];
    expect(roundTripTotals(db, { instanceId: I }).currencies).toEqual(byCurrency);
    expect(roundTripAnalytics(db, { instanceId: I }).currencies).toEqual(byCurrency);
  });

  it("keeps an instance with one known currency in one entry: nothing else to split it by", () => {
    const db = openDb(":memory:");
    persistStateEvent(db, I, account("EXNESS", "USD"));
    trip(db, "EXNESS", "1", 7);
    trip(db, "SILENT", "2", 1);
    expect(roundTripTotals(db, { instanceId: I }).currencies).toEqual([{ currency: "USD", net: 8, n: 2 }]);
    expect(roundTripTotals(db, { instanceId: "nothing" }).currencies).toEqual([]);
  });
});
