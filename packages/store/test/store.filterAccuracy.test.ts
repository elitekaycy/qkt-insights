import { describe, it, expect } from "vitest";
import type { Envelope } from "@qkt-insights/contract";
import { parseQuery } from "@qkt-insights/contract/query";
import {
  openDb, ingestEvents, listRoundTrips, roundTripTotals, roundTripAnalytics, accountSummary, persistStateEvent, instanceMoneyDigits, sumMoney, type Db,
} from "../src/index.js";

/*
 * Regression tests from an independent accuracy audit of the filters and drill-downs: every figure
 * a filter or a drill shows must equal the money the venue's deals add up to, as the page prints
 * it (to the cent). Synthetic fixtures only.
 */

const I = "qkt-audit";
const MIN = 60_000, H = 3_600_000, D = 86_400_000;
const T0 = Date.UTC(2026, 9, 12, 8); // Mon 2026-10-12 08:00 UTC
let seq = 1;

function env(type: string, ts: number, payload: Record<string, unknown>, strategyId?: string, id?: string): Envelope {
  return { v: 1, instanceId: I, id: id ?? `e${seq}`, seq: seq++, ts, type, strategyId, payload } as Envelope;
}

function deal(p: {
  ticket: string; position: string; entry: "IN" | "OUT"; side: "BUY" | "SELL"; ts: number; price: number; qty?: number;
  profit?: number; commission?: number; swap?: number; comment?: string;
}): Envelope {
  return env("broker.deal", p.ts, {
    broker: "ICMARKETS", dealTicket: p.ticket, positionTicket: p.position, orderTicket: p.position, symbol: "ICMARKETS:XAUUSD", side: p.side,
    entry: p.entry, qty: p.qty ?? 0.5, price: p.price, profit: p.profit ?? 0, commission: p.commission ?? 0, swap: p.swap ?? 0,
    comment: p.comment ?? "", ts: p.ts, strategyId: "gold",
  }, "gold", `deal-${p.ticket}`);
}

const q = (text = "") => ({ instanceId: I, filter: parseQuery(text).filter });
const ids = (db: Db, text: string) => listRoundTrips(db, q(text)).rows.map((r) => r.id).sort();

/**
 * - 300: closed at -250.20 profit and -0.10 swap: the venue's net is -250.30, which the page prints;
 *   the legs' float sum is -250.29999999999998
 * - 301: closed at +0.30 profit, -0.10 commission, -0.20 swap: exactly breakeven at the venue,
 *   a float sum of -2.8e-17
 * - 302: a plain -100.00 loss, the control
 */
function centsFixture(): Db {
  seq = 1;
  const db = openDb(":memory:");
  ingestEvents(db, I, [
    deal({ ticket: "1", position: "300", entry: "IN", side: "BUY", ts: T0, price: 4000 }),
    deal({ ticket: "2", position: "300", entry: "OUT", side: "SELL", ts: T0 + 30 * MIN, price: 3995, profit: -250.2, swap: -0.1 }),
    deal({ ticket: "3", position: "301", entry: "IN", side: "BUY", ts: T0 + H, price: 4000 }),
    deal({ ticket: "4", position: "301", entry: "OUT", side: "SELL", ts: T0 + 2 * H, price: 4000, profit: 0.3, commission: -0.1, swap: -0.2 }),
    deal({ ticket: "5", position: "302", entry: "IN", side: "BUY", ts: T0 + 3 * H, price: 4000 }),
    deal({ ticket: "6", position: "302", entry: "OUT", side: "SELL", ts: T0 + 4 * H, price: 3998, profit: -100 }),
  ]);
  return db;
}

describe("pnl: and outcome filters read the venue's cents, not the float sum of the legs", () => {
  it("pnl:=<amount> finds the trade whose P&L prints as that amount", () => {
    const db = centsFixture();
    expect(ids(db, "pnl:=-250.30")).toEqual(["300"]);
    expect(roundTripTotals(db, q("pnl:=-250.30")).matched).toBe(1);
  });

  it("inclusive and exclusive bounds put a trade exactly at the bound on the documented side", () => {
    const db = centsFixture();
    // at least -250.30 includes the -250.30 trade; under -250.30 excludes it
    expect(ids(db, "pnl:>=-250.30")).toEqual(["300", "301", "302"]);
    expect(ids(db, "pnl:<-250.30")).toEqual([]);
    expect(ids(db, "pnl:<=-250.30")).toEqual(["300"]);
    expect(ids(db, "pnl:>-250.30")).toEqual(["301", "302"]);
    expect(ids(db, "pnl:-250.30..-100")).toEqual(["300", "302"]);
  });

  it("a trade that nets to 0.00 at the venue is breakeven, neither a win nor a loss", () => {
    const db = centsFixture();
    expect(ids(db, "breakeven")).toEqual(["301"]);
    expect(ids(db, "loss")).toEqual(["300", "302"]);
    expect(ids(db, "win")).toEqual([]);
    const t = roundTripTotals(db, q());
    expect({ wins: t.wins, losses: t.losses }).toEqual({ wins: 0, losses: 2 });
    const a = roundTripAnalytics(db, q());
    expect({ wins: a.wins, losses: a.losses, breakeven: a.breakeven }).toEqual({ wins: 0, losses: 2, breakeven: 1 });
  });
});

describe("a calendar day's cell and its drill (`exit:<day>`) show the same trades and money", () => {
  /**
   * - 400: long 1.0 opened Tue 10:00, half closed Tue 20:00 (+100.00), the rest Wed 02:00 (+50.00)
   * - 401: long 0.5 opened and closed on Wed (-30.00)
   */
  function partialFixture(): Db {
    seq = 1;
    const db = openDb(":memory:");
    const tue = Date.UTC(2026, 9, 13);
    ingestEvents(db, I, [
      deal({ ticket: "1", position: "400", entry: "IN", side: "BUY", ts: tue + 10 * H, price: 4000, qty: 1 }),
      deal({ ticket: "2", position: "400", entry: "OUT", side: "SELL", ts: tue + 20 * H, price: 4002, qty: 0.5, profit: 100 }),
      deal({ ticket: "3", position: "400", entry: "OUT", side: "SELL", ts: tue + D + 2 * H, price: 4001, qty: 0.5, profit: 50 }),
      deal({ ticket: "4", position: "401", entry: "IN", side: "BUY", ts: tue + D + 5 * H, price: 4000 }),
      deal({ ticket: "5", position: "401", entry: "OUT", side: "SELL", ts: tue + D + 6 * H, price: 3999.4, profit: -30 }),
    ]);
    return db;
  }

  it("every day's cell equals the round trips its click lists (count and net)", () => {
    const db = partialFixture();
    const cells = accountSummary(db, { instanceId: I }).dailyNets;
    expect(cells.reduce((a, d) => a + d.net, 0)).toBeCloseTo(120, 9);
    for (const cell of cells) {
      const drill = roundTripTotals(db, q(`exit:${cell.day}`));
      expect({ day: cell.day, trades: drill.matched, net: Math.round(drill.net * 100) / 100 })
        .toEqual({ day: cell.day, trades: cell.trades, net: Math.round(cell.net * 100) / 100 });
    }
  });
});

describe("a position closed in parts across two UTC days", () => {
  const tue = Date.UTC(2026, 9, 13), wed = tue + D;
  /** 400 as above; 401 opened and closed Wed (-30); 402 closed in two legs on Wed (+5, +5). */
  function fixture(): Db {
    seq = 1;
    const db = openDb(":memory:");
    ingestEvents(db, I, [
      deal({ ticket: "1", position: "400", entry: "IN", side: "BUY", ts: tue + 10 * H, price: 4000, qty: 1 }),
      deal({ ticket: "2", position: "400", entry: "OUT", side: "SELL", ts: tue + 20 * H, price: 4002, qty: 0.5, profit: 100 }),
      deal({ ticket: "3", position: "400", entry: "OUT", side: "SELL", ts: wed + 2 * H, price: 4001, qty: 0.5, profit: 50 }),
      deal({ ticket: "4", position: "401", entry: "IN", side: "BUY", ts: wed + 5 * H, price: 4000 }),
      deal({ ticket: "5", position: "401", entry: "OUT", side: "SELL", ts: wed + 6 * H, price: 3999.4, profit: -30 }),
      deal({ ticket: "6", position: "402", entry: "IN", side: "BUY", ts: wed + 7 * H, price: 4000, qty: 1 }),
      deal({ ticket: "7", position: "402", entry: "OUT", side: "SELL", ts: wed + 8 * H, price: 4000.1, qty: 0.5, profit: 5 }),
      deal({ ticket: "8", position: "402", entry: "OUT", side: "SELL", ts: wed + 9 * H, price: 4000.1, qty: 0.5, profit: 5 }),
    ]);
    return db;
  }

  it("exit:<day> lists every round trip with a closing leg that day, and nets only that day's legs", () => {
    const db = fixture();
    expect(ids(db, "exit:2026-10-13")).toEqual(["400"]);
    expect(ids(db, "exit:2026-10-14")).toEqual(["400", "401", "402"]);
    expect(ids(db, "exit:<2026-10-14")).toEqual(["400"]);
    expect(ids(db, "exit:2026-10-13..2026-10-14")).toEqual(["400", "401", "402"]);
    expect(roundTripTotals(db, q("exit:2026-10-13"))).toMatchObject({ matched: 1, net: 100, netInExit: true });
    expect(roundTripTotals(db, q("exit:2026-10-14"))).toMatchObject({ matched: 3, net: 30, netInExit: true });
    // without a window the net is every leg
    expect(roundTripTotals(db, q())).toMatchObject({ matched: 3, net: 130, netInExit: false });
  });

  it("marks the rows whose other legs closed outside the window with what they closed inside it", () => {
    const db = fixture();
    const rows = (text: string) => Object.fromEntries(listRoundTrips(db, q(text)).rows.map((r) => [r.id, { pnl: r.pnl, inExit: r.pnlInExit }]));
    expect(rows("exit:2026-10-13")).toEqual({ "400": { pnl: 150, inExit: 100 } });
    expect(rows("exit:2026-10-14")).toEqual({ "400": { pnl: 150, inExit: 50 }, "401": { pnl: -30, inExit: null }, "402": { pnl: 10, inExit: null } });
    expect(rows("exit:2026-10")).toEqual({ "400": { pnl: 150, inExit: null }, "401": { pnl: -30, inExit: null }, "402": { pnl: 10, inExit: null } });
    expect(rows("")["400"]).toEqual({ pnl: 150, inExit: null });
  });

  it("counts a calendar day's round trips, not its legs, and the strategy journal's days agree with the drill", () => {
    const db = fixture();
    expect(accountSummary(db, { instanceId: I }).dailyNets).toEqual([
      { day: "2026-10-13", net: 100, trades: 1 },
      { day: "2026-10-14", net: 30, trades: 3 },
    ]);
    const a = roundTripAnalytics(db, q());
    expect(a.daily).toEqual([
      { day: "2026-10-13", n: 1, wins: 1, losses: 0, pnl: 100 },
      { day: "2026-10-14", n: 3, wins: 2, losses: 1, pnl: 30 },
    ]);
    expect(a.monthly).toEqual([{ day: "2026-10", n: 3, wins: 2, losses: 1, pnl: 130, grossWin: 160, grossLoss: -30 }]);
    for (const d of a.daily) {
      const drill = roundTripAnalytics(db, q(`exit:${d.day}`));
      expect({ n: drill.matched, pnl: drill.pnl, daily: drill.daily }).toEqual({ n: d.n, pnl: d.pnl, daily: [d] });
    }
  });
});

describe("money at the account currency's minor unit", () => {
  it("splits an entry's cost over partial closes so the closes add up to the round trip to the cent", () => {
    seq = 1;
    const db = openDb(":memory:");
    // -0.07 entry commission over three equal closes: shares of -0.02333... each
    ingestEvents(db, I, [
      deal({ ticket: "1", position: "500", entry: "IN", side: "BUY", ts: T0, price: 4000, qty: 0.3, commission: -0.07 }),
      deal({ ticket: "2", position: "500", entry: "OUT", side: "SELL", ts: T0 + H, price: 4001, qty: 0.1, profit: 10.01 }),
      deal({ ticket: "3", position: "500", entry: "OUT", side: "SELL", ts: T0 + 2 * H, price: 4001, qty: 0.1, profit: 10.01 }),
      deal({ ticket: "4", position: "500", entry: "OUT", side: "SELL", ts: T0 + 3 * H, price: 4001, qty: 0.1, profit: 10.01 }),
    ]);
    const legs = accountSummary(db, { instanceId: I }).closes.map((c) => c.realized);
    expect(legs.every((v) => Math.round(v * 100) / 100 === v)).toBe(true);
    expect(sumMoney(legs, 2)).toBe(29.96);
    expect(listRoundTrips(db, q()).rows[0]!.pnl).toBe(29.96);
    expect(accountSummary(db, { instanceId: I }).totalNet).toBe(29.96);
  });

  it("totals are the exact sum of the rows they count", () => {
    const db = centsFixture();
    const rows = listRoundTrips(db, q()).rows;
    const t = roundTripTotals(db, q());
    expect(t.net).toBe(sumMoney(rows.map((r) => r.pnl ?? 0), 2));
    expect(t.net).toBe(-350.3);
    const s = accountSummary(db, { instanceId: I });
    expect(s.totalNet).toBe(-350.3);
    expect(s.dailyNets).toEqual([{ day: "2026-10-12", net: -350.3, trades: 3 }]);
    expect({ wins: s.wins, losses: s.losses, breakeven: s.breakeven }).toEqual({ wins: 0, losses: 2, breakeven: 1 });
    expect(roundTripAnalytics(db, q()).pnl).toBe(-350.3);
  });

  it("takes the minor unit from the account currency the broker reports, and restores it when that changes", () => {
    seq = 1;
    const db = openDb(":memory:");
    ingestEvents(db, I, [
      deal({ ticket: "1", position: "600", entry: "IN", side: "BUY", ts: T0, price: 4000 }),
      deal({ ticket: "2", position: "600", entry: "OUT", side: "SELL", ts: T0 + H, price: 4001, profit: 12.3456 }),
    ]);
    expect(listRoundTrips(db, q()).rows[0]!.pnl).toBe(12.35);
    const account = (currency: string) => env("state.account", T0 + 2 * H, { broker: "ICMARKETS", currency, balance: 1000, equity: 1000 });
    persistStateEvent(db, I, account("KWD"));
    expect(instanceMoneyDigits(db, I)).toBe(3);
    expect(listRoundTrips(db, q()).rows[0]!.pnl).toBe(12.346);
    expect(accountSummary(db, { instanceId: I }).totalNet).toBe(12.346);
    persistStateEvent(db, I, account("JPY"));
    expect(listRoundTrips(db, q()).rows[0]!.pnl).toBe(12);
    persistStateEvent(db, I, account("USD"));
    expect(listRoundTrips(db, q()).rows[0]!.pnl).toBe(12.35);
  });
});
