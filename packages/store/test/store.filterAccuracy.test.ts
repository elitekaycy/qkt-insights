import { describe, it, expect } from "vitest";
import type { Envelope } from "@qkt-insights/contract";
import { parseQuery } from "@qkt-insights/contract/query";
import { openDb, ingestEvents, listRoundTrips, roundTripTotals, roundTripAnalytics, accountSummary, type Db } from "../src/index.js";

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
