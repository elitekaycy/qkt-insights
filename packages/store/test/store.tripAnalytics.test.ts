import { describe, it, expect } from "vitest";
import type { Envelope } from "@qkt-insights/contract";
import { parseQuery } from "@qkt-insights/contract/query";
import { analyzeTrips, ingestEvents, listRoundTrips, openDb, postLoss, roundTripAnalytics, roundTripTotals, type TripRow } from "../src/index.js";

const MIN = 60_000, H = 3_600_000, D = 86_400_000;
const MON = Date.UTC(2026, 9, 12, 8); // Mon 2026-10-12 08:00 UTC

function trip(id: string, p: Partial<TripRow> & { pnl: number | null; entryTs: number; exitTs?: number | null }): TripRow {
  const exitTs = p.exitTs === undefined ? p.entryTs + H : p.exitTs;
  return {
    id, broker: "B", strategyId: "s", symbol: "B:XAUUSD", instrument: "XAUUSD", side: "long", status: exitTs == null ? "open" : "closed",
    entryPrice: 1, exitPrice: 1, qty: 1, holdMs: exitTs == null ? null : exitTs - p.entryTs, stopPrice: null, targetPrice: null,
    risk: null, r: null, ended: null, legs: 2, entryOrderId: null, priceDigits: 2, ...p, exitTs,
  };
}

describe("analyzeTrips: the journal aggregates over round trips", () => {
  const rows: TripRow[] = [
    trip("1", { pnl: 100, entryTs: MON, ended: "tp", r: 2 }),
    trip("2", { pnl: -50, entryTs: MON + D, side: "short", ended: "stop", r: -1 }),
    trip("3", { pnl: -30, entryTs: MON + D + 2 * H, exitTs: MON + D + 7 * H, ended: "stop" }),
    trip("4", { pnl: 0, entryTs: MON + 2 * D }),
    trip("5", { pnl: 80, entryTs: MON + 32 * D, exitTs: MON + 36 * D, ended: "signal" }),
    // open, with nothing closed yet: counted as open, never as a trade
    trip("6", { pnl: null, entryTs: MON + 40 * D, exitTs: null }),
  ];
  const a = analyzeTrips(rows, { total: 10, matched: rows.length });

  it("counts closed round trips; breakeven is neither a win nor a loss", () => {
    expect([a.total, a.matched, a.closed, a.open]).toEqual([10, 6, 5, 1]);
    expect([a.wins, a.losses, a.breakeven]).toEqual([2, 2, 1]);
    expect(a.pnl).toBe(100);
    expect(a.winRate).toBe(50);
  });

  it("derives profit factor, payoff and expectancy from the same trades", () => {
    expect(a.grossWin).toBe(180);
    expect(a.grossLoss).toBe(-80);
    expect(a.profitFactor).toBe(2.25);
    expect(a.avgWin).toBe(90);
    expect(a.avgLoss).toBe(-40);
    expect(a.payoff).toBe(2.25);
    expect(a.expectancy).toBe(20);
    expect(a.r).toEqual({ n: 2, avg: 0.5, total: 1 });
  });

  it("walks the running total for max drawdown, streaks and the per-trade series", () => {
    expect(a.trades.map((t) => t.cum)).toEqual([100, 50, 20, 20, 100]);
    expect(a.maxDd).toBe(80);
    expect(a.maxDdWindow).toEqual({ from: rows[0]!.exitTs, to: rows[2]!.exitTs });
    expect(a.streaks).toEqual({ current: 1, maxWin: 1, maxLoss: 2 });
    expect(a.best).toEqual({ id: "1", pnl: 100 });
    expect(a.worst).toEqual({ id: "2", pnl: -50 });
  });

  it("buckets by UTC exit day and month, and by UTC entry weekday and hour, each with its filter", () => {
    expect(a.daily.map((d) => [d.day, d.n, d.pnl])).toEqual([
      ["2026-10-12", 1, 100], ["2026-10-13", 2, -80], ["2026-10-14", 1, 0], ["2026-11-17", 1, 80],
    ]);
    expect(a.monthly.map((m) => [m.day, m.n, m.pnl, m.grossWin, m.grossLoss])).toEqual([["2026-10", 4, 20, 100, -80], ["2026-11", 1, 80, 80, 0]]);
    const mon = a.weekday[0]!;
    expect([mon.label, mon.filter, mon.n, mon.pnl]).toEqual(["Mon", "weekday:mon", 1, 100]);
    expect(a.weekday[1]!.n).toBe(2);
    expect(a.hour[8]!.filter).toBe("hour:8");
    expect(a.hour[8]!.n).toBe(4);
    expect(a.side.map((b) => [b.key, b.n, b.pnl])).toEqual([["long", 4, 150], ["short", 1, -50]]);
    expect(a.instrument.map((b) => [b.filter, b.n, b.pnl])).toEqual([["symbol:XAUUSD", 5, 100]]);
    expect(a.ended.map((b) => [b.filter, b.n])).toEqual([["ended:tp", 1], ["ended:stop", 2], ["ended:signal", 1]]);
  });

  it("puts hold times in half-open buckets that match the query language", () => {
    expect(a.hold.map((b) => [b.filter, b.n])).toEqual([["held:<1h", 0], ["held:1h..4h", 3], ["held:4h..24h", 1], ["held:1d..3d", 0], ["held:>=3d", 1]]);
  });

  it("is empty but well-formed without a closed trade", () => {
    const e = analyzeTrips([], { total: 0, matched: 0 });
    expect([e.winRate, e.profitFactor, e.expectancy, e.payoff, e.best]).toEqual([null, null, null, null, null]);
    expect(e.trades).toEqual([]);
    expect(e.weekday).toHaveLength(7);
    expect(e.hour).toHaveLength(24);
  });

  it("reads after-N-losses like the performance report", () => {
    expect(postLoss([-1, -1, 5, -1, 2])).toEqual([
      { n: 1, sample: 3, nextWinRate: (2 / 3) * 100, nextAvg: (-1 + 5 + 2) / 3 },
      { n: 2, sample: 1, nextWinRate: 100, nextAvg: 5 },
    ]);
  });
});

describe("weekday: and hour: filter round trips by their UTC entry", () => {
  let seq = 1;
  const env = (ts: number, payload: Record<string, unknown>): Envelope =>
    ({ v: 1, instanceId: "i", id: `deal-${payload.dealTicket as string}`, seq: seq++, ts, type: "broker.deal", strategyId: "s", payload }) as Envelope;
  const deal = (ticket: string, position: string, entry: "IN" | "OUT", ts: number, profit = 0) =>
    env(ts, { broker: "B", dealTicket: ticket, positionTicket: position, orderTicket: position, symbol: "B:XAUUSD", side: entry === "IN" ? "BUY" : "SELL",
      entry, qty: 1, price: 4000, profit, commission: 0, swap: 0, comment: "", ts, strategyId: "s" });
  const db = openDb(":memory:");
  ingestEvents(db, "i", [
    deal("1", "10", "IN", MON + 5 * MIN), deal("2", "10", "OUT", MON + H, 10), // Mon 08:05
    deal("3", "11", "IN", MON + D + 6 * H), deal("4", "11", "OUT", MON + D + 7 * H, -5), // Tue 14:00
    deal("5", "12", "IN", MON + 6 * D + 15 * H), deal("6", "12", "OUT", MON + 6 * D + 16 * H, 3), // Sun 23:00
  ]);
  const ids = (text: string) => listRoundTrips(db, { instanceId: "i", filter: parseQuery(text).filter }).rows.map((r) => r.id).sort();

  it("selects the weekday and hour buckets the analytics report", () => {
    expect(ids("weekday:mon")).toEqual(["10"]);
    expect(ids("weekday:sunday")).toEqual(["12"]);
    expect(ids("hour:14")).toEqual(["11"]);
    expect(ids("hour:>=14")).toEqual(["11", "12"]);
    const a = roundTripAnalytics(db, { instanceId: "i" });
    for (const b of [...a.weekday, ...a.hour].filter((x) => x.n > 0)) {
      const t = roundTripTotals(db, { instanceId: "i", filter: parseQuery(b.filter).filter });
      expect([b.filter, t.matched, t.net]).toEqual([b.filter, b.n, b.pnl]);
    }
  });

  it("matches the list's totals for any query", () => {
    for (const text of ["", "win", "weekday:tue", "pnl:<0"]) {
      const filter = parseQuery(text).filter;
      const a = roundTripAnalytics(db, { instanceId: "i", filter });
      const t = roundTripTotals(db, { instanceId: "i", filter });
      expect([a.matched, a.pnl, a.wins, a.losses, a.winRate]).toEqual([t.matched, t.net, t.wins, t.losses, t.winRate]);
    }
  });
});
