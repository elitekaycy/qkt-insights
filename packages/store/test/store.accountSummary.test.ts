import { describe, it, expect } from "vitest";
import { openDb, ingestEvents, accountSummary, accountCloses, closedTrades, type Db } from "../src/index.js";
import type { Envelope } from "@qkt-insights/contract";

const I = "qkt-prod";
const T0 = Date.UTC(2026, 4, 4, 10);
const HOUR = 3_600_000;
const DAY = 86_400_000;

function seedStrategy(db: Db, id: string, lastSeen = T0): void {
  db.prepare("INSERT INTO strategies (instance_id, strategy_id, first_seen, last_seen, starting_balance) VALUES (?,?,?,?,?)")
    .run(I, id, T0, lastSeen, 10_000);
}

let n = 0;
function deal(db: Db, p: {
  position: string; entry: "IN" | "OUT"; strategy: string | null; ts: number; profit?: number;
  commission?: number; swap?: number; symbol?: string; broker?: string; ticket?: string;
}): void {
  const ticket = p.ticket ?? String(++n);
  db.prepare(
    `INSERT INTO deals (id, instance_id, broker, deal_ticket, position_ticket, symbol, side, entry, qty, price, profit, commission, swap, strategy_id, ts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(`${p.broker ?? "EX"}-${ticket}`, I, p.broker ?? "EX", ticket, p.position, p.symbol ?? "EX:XAUUSD", p.entry === "IN" ? "BUY" : "SELL",
    p.entry, 0.1, 2000, p.profit ?? 0, p.commission ?? 0, p.swap ?? 0, p.strategy, p.ts);
}

function roundTrip(db: Db, position: string, strategy: string | null, ts: number, profit: number, symbol = "EX:XAUUSD"): void {
  deal(db, { position, entry: "IN", strategy, ts, commission: -1, symbol });
  deal(db, { position, entry: "OUT", strategy, ts: ts + HOUR, profit, commission: -1, swap: -0.5, symbol });
}

describe("accountSummary", () => {
  it("totals every close on the account: retired strategies, unattributed deals, profile copies counted once", () => {
    const db = openDb(":memory:");
    seedStrategy(db, "live");
    seedStrategy(db, "retired", T0 - 40 * DAY);
    roundTrip(db, "p1", "live", T0, 100, "EX_S01:XAUUSD");
    roundTrip(db, "p2", "retired", T0 - 40 * DAY, -60, "EX_S02:XAUUSD");
    roundTrip(db, "p3", null, T0 + DAY, -30, "EX:EURUSD");
    // A second broker profile's copy of the same closing deal: one venue deal, counted once.
    deal(db, { position: "p1", entry: "OUT", strategy: "live", ts: T0 + HOUR, profit: 100, commission: -1, swap: -0.5, ticket: "2", broker: "EX_S05", symbol: "EX_S05:XAUUSD" });

    const s = accountSummary(db, { instanceId: I });
    // each round trip: profit - 2 commission - 0.5 swap
    expect(s.trades).toBe(3);
    expect(s.totalNet).toBeCloseTo(97.5 - 62.5 - 32.5, 9);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(2);
    expect(s.costs).toEqual({ grossProfit: 10, commission: -6, swap: -1.5, fee: 0, net: 2.5 });
    expect(s.costs!.net).toBeCloseTo(s.totalNet, 9);
    expect(s.byStrategy.map((b) => [b.key, b.trades, b.net])).toEqual([["live", 1, 97.5], [null, 1, -32.5], ["retired", 1, -62.5]]);
    expect(s.byInstrument.map((b) => [b.key, b.trades])).toEqual([["XAUUSD", 2], ["EURUSD", 1]]);
    expect(s.byInstrument[0]!.venues!.sort()).toEqual(["EX_S01:XAUUSD", "EX_S02:XAUUSD"]);
    expect(s.dailyNets.map((d) => d.day)).toEqual(["2026-03-25", "2026-05-04", "2026-05-05"]);
    // The account total is the strategies' totals plus the unattributed bucket.
    const strategies = ["live", "retired"].map((id) => closedTrades(db, { instanceId: I, strategyId: id }).reduce((a, c) => a + c.realized, 0));
    expect(strategies[0]! + strategies[1]! - 32.5).toBeCloseTo(s.totalNet, 9);
  });

  it("keeps an unattributed close that reaches ingest instead of dropping it", () => {
    const db = openDb(":memory:");
    seedStrategy(db, "live");
    const env = (ticket: string, entry: string, profit: number, ts: number): Envelope => ({
      v: 1, instanceId: I, id: `deal-${ticket}`, seq: Number(ticket), ts, type: "broker.deal",
      payload: { broker: "EX", dealTicket: ticket, positionTicket: "900", symbol: "EX:XAUUSD", side: entry === "IN" ? "BUY" : "SELL",
        entry, qty: 0.1, price: 2000, profit, commission: 0, swap: 0, magic: 4242, strategyId: null, ts },
    } as Envelope);
    ingestEvents(db, I, [env("71", "IN", 0, T0), env("72", "OUT", -49.5, T0 + HOUR)]);
    const s = accountSummary(db, { instanceId: I });
    expect(s.totalNet).toBeCloseTo(-49.5, 9);
    expect(s.byStrategy).toEqual([{ key: null, net: -49.5, trades: 1, wins: 0, losses: 1 }]);
  });

  it("uses trade.closed rows for strategies without broker deals, and a strategy filter drops unattributed", () => {
    const db = openDb(":memory:");
    seedStrategy(db, "live");
    seedStrategy(db, "paper");
    roundTrip(db, "p1", "live", T0, 40);
    roundTrip(db, "p9", null, T0, -10);
    const close = db.prepare("INSERT INTO trade_closes (id, instance_id, strategy_id, symbol, side, qty, price, realized, ts, order_id) VALUES (?,?,?,?,?,?,?,?,?,?)");
    close.run("c1", I, "paper", "PAPER:EURUSD", "BUY", 1, 1.1, 12, T0 + 2 * HOUR, "o1");
    // the deal-backed strategy's own engine closes are not counted twice
    close.run("c2", I, "live", "EX:XAUUSD", "BUY", 0.1, 2000, 40, T0 + HOUR, "o2");
    const all = accountSummary(db, { instanceId: I });
    expect(all.trades).toBe(3);
    expect(all.totalNet).toBeCloseTo(37.5 - 12.5 + 12, 9);
    const scoped = accountCloses(db, { instanceId: I, strategyIds: new Set(["live", "paper"]) });
    expect(scoped.map((c) => c.strategyId)).toEqual(["live", "paper"]);
  });
});
