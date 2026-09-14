import { describe, it, expect } from "vitest";
import { openDb, ingestEvents, listTrades, strategyStats, accountDrawdown, type Db } from "../src/index.js";
import type { Envelope } from "@qkt-insights/contract";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 4, 11);

function deal(ticket: string, position: string, entry: "IN" | "OUT", side: "BUY" | "SELL", ts: number, profit = 0): Envelope {
  return {
    v: 1, instanceId: "i1", id: `deal-${ticket}`, seq: 1, ts, type: "broker.deal",
    payload: { broker: "EXNESS", dealTicket: ticket, positionTicket: position, symbol: "EXNESS:XAUUSD", side, entry, qty: 0.01, price: 4300, profit, commission: 0, swap: 0, comment: "dsl-gold", strategyId: "gold", ts },
  } as Envelope;
}

function trade(id: string, ts: number): Envelope {
  return { v: 1, instanceId: "i1", id, seq: 1, ts, strategyId: "gold", type: "trade", payload: { orderId: id, symbol: "EXNESS:XAUUSD", side: "BUY", price: 4300, qty: 0.01, ts } } as Envelope;
}

function seeded(): Db {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO strategies (instance_id, strategy_id, first_seen, last_seen, starting_balance) VALUES ('i1','gold',?,?,10000)").run(T0, T0);
  ingestEvents(db, "i1", [
    trade("t1", T0), trade("t2", T0 + 3 * HOUR),
    deal("1", "100", "IN", "BUY", T0), deal("2", "100", "OUT", "SELL", T0 + HOUR, 25),
    deal("3", "101", "IN", "BUY", T0 + 2 * HOUR), deal("4", "101", "OUT", "SELL", T0 + 3 * HOUR, -40),
  ]);
  return db;
}

describe("time cutoff", () => {
  it("listTrades drops trades after `to`", () => {
    const rows = listTrades(seeded(), { instanceId: "i1", limit: 100, to: T0 + 2 * HOUR });
    expect(rows.map((r) => r.id)).toEqual(["t1"]);
  });

  it("strategyStats counts only closes up to `to`", () => {
    const db = seeded();
    const all = strategyStats(db, { instanceId: "i1", strategyId: "gold" }, T0 + 4 * HOUR);
    const cut = strategyStats(db, { instanceId: "i1", strategyId: "gold", to: T0 + 2 * HOUR }, T0 + 4 * HOUR);
    expect(all.tradeCount).toBe(2);
    expect(all.realizedPnl).toBe(-15);
    expect(cut.tradeCount).toBe(1);
    expect(cut.realizedPnl).toBe(25);
  });

  it("accountDrawdown ignores equity after `to`", () => {
    const db = openDb(":memory:");
    const ins = db.prepare("INSERT INTO account_equity (instance_id, broker, minute_ts, balance, equity, open_profit) VALUES ('i1','ICM',?,?,?,0)");
    [100, 120, 60].forEach((e, i) => ins.run(T0 + i * 60_000, e, e));
    const [cut] = accountDrawdown(db, { instanceId: "i1", to: T0 + 60_000 });
    expect(cut!.currentEquity).toBe(120);
    expect(cut!.maxDdPct).toBe(0);
    expect(cut!.points).toBe(2);
  });
});

describe("openPositionsAt", () => {
  const M = 60_000;
  const AT = T0 + 10 * HOUR;
  function mark(db: Db, ticket: string, ts: number, profit: number, strategyId = "gold") {
    db.prepare(
      "INSERT INTO position_valuations (instance_id, broker, ticket, ts, symbol, side, qty, entry_price, current_price, profit, swap, strategy_id) VALUES ('i1','EXNESS',?,?, 'EXNESS:XAUUSD','BUY',1,4300,4301,?,0,?)",
    ).run(ticket, ts, profit, strategyId);
  }

  it("values each position open at the moment by its last mark then, never a later one", async () => {
    const { openPositionsAt } = await import("../src/index.js");
    const db = seeded();
    mark(db, "p-open", AT - 3 * M, 10);
    mark(db, "p-open", AT - M, 12);
    mark(db, "p-open", AT + 5 * M, 50);
    mark(db, "p-later", AT + 2 * M, -3);
    mark(db, "p-stale", AT - 30 * M, 7);
    expect(openPositionsAt(db, { instanceId: "i1", at: AT })).toEqual([{ broker: "EXNESS", ticket: "p-open", strategyId: "gold", profit: 12, ts: AT - M }]);
  });

  it("keeps a flat position that was only re-marked on the heartbeat", async () => {
    const { openPositionsAt, VALUATION_HEARTBEAT_MS } = await import("../src/index.js");
    const db = seeded();
    mark(db, "p-flat", AT - VALUATION_HEARTBEAT_MS - 4 * M, 3);
    expect(openPositionsAt(db, { instanceId: "i1", at: AT }).map((p) => p.ticket)).toEqual(["p-flat"]);
  });

  it("drops a position whose closing deal came before the moment", async () => {
    const { openPositionsAt } = await import("../src/index.js");
    const db = seeded();
    mark(db, "101", T0 + 3 * HOUR - M, -35);
    expect(openPositionsAt(db, { instanceId: "i1", at: T0 + 3 * HOUR + M })).toEqual([]);
  });
});

describe("closedPositionsOnly", () => {
  it("keeps only positions whose volume was fully closed by the cutoff", async () => {
    const { closedTrades, fullyClosedPositions } = await import("../src/index.js");
    const db = openDb(":memory:");
    db.prepare("INSERT INTO strategies (instance_id, strategy_id, first_seen, last_seen, starting_balance) VALUES ('i1','gold',?,?,10000)").run(T0, T0);
    const leg = (ticket: string, position: string, entry: string, ts: number, qty: number, profit = 0) => ({
      v: 1, instanceId: "i1", id: `deal-${ticket}`, seq: 1, ts, type: "broker.deal",
      payload: { broker: "B", dealTicket: ticket, positionTicket: position, symbol: "XAUUSD", side: entry === "IN" ? "BUY" : "SELL", entry, qty, price: 4300, profit, strategyId: "gold", ts },
    }) as Envelope;
    ingestEvents(db, "i1", [
      leg("a1", "full", "IN", T0, 2), leg("a2", "full", "OUT", T0 + HOUR, 1, 5), leg("a3", "full", "OUT", T0 + 2 * HOUR, 1, 6),
      leg("b1", "partial", "IN", T0, 3), leg("b2", "partial", "OUT", T0 + HOUR, 1, 9),
      leg("c1", "reversal", "IN", T0, 1), leg("c2", "reversal", "INOUT", T0 + HOUR, 2, 4),
    ]);
    const to = T0 + 3 * HOUR;
    expect([...fullyClosedPositions(db, { instanceId: "i1", to })]).toEqual(["full"]);
    const all = closedTrades(db, { instanceId: "i1", strategyId: "gold", to });
    const strict = closedTrades(db, { instanceId: "i1", strategyId: "gold", to, closedPositionsOnly: true });
    expect(all.map((c) => c.orderId).sort()).toEqual(["full", "full", "partial", "reversal"]);
    expect(strict.map((c) => c.orderId)).toEqual(["full", "full"]);
    expect(() => closedTrades(db, { instanceId: "i1", strategyId: "gold", closedPositionsOnly: true })).toThrow("needs a `to` cutoff");
  });
});
