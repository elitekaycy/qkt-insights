import { describe, it, expect } from "vitest";
import type { Envelope } from "@qkt-insights/contract";
import { openDb, ingestEvents, accountSummary, listRoundTrips, roundTripAnalytics, roundTripDetail, refreshProjections, type Db } from "../src/index.js";
import { runMigrations } from "../src/migrations.js";

const I = "soak";
const T0 = Date.UTC(2026, 9, 12, 14);
const H = 3_600_000;
let seq = 1;

function deal(p: {
  broker: string; ticket: string; position: string; entry: "IN" | "OUT"; ts: number; symbol?: string; accountId?: string | null;
  profit?: number; strategyId?: string | null; qty?: number;
}): Envelope {
  return {
    v: 1, instanceId: I, id: `deal-${p.broker}-${p.ticket}-${seq}`, seq: seq++, ts: p.ts, type: "broker.deal",
    payload: {
      broker: p.broker, dealTicket: p.ticket, positionId: p.position, symbol: p.symbol ?? `${p.broker}:BTC_USDC_PERPETUAL`,
      side: p.entry === "IN" ? "BUY" : "SELL", legEntry: p.entry, qty: p.qty ?? 1, price: 100, profit: p.profit ?? 0, commission: 0, swap: 0,
      strategyId: p.strategyId === undefined ? "pair" : p.strategyId, attribution: p.strategyId === null ? "none" : "order",
      ...(p.accountId !== null ? { accountId: p.accountId ?? `vgp:${p.broker.toLowerCase().padEnd(16, "0").slice(0, 16)}` } : {}),
      ts: p.ts,
    },
  } as Envelope;
}

const canonical = (db: Db) =>
  (db.prepare("SELECT broker, deal_ticket t FROM deals WHERE canonical=1 ORDER BY broker, deal_ticket").all() as Array<{ broker: string; t: string }>)
    .map((r) => `${r.broker}/${r.t}`);

describe("a venue deal is one deal per account, never folded across venues", () => {
  it("keeps two accounts' deals that share a ticket (two gateway paper accounts both count paper-1, paper-2)", () => {
    const db = openDb(":memory:");
    ingestEvents(db, I, [
      deal({ broker: "PAPER_DERIBIT", ticket: "paper-1", position: "PAPER_DERIBIT:BTC_USDC_PERPETUAL#1", entry: "IN", ts: T0 }),
      deal({ broker: "PAPER_DERIBIT", ticket: "paper-2", position: "PAPER_DERIBIT:BTC_USDC_PERPETUAL#1", entry: "OUT", ts: T0 + H, profit: 30 }),
      deal({ broker: "PAPER_DERIBIT_B", ticket: "paper-1", position: "PAPER_DERIBIT_B:BTC_USDC_PERPETUAL#2", entry: "IN", ts: T0 }),
      deal({ broker: "PAPER_DERIBIT_B", ticket: "paper-2", position: "PAPER_DERIBIT_B:BTC_USDC_PERPETUAL#2", entry: "OUT", ts: T0 + H, profit: -12 }),
    ]);
    refreshProjections(db);
    expect(canonical(db)).toEqual(["PAPER_DERIBIT/paper-1", "PAPER_DERIBIT/paper-2", "PAPER_DERIBIT_B/paper-1", "PAPER_DERIBIT_B/paper-2"]);
    expect(accountSummary(db, { instanceId: I })).toMatchObject({ totalNet: 18, trades: 2 });
    expect(listRoundTrips(db, { instanceId: I }).rows.map((r) => r.pnl).sort()).toEqual([-12, 30]);
  });

  it("still keeps one copy of a deal every broker profile on one account sends, and of a copy that states no account", () => {
    const db = openDb(":memory:");
    const account = "mt5:00000000000000aa";
    ingestEvents(db, I, [
      deal({ broker: "EXNESS_S01", ticket: "9", position: "90", entry: "IN", ts: T0, accountId: account, symbol: "EXNESS_S01:XAUUSD" }),
      deal({ broker: "EXNESS_S02", ticket: "9", position: "90", entry: "IN", ts: T0, accountId: account, symbol: "EXNESS_S02:XAUUSD" }),
      deal({ broker: "EXNESS_S03", ticket: "9", position: "90", entry: "IN", ts: T0, accountId: null, symbol: "EXNESS_S03:XAUUSD" }),
    ]);
    refreshProjections(db);
    expect(canonical(db)).toEqual(["EXNESS_S01/9"]);
  });

  it("frees, on upgrade, a stored deal that was taken for another account's copy, and rebuilds its round trip", () => {
    const db = openDb(":memory:");
    ingestEvents(db, I, [
      deal({ broker: "PAPER_DERIBIT", ticket: "paper-1", position: "A#1", entry: "IN", ts: T0 }),
      deal({ broker: "PAPER_DERIBIT", ticket: "paper-2", position: "A#1", entry: "OUT", ts: T0 + H, profit: 30 }),
      deal({ broker: "PAPER_DERIBIT_B", ticket: "paper-1", position: "B#1", entry: "IN", ts: T0 }),
      deal({ broker: "PAPER_DERIBIT_B", ticket: "paper-2", position: "B#1", entry: "OUT", ts: T0 + H, profit: -12 }),
    ]);
    refreshProjections(db);
    // as the rule before this one stored them: B's deals were copies of A's, and B had no round trip
    db.prepare("UPDATE deals SET canonical=0 WHERE broker='PAPER_DERIBIT_B'").run();
    db.prepare("DELETE FROM round_trips WHERE position_ticket='B#1'").run();
    db.prepare("DELETE FROM closed_trades WHERE position_ticket='B#1'").run();
    expect(accountSummary(db, { instanceId: I }).totalNet).toBe(30);
    db.prepare("DELETE FROM _migrations WHERE name='043_deal_copies_per_account.sql'").run();
    runMigrations(db);
    expect(canonical(db)).toHaveLength(4);
    expect(accountSummary(db, { instanceId: I }).totalNet).toBe(18);
    expect(listRoundTrips(db, { instanceId: I }).rows).toHaveLength(2);
  });

  it("never gives a deal the strategy of another account's deal with the same ticket", () => {
    const db = openDb(":memory:");
    ingestEvents(db, I, [
      deal({ broker: "PAPER_DERIBIT", ticket: "paper-1", position: "A#1", entry: "IN", ts: T0, strategyId: "pair" }),
      deal({ broker: "PAPER_DERIBIT_B", ticket: "paper-1", position: "B#1", entry: "IN", ts: T0, strategyId: null }),
    ]);
    const owner = db.prepare("SELECT strategy_id s FROM deals WHERE broker='PAPER_DERIBIT_B'").get() as { s: string | null };
    expect(owner.s).toBeNull();
  });
});

describe("the same instrument on two venues is two instruments", () => {
  function seedAapl(db: Db): void {
    ingestEvents(db, I, [
      deal({ broker: "EXNESS_S01", ticket: "1", position: "501", entry: "IN", ts: T0, symbol: "EXNESS_S01:AAPL", accountId: "mt5:00000000000000aa", qty: 0.1 }),
      deal({ broker: "EXNESS_S01", ticket: "2", position: "501", entry: "OUT", ts: T0 + H, symbol: "EXNESS_S01:AAPL", accountId: "mt5:00000000000000aa", profit: 4, qty: 0.1 }),
      deal({ broker: "ALPACA", ticket: "f-1", position: "ALPACA:AAPL#1", entry: "IN", ts: T0, symbol: "ALPACA:AAPL", accountId: "vgp:00000000000000bb", qty: 10 }),
      deal({ broker: "ALPACA", ticket: "f-2", position: "ALPACA:AAPL#1", entry: "OUT", ts: T0 + H, symbol: "ALPACA:AAPL", accountId: "vgp:00000000000000bb", profit: -2.5, qty: 10 }),
      deal({ broker: "ALPACA", ticket: "f-3", position: "ALPACA:IBIT#1", entry: "IN", ts: T0, symbol: "ALPACA:IBIT", accountId: "vgp:00000000000000bb", qty: 3 }),
    ]);
  }

  it("names the venue of a round trip whose instrument the instance trades on more than one account", () => {
    const db = openDb(":memory:");
    seedAapl(db);
    const rows = listRoundTrips(db, { instanceId: I, sort: "ticket", dir: "asc" }).rows.map((r) => ({ id: r.id, instrument: r.instrument, venue: r.venue }));
    expect(rows).toEqual([
      { id: "501", instrument: "AAPL", venue: "EXNESS" },
      { id: "ALPACA:AAPL#1", instrument: "AAPL", venue: "ALPACA" },
      { id: "ALPACA:IBIT#1", instrument: "IBIT", venue: null },
    ]);
    expect(roundTripDetail(db, I, "ALPACA:AAPL#1")!.trip.venue).toBe("ALPACA");
  });

  it("buckets the instrument once per venue in the journal aggregates", () => {
    const db = openDb(":memory:");
    seedAapl(db);
    const a = roundTripAnalytics(db, { instanceId: I });
    expect(a.instrument.map((b) => ({ key: b.key, label: b.label, n: b.n, pnl: b.pnl }))).toEqual([
      { key: "ALPACA:AAPL", label: "ALPACA:AAPL", n: 1, pnl: -2.5 },
      { key: "EXNESS:AAPL", label: "EXNESS:AAPL", n: 1, pnl: 4 },
    ]);
  });

  it("keeps a single-venue instance's instrument as it is, however many broker profiles trade it", () => {
    const db = openDb(":memory:");
    const account = "mt5:00000000000000aa";
    ingestEvents(db, I, [
      deal({ broker: "EXNESS_S01", ticket: "1", position: "1", entry: "IN", ts: T0, symbol: "EXNESS_S01:XAUUSD", accountId: account }),
      deal({ broker: "EXNESS_S02", ticket: "2", position: "2", entry: "IN", ts: T0, symbol: "EXNESS_S02:XAUUSD", accountId: account }),
    ]);
    expect(listRoundTrips(db, { instanceId: I }).rows.map((r) => r.venue)).toEqual([null, null]);
  });
});
