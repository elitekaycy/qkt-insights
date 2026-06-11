import { describe, it, expect } from "vitest";
import { openDb, ingestEvents, performanceReport, dailyNets, drawdownPeriods, postLossStats, openPositions, type Db } from "../src/index.js";
import type { Envelope } from "@qkt-insights/contract";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 5); // Mon 2026-01-05

function env(p: any): Envelope {
  return { v: 1, instanceId: "qkt-prod", id: Math.random().toString(36).slice(2), seq: p.seq ?? 1, ts: p.ts ?? T0, ...p } as Envelope;
}

function snap(ts: number, realized: number, equity: number): Envelope {
  return env({ strategyId: "latch", ts, type: "snapshot.equity",
    payload: { strategyId: "latch", realized, unrealized: 0, equity, startingBalance: 1000 } });
}

function fill(ts: number, side: "BUY" | "SELL"): Envelope {
  return env({ strategyId: "latch", ts, type: "trade",
    payload: { orderId: "o" + ts, symbol: "XAUUSD", side, price: 2000, qty: 0.1, ts } });
}

/**
 * Fixture: 6 days, realized walks 0 -> +100 -> +40 -> +140 -> +120 -> +220.
 * Trade deltas: +100, -60, +100, -20, +100  (3 wins, 2 losses)
 * Equity: 1000, 1100, 1040, 1140, 1120, 1220.
 */
function seeded(): Db {
  const db = openDb(":memory:");
  const realized = [0, 100, 40, 140, 120, 220];
  const equity = [1000, 1100, 1040, 1140, 1120, 1220];
  const events: Envelope[] = [];
  realized.forEach((r, i) => {
    if (i > 0) events.push(fill(T0 + i * DAY - 1000, i % 2 === 1 ? "BUY" : "SELL"));
    events.push(snap(T0 + i * DAY, r, equity[i]!));
  });
  ingestEvents(db, "qkt-prod", events);
  return db;
}

const F = { instanceId: "qkt-prod", strategyId: "latch" };

describe("performanceReport", () => {
  it("computes profitability from realized deltas", () => {
    const r = performanceReport(seeded(), F);
    expect(r.wins).toBe(3);
    expect(r.losses).toBe(2);
    expect(r.grossProfit).toBe(300);
    expect(r.grossLoss).toBe(80);
    expect(r.profitFactor).toBeCloseTo(300 / 80);
    expect(r.expectancy).toBeCloseTo(220 / 5);
    expect(r.avgWin).toBeCloseTo(100);
    expect(r.avgLoss).toBeCloseTo(40);
    expect(r.payoffRatio).toBeCloseTo(2.5);
    // Kelly: W=0.6, R=2.5 -> 0.6 - 0.4/2.5 = 0.44
    expect(r.kelly).toBeCloseTo(0.44);
    expect(r.largestWin).toBe(100);
    expect(r.largestLoss).toBe(60);
    expect(r.approximate).toBe(true);
  });

  it("computes risk from the equity curve", () => {
    const r = performanceReport(seeded(), F);
    // peaks: 1100 -> trough 1040 (60, 5.4545%); 1140 -> 1120 (20, 1.754%)
    expect(r.maxDrawdownAbs).toBeCloseTo(60);
    expect(r.maxDrawdownPct).toBeCloseTo((60 / 1100) * 100);
    expect(r.recoveryFactor).toBeCloseTo(220 / 60);
    expect(r.sharpe).not.toBeNull();
    expect(r.sortino).not.toBeNull();
    expect(r.calmar).not.toBeNull();
    // sortino uses CFA downside dev over all N returns
    const rets = [0.1, 1040 / 1100 - 1, 1140 / 1040 - 1, 1120 / 1140 - 1, 1220 / 1120 - 1];
    const mean = rets.reduce((a, b) => a + b) / rets.length;
    const down = Math.sqrt(rets.reduce((a, b) => a + Math.min(0, b) ** 2, 0) / rets.length);
    expect(r.sortino).toBeCloseTo(((mean * 252) / (down * Math.sqrt(252))) * 1, 4);
  });

  it("computes streaks and day stats", () => {
    const r = performanceReport(seeded(), F);
    // sequence W L W L W
    expect(r.maxWinStreak).toBe(1);
    expect(r.maxLossStreak).toBe(1);
    expect(r.currentStreak).toBe(1);
    expect(r.daysTraded).toBe(5);
    expect(r.profitableDays).toBe(3);
    expect(r.bestDay).toBe(100);
    expect(r.worstDay).toBe(-60);
  });

  it("renders only-wins as profitFactor inf and null loss metrics", () => {
    const db = openDb(":memory:");
    ingestEvents(db, "qkt-prod", [snap(T0, 0, 1000), snap(T0 + DAY, 50, 1050), snap(T0 + 2 * DAY, 120, 1120)]);
    const r = performanceReport(db, F);
    expect(r.profitFactor).toBe("inf");
    expect(r.avgLoss).toBeNull();
    expect(r.payoffRatio).toBeNull();
    expect(r.kelly).toBeNull();
    expect(r.maxLossStreak).toBe(0);
  });

  it("returns empty-safe nulls with no data", () => {
    const r = performanceReport(openDb(":memory:"), F);
    expect(r.wins).toBe(0);
    expect(r.profitFactor).toBeNull();
    expect(r.sharpe).toBeNull();
    expect(r.maxDrawdownPct).toBeNull();
  });
});

describe("dailyNets", () => {
  it("buckets realized change per utc day with fill counts", () => {
    const days = dailyNets(seeded(), F);
    expect(days).toHaveLength(5);
    expect(days[0]).toMatchObject({ day: "2026-01-06", net: 100, trades: 1 });
    expect(days[1]).toMatchObject({ day: "2026-01-07", net: -60 });
    expect(days.map((d) => d.net).reduce((a, b) => a + b)).toBeCloseTo(220);
  });
});

describe("drawdownPeriods", () => {
  it("finds recovered and ongoing periods", () => {
    const db = openDb(":memory:");
    // 1000 -> 1100 -> 1000 -> 1150 -> 1050 (ongoing)
    [1000, 1100, 1000, 1150, 1050].forEach((eq, i) => {
      ingestEvents(db, "qkt-prod", [snap(T0 + i * DAY, eq - 1000, eq)]);
    });
    const periods = drawdownPeriods(db, F);
    expect(periods).toHaveLength(2);
    expect(periods[0]).toMatchObject({ depth: 100, recoveryTs: T0 + 3 * DAY });
    expect(periods[0]!.depthPct).toBeCloseTo((100 / 1100) * 100);
    expect(periods[1]!.recoveryTs).toBeNull();
    expect(periods[1]!.depth).toBe(100);
  });
});

describe("postLossStats", () => {
  it("measures the next trade after N consecutive losses", () => {
    const db = openDb(":memory:");
    // deltas: -10, -10, +30, -10, +20  => after 1 loss: next trades {-10, +30, +20} ... sequence-based
    const realized = [0, -10, -20, 10, 0, 20];
    realized.forEach((r, i) => ingestEvents(db, "qkt-prod", [snap(T0 + i * DAY, r, 1000 + r)]));
    const rows = postLossStats(db, F);
    const n1 = rows.find((r) => r.n === 1)!;
    // runs of >=1 loss end before trades: idx1(-10)->next -10 (loss), idx2(-20 end of 2-run)->next +30 win, idx4(-10)->next +20 win
    expect(n1.sample).toBe(3);
    expect(n1.nextWinRate).toBeCloseTo((2 / 3) * 100);
    const n2 = rows.find((r) => r.n === 2)!;
    expect(n2.sample).toBe(1);
    expect(n2.nextWinRate).toBe(100);
    expect(rows.find((r) => r.n === 3)).toBeUndefined();
  });
});

describe("openPositions", () => {
  it("returns the latest position snapshot per strategy and symbol", () => {
    const db = openDb(":memory:");
    const pos = (ts: number, legs: any[]) =>
      env({ strategyId: "latch", ts, type: "snapshot.position",
        payload: { strategyId: "latch", symbol: "XAUUSD", legs } });
    ingestEvents(db, "qkt-prod", [
      pos(T0, [{ side: "BUY", qty: 0.2, entryPrice: 2000, entryTs: T0 - DAY }]),
      pos(T0 + 1000, [{ side: "BUY", qty: 0.1, entryPrice: 2010, entryTs: T0 }]),
    ]);
    const rows = openPositions(db, { instanceId: "qkt-prod" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ strategyId: "latch", symbol: "XAUUSD" });
    expect(rows[0]!.legs).toHaveLength(1);
    expect(rows[0]!.legs[0]).toMatchObject({ qty: 0.1, entryPrice: 2010 });
  });

  it("omits symbols whose latest snapshot has no legs", () => {
    const db = openDb(":memory:");
    ingestEvents(db, "qkt-prod", [
      env({ strategyId: "latch", ts: T0, type: "snapshot.position", payload: { strategyId: "latch", symbol: "XAUUSD", legs: [] } }),
    ]);
    expect(openPositions(db, { instanceId: "qkt-prod" })).toHaveLength(0);
  });
});
