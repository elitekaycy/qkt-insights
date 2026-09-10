import { describe, it, expect } from "vitest";
import { openDb, ingestEvents, replaceStrategyCapital, listStrategies, strategyStats, equityCurve, drawdownPeriods, type Db } from "../src/index.js";
import type { Envelope } from "@qkt-insights/contract";

const T0 = 1718000000000;
const F = { instanceId: "qkt-prod", strategyId: "gold" };

function env(p: Partial<Envelope> & { type: Envelope["type"]; payload: any }): Envelope {
  return { v: 1, instanceId: "qkt-prod", id: Math.random().toString(36).slice(2), seq: 1, ts: T0, ...p } as Envelope;
}

// A standalone deploy: the daemon's venue-scale risk balance, no portfolio allocation.
const started = (ts: number) =>
  env({ type: "strategy.started", strategyId: "gold", ts, payload: {
    strategyId: "gold", ts, deployName: "gold_paper", dslVersion: 1, runtimeMode: "live",
    symbols: ["EXNESS:XAUUSD"], streams: [], params: {}, risk: { startingBalance: 2_200_000 },
  } });

const deal = (ticket: string, entry: "IN" | "OUT", ts: number, profit: number): Envelope => env({
  id: `deal-${ticket}`, ts, type: "broker.deal", strategyId: "gold", payload: {
    broker: "EXNESS", dealTicket: ticket, positionTicket: "P1", symbol: "EXNESS:XAUUSD", side: entry === "IN" ? "BUY" : "SELL",
    entry, qty: 0.1, price: 2300, profit, commission: 0, swap: 0, magic: 10002, comment: "", strategyId: "gold", ts,
  } });

// Under liveEquityBasis VENUE the daemon puts the account's equity in the strategy snapshot.
const venueSnap = (ts: number, unrealized: number): Envelope => env({
  ts, type: "snapshot.equity", strategyId: "gold",
  payload: { strategyId: "gold", realized: 0, unrealized, equity: 4_999_107.55, startingBalance: 2_200_000 },
});

function tradedGold(): Db {
  const db = openDb(":memory:");
  ingestEvents(db, "qkt-prod", [started(T0), deal("d1", "IN", T0 + 1000, 0), deal("d2", "OUT", T0 + 2000, -350)]);
  return db;
}

describe("defined strategy capital", () => {
  it("replaces the venue-scale starting balance as the base for return, drawdown and the curve", () => {
    const db = tradedGold();
    replaceStrategyCapital(db, { gold: 7000 });

    const row = listStrategies(db, "qkt-prod").find((r) => r.strategyId === "gold")!;
    expect(row.definedCapital).toBe(7000);
    expect(row.startingBalance).toBe(2_200_000);

    const stats = strategyStats(db, F);
    expect(stats.startingBalance).toBe(7000);
    expect(stats.equity).toBe(6650);
    expect(stats.returnPct).toBeCloseTo(-0.05);
    expect(stats.maxDrawdownPct).toBeCloseTo(0.05);

    const curve = equityCurve(db, F);
    expect(curve.map((p) => p.equity)).toEqual([7000, 6650]);
  });

  it("survives the daemon re-announcing strategy.started on restart", () => {
    const db = tradedGold();
    replaceStrategyCapital(db, { gold: 7000 });
    ingestEvents(db, "qkt-prod", [started(T0 + 60_000)]);

    expect(listStrategies(db, "qkt-prod")[0]!.definedCapital).toBe(7000);
    expect(strategyStats(db, F).startingBalance).toBe(7000);
  });

  it("falls back to the stored starting balance once a strategy leaves the map", () => {
    const db = tradedGold();
    replaceStrategyCapital(db, { gold: 7000 });
    replaceStrategyCapital(db, {});

    expect(listStrategies(db, "qkt-prod")[0]!.definedCapital).toBeNull();
    expect(strategyStats(db, F).startingBalance).toBe(2_200_000);
    expect(equityCurve(db, F)[0]!.equity).toBe(2_200_000);
  });
});

describe("snapshot-sourced strategy equity", () => {
  it("is the strategy's own ledger, not the venue equity the snapshot carries", () => {
    const db = openDb(":memory:");
    ingestEvents(db, "qkt-prod", [started(T0), venueSnap(T0 + 1000, 0), venueSnap(T0 + 2000, -40)]);

    expect(equityCurve(db, F).map((p) => p.equity)).toEqual([2_200_000, 2_199_960]);
  });

  it("is measured against the defined capital when one is set", () => {
    const db = openDb(":memory:");
    ingestEvents(db, "qkt-prod", [started(T0), venueSnap(T0 + 1000, 0), venueSnap(T0 + 2000, -40)]);
    replaceStrategyCapital(db, { gold: 7000 });

    expect(equityCurve(db, F).map((p) => p.equity)).toEqual([7000, 6960]);
    const stats = strategyStats(db, F, T0 + 3000);
    expect(stats.equity).toBe(6960);
    expect(stats.maxDrawdownPct).toBeCloseTo(40 / 7000);
    const [dd] = drawdownPeriods(db, F);
    expect(dd!.depth).toBe(40);
    expect(dd!.depthPct).toBeCloseTo((40 / 7000) * 100);
  });
});
