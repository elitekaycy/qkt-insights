import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { ingestEvents, strategyStats, startingBalanceOf } from "../src/index.js";
import type { Envelope } from "@qkt-insights/contract";

const T0 = 1718000000000;

function env(p: Partial<Envelope> & { type: Envelope["type"]; payload: any }): Envelope {
  return { v: 1, instanceId: "qkt-prod", id: Math.random().toString(36).slice(2), seq: 1, ts: T0, ...p } as Envelope;
}

const started = (sb: unknown) =>
  env({ type: "strategy.started", strategyId: "gold", ts: T0, payload: {
    strategyId: "gold", ts: T0, deployName: "s01", sourcePath: "/s/s01.qkt", sourceSha256: "x", dslVersion: 1,
    runtimeMode: "live", brokers: ["icmarkets"], symbols: ["ICMARKETS:XAUUSD"], streams: [], params: {}, defaults: {},
    risk: { startingBalance: sb, maxDailyLoss: 3000 },
  } });

describe("starting balance from strategy.started", () => {
  it("parses numeric and string balances and rejects the rest", () => {
    expect(startingBalanceOf({ risk: { startingBalance: 60000 } })).toBe(60000);
    expect(startingBalanceOf({ risk: { startingBalance: "60000" } })).toBe(60000);
    expect(startingBalanceOf({ risk: { startingBalance: 0 } })).toBeNull();
    expect(startingBalanceOf({ risk: {} })).toBeNull();
    expect(startingBalanceOf(null)).toBeNull();
  });

  it("anchors the strategy when no snapshot ever set it, and does not overwrite one that did", () => {
    const db = openDb(":memory:");
    ingestEvents(db, "qkt-prod", [started(60000)]);
    expect(db.prepare("SELECT starting_balance sb FROM strategies WHERE strategy_id='gold'").get()).toEqual({ sb: 60000 });
    // Stats only report the anchor once deals exist (no frozen figures without a ledger).
    const deal = (ticket: string, entry: "IN" | "OUT", ts: number, profit: number): Envelope => env({
      id: `deal-${ticket}`, ts, type: "broker.deal", strategyId: "gold", payload: {
        broker: "ICMARKETS", dealTicket: ticket, positionTicket: "P1", symbol: "ICMARKETS:XAUUSD", side: entry === "IN" ? "BUY" : "SELL",
        entry, qty: 0.1, price: 2300, profit, commission: 0, swap: 0, magic: 10002, comment: "", strategyId: "gold", ts,
      } });
    ingestEvents(db, "qkt-prod", [deal("d1", "IN", T0 + 1000, 0), deal("d2", "OUT", T0 + 2000, 25)]);
    const stats = strategyStats(db, { instanceId: "qkt-prod", strategyId: "gold" });
    expect(stats.startingBalance).toBe(60000);
    expect(stats.equity).toBe(60025);

    db.prepare("UPDATE strategies SET starting_balance=12345 WHERE strategy_id='gold'").run();
    ingestEvents(db, "qkt-prod", [started(99999)]);
    expect(db.prepare("SELECT starting_balance sb FROM strategies WHERE strategy_id='gold'").get()).toEqual({ sb: 12345 });
  });

  it("migration backfills existing rows from stored metadata", () => {
    const db = openDb(":memory:");
    db.prepare("DELETE FROM _migrations WHERE name='015_starting_balance_from_metadata.sql'").run();
    db.prepare("INSERT INTO strategies (instance_id, strategy_id, first_seen, last_seen, metadata) VALUES (?,?,?,?,?)")
      .run("qkt-prod", "old", T0, T0, JSON.stringify({ risk: { startingBalance: 60000 } }));
    runMigrations(db);
    expect(db.prepare("SELECT starting_balance sb FROM strategies WHERE strategy_id='old'").get()).toEqual({ sb: 60000 });
  });
});
