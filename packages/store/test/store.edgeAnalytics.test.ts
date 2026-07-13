import { describe, it, expect } from "vitest";
import {
  openDb, ingestEvents, dowHourMatrix, rollingStats, costDecomposition, contributionRanking,
  tradeBreakdowns, performanceReport, type Db,
} from "../src/index.js";
import type { Envelope } from "@qkt-insights/contract";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 4, 11); // Mon 2026-05-11 00:00 UTC

let seq = 0;
function dealEnv(p: {
  ticket: string; positionTicket: string; entry: "IN" | "OUT" | "OUT_BY"; side: "BUY" | "SELL";
  ts: number; price: number; symbol?: string; qty?: number; profit?: number; commission?: number; swap?: number;
}): Envelope {
  return {
    v: 1, instanceId: "qkt-prod", id: `deal-EXNESS-${p.ticket}`, seq: ++seq, ts: p.ts,
    type: "broker.deal",
    payload: {
      broker: "EXNESS", dealTicket: p.ticket, positionTicket: p.positionTicket,
      symbol: p.symbol ?? "EXNESS:XAUUSD", side: p.side, entry: p.entry, qty: p.qty ?? 0.01, price: p.price,
      profit: p.profit ?? 0, commission: p.commission ?? 0, swap: p.swap ?? 0,
      comment: "dsl-hedge_straddle", strategyId: "hedge_straddle", ts: p.ts,
    },
  } as Envelope;
}

function seedStrategy(db: Db, sb: number | null): void {
  db.prepare(
    "INSERT INTO strategies (instance_id, strategy_id, first_seen, last_seen, starting_balance) VALUES (?,?,?,?,?)",
  ).run("qkt-prod", "hedge_straddle", T0, T0, sb);
}

/** Round-trip position: IN at openTs, OUT at closeTs with the given money. */
function roundTrip(db: Db, n: number, p: {
  openTs: number; closeTs: number; profit: number; commission?: number; swap?: number;
  symbol?: string; side?: "BUY" | "SELL";
}): void {
  const side = p.side ?? "BUY";
  const out = side === "BUY" ? "SELL" : "BUY";
  ingestEvents(db, "qkt-prod", [
    dealEnv({ ticket: `${n}i`, positionTicket: `${n}`, entry: "IN", side, ts: p.openTs, price: 4300, symbol: p.symbol }),
    dealEnv({
      ticket: `${n}o`, positionTicket: `${n}`, entry: "OUT", side: out, ts: p.closeTs, price: 4310,
      profit: p.profit, commission: p.commission ?? 0, swap: p.swap ?? 0, symbol: p.symbol,
    }),
  ]);
}

const F = { instanceId: "qkt-prod", strategyId: "hedge_straddle" };

describe("dowHourMatrix", () => {
  it("buckets closes by UTC dow and hour with exact cell stats", () => {
    const db = openDb(":memory:");
    seedStrategy(db, 10000);
    // Mon 01:00 — two trades: +10, -4 → n 2, net 6, mean 3, winRate 50
    roundTrip(db, 1, { openTs: T0, closeTs: T0 + HOUR, profit: 10 });
    roundTrip(db, 2, { openTs: T0, closeTs: T0 + HOUR + 60_000, profit: -4 });
    // Tue 23:00 — one trade: +5
    roundTrip(db, 3, { openTs: T0 + DAY, closeTs: T0 + DAY + 23 * HOUR, profit: 5 });
    const cells = dowHourMatrix(db, F)!;
    expect(cells).toHaveLength(2);
    expect(cells[0]).toEqual({ dow: 0, hour: 1, n: 2, net: 6, mean: 3, winRate: 50 });
    expect(cells[1]).toEqual({ dow: 1, hour: 23, n: 1, net: 5, mean: 5, winRate: 100 });
  });

  it("keeps Sun 23:00 and Mon 00:00 in distinct cells across the week boundary", () => {
    const db = openDb(":memory:");
    seedStrategy(db, 10000);
    const sun23 = T0 + 6 * DAY + 23 * HOUR; // Sun 2026-05-17 23:00
    const mon00 = T0 + 7 * DAY; // Mon 2026-05-18 00:00
    roundTrip(db, 1, { openTs: sun23 - HOUR, closeTs: sun23, profit: 1 });
    roundTrip(db, 2, { openTs: sun23, closeTs: mon00, profit: 2 });
    const cells = dowHourMatrix(db, F)!;
    expect(cells).toEqual([
      { dow: 0, hour: 0, n: 1, net: 2, mean: 2, winRate: 100 },
      { dow: 6, hour: 23, n: 1, net: 1, mean: 1, winRate: 100 },
    ]);
  });

  it("is null when nothing closed", () => {
    const db = openDb(":memory:");
    seedStrategy(db, 10000);
    expect(dowHourMatrix(db, F)).toBeNull();
  });

  it("respects the from/to window", () => {
    const db = openDb(":memory:");
    seedStrategy(db, 10000);
    roundTrip(db, 1, { openTs: T0, closeTs: T0 + HOUR, profit: 10 });
    roundTrip(db, 2, { openTs: T0 + DAY, closeTs: T0 + DAY + HOUR, profit: 5 });
    const cells = dowHourMatrix(db, { ...F, from: T0 + DAY })!;
    expect(cells).toEqual([{ dow: 1, hour: 1, n: 1, net: 5, mean: 5, winRate: 100 }]);
  });
});

describe("breakdown standard errors", () => {
  it("computes hand-checked SE per bucket and null for single-trade buckets", () => {
    const db = openDb(":memory:");
    seedStrategy(db, 10000);
    // Three trades in hour 01 Mon: 10, -4, 6 → mean 4, sd = sqrt(((6)^2+(-8)^2+(2)^2)/2)=sqrt(52)
    roundTrip(db, 1, { openTs: T0, closeTs: T0 + HOUR, profit: 10 });
    roundTrip(db, 2, { openTs: T0, closeTs: T0 + HOUR + 1, profit: -4 });
    roundTrip(db, 3, { openTs: T0, closeTs: T0 + HOUR + 2, profit: 6 });
    // One trade Tue → se null
    roundTrip(db, 4, { openTs: T0 + DAY, closeTs: T0 + DAY + HOUR, profit: 5 });
    const b = tradeBreakdowns(db, F)!;
    const mon = b.byDow.find((r) => r.key === "Mon")!;
    expect(mon.se).toBeCloseTo(Math.sqrt(52) / Math.sqrt(3), 10);
    expect(b.byDow.find((r) => r.key === "Tue")!.se).toBeNull();
  });

  it("reports se 0 for a zero-variance bucket", () => {
    const db = openDb(":memory:");
    seedStrategy(db, 10000);
    roundTrip(db, 1, { openTs: T0, closeTs: T0 + HOUR, profit: 5 });
    roundTrip(db, 2, { openTs: T0, closeTs: T0 + HOUR + 1, profit: 5 });
    expect(tradeBreakdowns(db, F)!.byDow.find((r) => r.key === "Mon")!.se).toBe(0);
  });
});

describe("rollingStats", () => {
  it("emits warmup nulls then a hand-computed rolling window", () => {
    const db = openDb(":memory:");
    seedStrategy(db, 10000);
    // One close per day for 5 days: +100, -50, +200, +100, -100
    const nets = [100, -50, 200, 100, -100];
    nets.forEach((p, i) => roundTrip(db, i + 1, { openTs: T0 + i * DAY, closeTs: T0 + i * DAY + HOUR, profit: p }));
    const pts = rollingStats(db, F, 7); // window clamps to 7 > observations → sharpe stays null
    expect(pts.every((p) => p.sharpe === null)).toBe(true);
    // winRate/meanNet still fill from traded days inside the window
    const last = pts[pts.length - 1]!;
    expect(last.winRate).toBeCloseTo((3 / 5) * 100);
    expect(last.meanNet).toBeCloseTo(250 / 5);
  });

  it("computes sharpe once the window has enough return observations", () => {
    const db = openDb(":memory:");
    seedStrategy(db, 10000);
    for (let i = 0; i < 10; i++) {
      roundTrip(db, i + 1, { openTs: T0 + i * DAY, closeTs: T0 + i * DAY + HOUR, profit: i % 2 === 0 ? 100 : -50 });
    }
    const pts = rollingStats(db, F, 7);
    // 11 equity days (anchor day + 10 close days share day 0... anchor is same day) →
    // returns start at day index 1; the last point has ≥7 observations.
    const last = pts[pts.length - 1]!;
    expect(last.sharpe).not.toBeNull();
    const early = pts[2]!;
    expect(early.sharpe).toBeNull();
  });

  it("clamps the window parameter into [7,180]", () => {
    const db = openDb(":memory:");
    seedStrategy(db, 10000);
    roundTrip(db, 1, { openTs: T0, closeTs: T0 + HOUR, profit: 10 });
    expect(() => rollingStats(db, F, 1)).not.toThrow();
    expect(() => rollingStats(db, F, 10_000)).not.toThrow();
  });
});

describe("costDecomposition", () => {
  it("splits gross, commission, swap per month and reconciles net with the report", () => {
    const db = openDb(":memory:");
    seedStrategy(db, 10000);
    roundTrip(db, 1, { openTs: T0, closeTs: T0 + HOUR, profit: 10, commission: -0.5, swap: -0.25 });
    const june = Date.UTC(2026, 5, 2);
    roundTrip(db, 2, { openTs: june, closeTs: june + HOUR, profit: -4, commission: -0.5 });
    const c = costDecomposition(db, F)!;
    expect(c.byMonth).toEqual([
      { key: "2026-05", grossProfit: 10, commission: -0.5, swap: -0.25, net: 9.25, trades: 1 },
      { key: "2026-06", grossProfit: -4, commission: -0.5, swap: 0, net: -4.5, trades: 1 },
    ]);
    expect(c.total.net).toBeCloseTo(4.75);
    expect(c.total.net).toBeCloseTo(performanceReport(db, F).totalNet);
  });

  it("is null without a deals source", () => {
    const db = openDb(":memory:");
    seedStrategy(db, 10000);
    expect(costDecomposition(db, F)).toBeNull();
  });
});

describe("contributionRanking", () => {
  it("ranks symbols by net with expectancy and signed share", () => {
    const db = openDb(":memory:");
    seedStrategy(db, 10000);
    roundTrip(db, 1, { openTs: T0, closeTs: T0 + HOUR, profit: 30, symbol: "EXNESS:XAUUSD" });
    roundTrip(db, 2, { openTs: T0, closeTs: T0 + 2 * HOUR, profit: -10, symbol: "EXNESS:XAUUSD" });
    roundTrip(db, 3, { openTs: T0, closeTs: T0 + 3 * HOUR, profit: -5, symbol: "EXNESS:EURUSD", side: "SELL" });
    const c = contributionRanking(db, F)!;
    expect(c.totalNet).toBeCloseTo(15);
    expect(c.bySymbol[0]).toMatchObject({ key: "EXNESS:XAUUSD", net: 20, trades: 2, winRate: 50, expectancy: 10 });
    expect(c.bySymbol[0]!.share).toBeCloseTo(20 / 15);
    expect(c.bySymbol[1]!.share).toBeCloseTo(-5 / 15);
    expect(c.byDirection.map((r) => r.key).sort()).toEqual(["BUY", "SELL"]);
  });

  it("shares stay signed against a negative total", () => {
    const db = openDb(":memory:");
    seedStrategy(db, 10000);
    roundTrip(db, 1, { openTs: T0, closeTs: T0 + HOUR, profit: 10, symbol: "EXNESS:XAUUSD" });
    roundTrip(db, 2, { openTs: T0, closeTs: T0 + 2 * HOUR, profit: -30, symbol: "EXNESS:EURUSD" });
    const c = contributionRanking(db, F)!;
    expect(c.totalNet).toBeCloseTo(-20);
    // Profitable symbol against a losing book: share is negative by the signed convention.
    expect(c.bySymbol[0]!.share).toBeCloseTo(10 / -20);
  });

  it("is null with no closes", () => {
    const db = openDb(":memory:");
    seedStrategy(db, 10000);
    expect(contributionRanking(db, F)).toBeNull();
  });
});
