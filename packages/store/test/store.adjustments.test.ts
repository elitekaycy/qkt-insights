import { describe, it, expect } from "vitest";
import {
  openDb, ingestEvents, dailyNets, listStrategies, strategyEquityCurve, performanceReport, costDecomposition,
  accountSummary, rebuildProjection, closedTrades, adjustmentRows, type Db,
} from "../src/index.js";
import type { Envelope } from "@qkt-insights/contract";

const H = 3_600_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 26, 14);
const I = "i1";

let seq = 0;
function leg(ticket: string, position: string, entry: "IN" | "OUT", ts: number, profit: number, strategyId: string | null, broker = "B"): Envelope {
  return {
    v: 1, instanceId: I, id: `deal-${broker}-${ticket}`, seq: seq++, ts, type: "broker.deal",
    payload: {
      broker, dealTicket: ticket, positionTicket: position, symbol: "B:AAPL", side: entry === "IN" ? "BUY" : "SELL",
      entry, qty: 0.01, price: 346, profit, commission: 0, ...(strategyId ? { strategyId } : {}), ts,
    },
  } as Envelope;
}

/** A venue booking as qkt's AdjustmentCycle sends it: entry ADJUSTMENT, no quantity, the money in profit. */
function adjustment(ticket: string, position: string, ts: number, profit: number, strategyId: string | null, broker = "B"): Envelope {
  return {
    v: 1, instanceId: I, id: `deal-${broker}-${ticket}`, seq: seq++, ts, type: "broker.deal",
    payload: {
      broker, dealTicket: ticket, positionTicket: position, symbol: "B:AAPL", entry: "ADJUSTMENT", qty: 0, price: 0, profit,
      comment: "DIVIDEND: AAPL", adjustment: "DIVIDEND", ...(strategyId ? { strategyId } : {}), ts,
    },
  } as Envelope;
}

function seeded(): Db {
  const db = openDb(":memory:");
  for (const s of ["a", "b"]) db.prepare("INSERT INTO strategies (instance_id, strategy_id, first_seen, last_seen, starting_balance) VALUES (?,?,?,?,?)").run(I, s, T0, T0, 10_000);
  return db;
}

const F = { instanceId: I, strategyId: "a" };
/** The same figures computed from the rows: a `from` before everything bypasses the projection. */
const computed = { ...F, from: 0 };
const net = (db: Db, s = "a") => listStrategies(db, I).find((r) => r.strategyId === s)!;

/** Two closed AAPL positions and a 0.26 dividend credited on the first one, held over its ex-date. */
function trades(db: Db): void {
  ingestEvents(db, I, [
    leg("1", "P1", "IN", T0, 0, "a"), adjustment("9", "P1", T0 + DAY - 4 * H, 0.26, "a"), leg("2", "P1", "OUT", T0 + DAY, 1.5, "a"),
    leg("3", "P2", "IN", T0 + 2 * DAY, 0, "a"), leg("4", "P2", "OUT", T0 + 2 * DAY + H, -0.75, "a"),
  ]);
}

describe("venue adjustments", () => {
  it("are in the strategy's net, days and equity, and in no trade count, win or expectancy", () => {
    const db = seeded();
    trades(db);
    expect(net(db)).toMatchObject({ realizedNet: 1.01, dealCount: 2 });
    expect(dailyNets(db, F)).toEqual([
      { day: "2026-10-27", net: 1.76, trades: 1 },
      { day: "2026-10-28", net: -0.75, trades: 1 },
    ]);
    expect(dailyNets(db, F)).toEqual(dailyNets(db, computed));
    expect(strategyEquityCurve(db, F).map((p) => p.equity)).toEqual([10_000, 10_000.26, 10_001.76, 10_001.01]);
    const report = performanceReport(db, F);
    expect(report.totalNet).toBeCloseTo(1.01, 10);
    expect(report.winRate).toBe(50);
    expect(report.expectancy).toBeCloseTo(0.375, 10);
    expect(closedTrades(db, F)).toHaveLength(2);
  });

  it("agree with the cost breakdown, which sums every deal", () => {
    const db = seeded();
    trades(db);
    expect(costDecomposition(db, F)!.total.net).toBeCloseTo(net(db).realizedNet!, 10);
    const account = accountSummary(db, { instanceId: I });
    expect(account.totalNet).toBe(1.01);
    expect(account.trades).toBe(2);
    expect(account.costs!.net).toBe(account.totalNet);
    expect(account.byStrategy.find((b) => b.key === "a")).toMatchObject({ net: 1.01, trades: 2 });
  });

  it("count once when several broker profiles report the same booking", () => {
    const db = seeded();
    trades(db);
    ingestEvents(db, I, [adjustment("9", "P1", T0 + DAY - 4 * H, 0.26, "b", "B")]);
    expect(net(db).realizedNet).toBe(1.01);
    expect(adjustmentRows(db, { instanceId: I })).toHaveLength(1);
  });

  it("move with their owner and leave with their deal", () => {
    const db = seeded();
    trades(db);
    ingestEvents(db, I, [leg("5", "P3", "IN", T0, 0, "b"), leg("6", "P3", "OUT", T0 + H, 2, "b")]);
    db.prepare("UPDATE deals SET strategy_id='b' WHERE entry='ADJUSTMENT'").run();
    expect(net(db).realizedNet).toBe(0.75);
    expect(net(db, "b").realizedNet).toBe(2.26);
    expect(dailyNets(db, F)).toEqual(dailyNets(db, computed));
    db.prepare("DELETE FROM deals WHERE entry='ADJUSTMENT'").run();
    expect(net(db, "b").realizedNet).toBe(2);
  });

  it("make a day of their own when nothing closed that day", () => {
    const db = seeded();
    ingestEvents(db, I, [
      leg("1", "P1", "IN", T0, 0, "a"), leg("2", "P1", "OUT", T0 + H, 1, "a"),
      leg("3", "P2", "IN", T0 + H, 0, "a"), adjustment("9", "P2", T0 + 3 * DAY, -0.4, "a"),
    ]);
    expect(dailyNets(db, F)).toEqual([{ day: "2026-10-26", net: 1, trades: 1 }, { day: "2026-10-29", net: -0.4, trades: 0 }]);
    expect(dailyNets(db, F)).toEqual(dailyNets(db, computed));
    // A cutoff between the close and the booking cannot be served from whole days: it stops before the booking.
    expect(dailyNets(db, { ...F, to: T0 + 2 * DAY })).toEqual([{ day: "2026-10-26", net: 1, trades: 1 }]);
  });

  it("anchor the equity curve when the first booking precedes the first close's entry", () => {
    const db = seeded();
    ingestEvents(db, I, [
      leg("1", "P1", "IN", T0, 0, "a"), adjustment("9", "P1", T0 + DAY, 0.26, "a"),
      leg("3", "P2", "IN", T0 + 2 * DAY, 0, "a"), leg("4", "P2", "OUT", T0 + 2 * DAY + H, 1, "a"),
    ]);
    expect(strategyEquityCurve(db, F)[0]).toMatchObject({ ts: T0 + DAY, equity: 10_000 });
    expect(strategyEquityCurve(db, F)).toEqual(strategyEquityCurve(db, { ...F, to: T0 + 10 * DAY }));
  });

  it("stay off a public view while their position is open", () => {
    const db = seeded();
    ingestEvents(db, I, [
      leg("1", "P1", "IN", T0, 0, "a"), leg("2", "P1", "OUT", T0 + H, 1, "a"),
      leg("3", "P2", "IN", T0 + H, 0, "a"), adjustment("9", "P2", T0 + DAY, 0.26, "a"),
    ]);
    const open = { ...F, to: T0 + 2 * DAY, closedPositionsOnly: true };
    expect(adjustmentRows(db, open)).toEqual([]);
    expect(dailyNets(db, open)).toEqual([{ day: "2026-10-26", net: 1, trades: 1 }]);
    ingestEvents(db, I, [leg("4", "P2", "OUT", T0 + DAY + H, 0.5, "a")]);
    expect(adjustmentRows(db, { ...open, to: T0 + 2 * DAY }).map((r) => r.realized)).toEqual([0.26]);
  });

  it("rebuild to the same figures from the deals", () => {
    const db = seeded();
    trades(db);
    const before = { days: dailyNets(db, F), totals: listStrategies(db, I) };
    rebuildProjection(db, "strategy_daily", { force: true });
    expect({ days: dailyNets(db, F), totals: listStrategies(db, I) }).toEqual(before);
  });
});
