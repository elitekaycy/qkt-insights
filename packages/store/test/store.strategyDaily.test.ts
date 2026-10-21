import { describe, it, expect } from "vitest";
import { openDb, ingestEvents, dailyNets, rollingStats, rebuildProjection, refreshProjections, listStrategies, closedTrades, type Db } from "../src/index.js";
import type { Envelope } from "@qkt-insights/contract";

const H = 3_600_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 5);
const I = "i1";

let seq = 0;
function deal(ticket: string, position: string, entry: "IN" | "OUT", ts: number, profit: number, strategyId: string | null, commission = -0.37): Envelope {
  return {
    v: 1, instanceId: I, id: `deal-${ticket}`, seq: seq++, ts, type: "broker.deal",
    payload: {
      broker: "B", dealTicket: ticket, positionTicket: position, symbol: "B:XAUUSD", side: entry === "IN" ? "BUY" : "SELL",
      entry, qty: 0.1, price: 4000, profit, commission, comment: "x", ...(strategyId ? { strategyId } : {}), ts,
    },
  } as Envelope;
}

function closed(ts: number, realized: number, strategyId: string): Envelope {
  return {
    v: 1, instanceId: I, id: `tc-${seq}`, seq: seq++, ts, type: "trade.closed", strategyId,
    payload: { symbol: "XAUUSD", side: "BUY", qty: 1, price: 4000, realized, entryTs: ts - H, ts, orderId: `o-${seq}` },
  } as Envelope;
}

/** A deterministic sequence of awkward cents: their float sums depend on the order they are added in. */
function pnl(k: number): number {
  return Math.round(Math.sin(k * 12.9898) * 43758.5453 % 1 * 50000) / 100;
}

function seeded(): Db {
  const db = openDb(":memory:");
  for (const s of ["a", "b"]) db.prepare("INSERT INTO strategies (instance_id, strategy_id, first_seen, last_seen, starting_balance) VALUES (?,?,?,?,?)").run(I, s, T0, T0, 10_000);
  return db;
}

const F = { instanceId: I, strategyId: "a" };
/** The same figures computed from the closes: a `from` before every close bypasses the projection. */
const fromCloses = { ...F, from: 0 };

describe("strategy_daily projection", () => {
  it("serves daily nets and rolling stats identical to the closes, through appends and out-of-order history", () => {
    const db = seeded();
    const legs: Envelope[] = [];
    for (let p = 0; p < 120; p++) {
      const ts = T0 + Math.floor(p / 3) * DAY + (p % 3) * 5 * H;
      legs.push(deal(`${p}i`, `P${p}`, "IN", ts, 0, "a"), deal(`${p}o`, `P${p}`, "OUT", ts + H, pnl(p), "a"));
    }
    // Newest positions first, then the oldest ones, in small batches: every day is rewritten out of order.
    const order = [...legs.slice(160), ...legs.slice(0, 160).reverse()];
    for (let i = 0; i < order.length; i += 7) {
      ingestEvents(db, I, order.slice(i, i + 7));
      expect(dailyNets(db, F)).toEqual(dailyNets(db, fromCloses));
    }
    expect(dailyNets(db, F)).toHaveLength(40);
    expect(rollingStats(db, F, 7)).toEqual(rollingStats(db, fromCloses, 7));
    expect(rollingStats(db, F, 30)).toEqual(rollingStats(db, fromCloses, 30));
  });

  it("moves a close's day between strategies when its owner changes", () => {
    const db = seeded();
    ingestEvents(db, I, [deal("1", "P1", "IN", T0, 0, "a"), deal("2", "P1", "OUT", T0 + H, 12.34, "a"), deal("3", "P2", "OUT", T0 + DAY, 5, null)]);
    expect(dailyNets(db, F).map((d) => d.day)).toEqual(["2026-01-05"]);
    db.prepare("UPDATE deals SET strategy_id='b' WHERE position_ticket='P1'").run();
    db.prepare("UPDATE deals SET strategy_id='a' WHERE position_ticket='P2'").run();
    expect(dailyNets(db, F)).toEqual([{ day: "2026-01-06", net: 4.63, trades: 1 }]);
    expect(dailyNets(db, { instanceId: I, strategyId: "b" })).toEqual([{ day: "2026-01-05", net: 12.34 - 0.37 - 0.37, trades: 1 }]);
    db.prepare("DELETE FROM deals WHERE position_ticket='P2'").run();
    expect(dailyNets(db, F)).toEqual([]);
  });

  it("follows the engine's trade.closed rows for a strategy without deals", () => {
    const db = seeded();
    const rows = Array.from({ length: 30 }, (_, k) => closed(T0 + k * 7 * H, pnl(k + 500), "a"));
    ingestEvents(db, I, rows.slice(10));
    ingestEvents(db, I, rows.slice(0, 10));
    expect(dailyNets(db, F)).toEqual(dailyNets(db, fromCloses));
    expect(dailyNets(db, F).reduce((n, d) => n + d.trades, 0)).toBe(30);
    // The first broker deal makes the deals the source.
    ingestEvents(db, I, [deal("1", "P1", "IN", T0, 0, "a"), deal("2", "P1", "OUT", T0 + H, 1, "a")]);
    expect(dailyNets(db, F)).toEqual([{ day: "2026-01-05", net: 1 - 0.37 - 0.37, trades: 1 }]);
  });

  it("answers a cutoff before the newest close from the closes", () => {
    const db = seeded();
    ingestEvents(db, I, [deal("1", "P1", "IN", T0, 0, "a"), deal("2", "P1", "OUT", T0 + H, 1, "a"), deal("3", "P2", "IN", T0 + DAY, 0, "a"), deal("4", "P2", "OUT", T0 + DAY + H, 2, "a")]);
    expect(dailyNets(db, { ...F, to: T0 + DAY })).toHaveLength(1);
    expect(dailyNets(db, { ...F, to: T0 + 2 * DAY })).toHaveLength(2);
  });

  it("rebuilds to the rows ingest maintained", () => {
    const db = seeded();
    for (let p = 0; p < 40; p++) ingestEvents(db, I, [deal(`${p}i`, `P${p}`, "IN", T0 + p * 9 * H, 0, p % 2 ? "a" : "b"), deal(`${p}o`, `P${p}`, "OUT", T0 + p * 9 * H + H, pnl(p), p % 2 ? "a" : "b")]);
    ingestEvents(db, I, Array.from({ length: 12 }, (_, k) => closed(T0 + k * 5 * H, pnl(k + 90), "c")));
    refreshProjections(db);
    const rows = () => [db.prepare("SELECT * FROM strategy_daily ORDER BY 1,2,3,4").all(), db.prepare("SELECT * FROM strategy_totals ORDER BY 1,2,3").all()];
    const maintained = rows();
    rebuildProjection(db, "closed_trades", { force: true });
    rebuildProjection(db, "strategy_daily", { force: true, batch: 1 });
    expect(rows()).toEqual(maintained);
  });

  it("lists each strategy's realized total and close count exactly as its closed trades add up", () => {
    const db = seeded();
    for (let p = 0; p < 50; p++) ingestEvents(db, I, [deal(`${p}i`, `P${p}`, "IN", T0 + p * 3 * H, 0, "a"), deal(`${p}o`, `P${p}`, "OUT", T0 + p * 3 * H + H, pnl(p + 7), "a")]);
    ingestEvents(db, I, Array.from({ length: 25 }, (_, k) => closed(T0 + k * 2 * H, pnl(k + 300), "b")));
    ingestEvents(db, I, [deal("late-i", "PL", "IN", T0 - DAY, 0, "a"), deal("late-o", "PL", "OUT", T0 - DAY + H, 0.07, "a")]);
    const listed = new Map(listStrategies(db, I, T0).map((s) => [s.strategyId, s]));
    for (const id of ["a", "b"]) {
      const closes = closedTrades(db, { instanceId: I, strategyId: id });
      expect(listed.get(id)).toMatchObject({ realizedNet: closes.reduce((n, c) => n + c.realized, 0), dealCount: closes.length });
    }
    db.prepare("INSERT INTO strategies (instance_id, strategy_id, first_seen, last_seen) VALUES (?,?,?,?)").run(I, "idle", T0, T0);
    expect(listStrategies(db, I, T0).find((s) => s.strategyId === "idle")).toMatchObject({ realizedNet: null, dealCount: 0 });
  });
});
