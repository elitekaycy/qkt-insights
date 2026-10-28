import { describe, it, expect } from "vitest";
import {
  openDb, ingestEvents, ignoredDeals, reconcile, reconciliation, replaceIgnoredMagics, withoutIgnoredHoldings, accountSummary, type Db,
} from "../src/index.js";
import type { Envelope } from "@qkt-insights/contract";

const I = "forward";
const M = 60_000;
const ACCOUNT = "mt5:0123456789abcdef";
const OCT = (day: number, hour = 0, minute = 0, second = 0) => Date.UTC(2026, 9, day, hour, minute, second);

function deal(p: { ticket: string; position: string; entry: "IN" | "OUT"; magic: number; ts: number; profit?: number; commission?: number; broker?: string; instanceId?: string }): Envelope {
  const broker = p.broker ?? "EXNESS_P174";
  return {
    v: 1, instanceId: p.instanceId ?? I, id: `deal-${broker}-${p.ticket}`, seq: 1, ts: p.ts, type: "broker.deal",
    payload: {
      broker, dealTicket: p.ticket, positionTicket: p.position, symbol: "EXNESS:XAUUSD",
      side: p.entry === "IN" ? "BUY" : "SELL", entry: p.entry, qty: 0.01, price: 4000,
      profit: p.profit ?? 0, commission: p.commission ?? 0, swap: 0, magic: p.magic, strategyId: null, attribution: "none",
      accountId: ACCOUNT, ts: p.ts,
    },
  } as Envelope;
}

const storedDeals = (db: Db) => (db.prepare("SELECT deal_ticket t FROM deals ORDER BY deal_ticket").all() as Array<{ t: string }>).map((r) => r.t);

describe("deals ignored by magic range", () => {
  it("keeps a deal whose magic is in an ignored range out of every deal row, and counts it once however many profiles copy it", () => {
    const db = openDb(":memory:");
    replaceIgnoredMagics(db, { [I]: [{ lo: 31000, hi: 31199 }] });
    ingestEvents(db, I, [
      deal({ ticket: "1", position: "100", entry: "IN", magic: 31005, ts: OCT(2, 9) }),
      deal({ ticket: "2", position: "100", entry: "OUT", magic: 31005, ts: OCT(2, 10), profit: 12.5, commission: -0.3 }),
      deal({ ticket: "2", position: "100", entry: "OUT", magic: 31005, ts: OCT(2, 10), profit: 12.5, commission: -0.3, broker: "EXNESS_P175" }),
      deal({ ticket: "3", position: "101", entry: "IN", magic: 174, ts: OCT(2, 11) }),
    ]);
    expect(storedDeals(db)).toEqual(["3"]);
    expect(ignoredDeals(db, I)).toEqual({ ranges: ["31000-31199"], deals: 2, net: 12.2 });
    // the ignored position is not an unattributed round trip either
    const s = accountSummary(db, { instanceId: I });
    expect(s.byStrategy).toEqual([]);
    expect(s.totalNet).toBe(0);
  });

  it("applies a range to its own instance only, and leaves a magic outside every range alone", () => {
    const db = openDb(":memory:");
    replaceIgnoredMagics(db, { [I]: [{ lo: 31000, hi: 31199 }] });
    ingestEvents(db, "soak", [deal({ ticket: "1", position: "100", entry: "IN", magic: 31005, ts: OCT(2, 9), instanceId: "soak" })]);
    ingestEvents(db, I, [deal({ ticket: "2", position: "101", entry: "IN", magic: 31200, ts: OCT(2, 9) })]);
    expect(storedDeals(db)).toEqual(["1", "2"]);
    expect(ignoredDeals(db, I)).toEqual({ ranges: ["31000-31199"], deals: 0, net: 0 });
    expect(ignoredDeals(db, "soak")).toEqual({ ranges: [], deals: 0, net: 0 });
  });

  it("leaves a deal stored before its range was configured where it is, and never counts it twice", () => {
    const db = openDb(":memory:");
    ingestEvents(db, I, [deal({ ticket: "1", position: "100", entry: "IN", magic: 31005, ts: OCT(2, 9) })]);
    replaceIgnoredMagics(db, { [I]: [{ lo: 31000, hi: 31199 }] });
    // the restart backfill sends it again
    ingestEvents(db, I, [deal({ ticket: "1", position: "100", entry: "IN", magic: 31005, ts: OCT(2, 9), broker: "EXNESS_P175" })]);
    expect(storedDeals(db)).toEqual(["1"]);
    expect(ignoredDeals(db, I).deals).toBe(0);
  });

  it("still counts ignored deals in the account's balance continuity: they moved its balance", () => {
    const db = openDb(":memory:");
    replaceIgnoredMagics(db, { [I]: [{ lo: 31000, hi: 31199 }] });
    ingestEvents(db, I, [
      deal({ ticket: "1", position: "100", entry: "IN", magic: 174, ts: OCT(2, 9) }),
      deal({ ticket: "2", position: "100", entry: "OUT", magic: 174, ts: OCT(2, 10, 0, 30), profit: 40 }),
      deal({ ticket: "3", position: "200", entry: "IN", magic: 31005, ts: OCT(2, 12) }),
      deal({ ticket: "4", position: "200", entry: "OUT", magic: 31005, ts: OCT(2, 13, 0, 30), profit: -15.25, commission: -0.5 }),
    ]);
    const ins = db.prepare("INSERT INTO account_equity (instance_id, broker, minute_ts, balance, equity, open_profit, account) VALUES (?,?,?,?,?,?,?)");
    for (let ts = OCT(1, 6); ts <= OCT(3, 12); ts += 10 * M) {
      const balance = 10_000 + (ts >= OCT(2, 10, 0, 30) ? 40 : 0) + (ts >= OCT(2, 13, 0, 30) ? -15.75 : 0);
      ins.run(I, "EXNESS_P174", ts, balance, balance, 0, ACCOUNT);
    }
    reconcile(db, I, { now: OCT(3, 2) });
    const r = reconciliation(db, I);
    expect(r.accounts[0]).toMatchObject({ daysOk: 1, daysDiff: 0 });
    expect(r.ignored).toEqual({ ranges: ["31000-31199"], deals: 2, net: -15.75 });
  });

  it("drops the venue's positions and pending orders with an ignored magic from the live state envelopes", () => {
    const db = openDb(":memory:");
    replaceIgnoredMagics(db, { [I]: [{ lo: 31000, hi: 31199 }, { lo: 40000, hi: 40000 }] });
    const positions = {
      v: 1, instanceId: I, id: "p", seq: 1, ts: OCT(2), type: "state.positions",
      payload: { broker: "EXNESS_P174", positions: [
        { ticket: "1", symbol: "XAUUSD", side: "BUY", qty: 0.01, entryPrice: 4000, magic: 174 },
        { ticket: "2", symbol: "XAUUSD", side: "BUY", qty: 0.01, entryPrice: 4000, magic: 31100 },
        { ticket: "3", symbol: "XAUUSD", side: "SELL", qty: 0.01, entryPrice: 4000 },
        { ticket: "4", symbol: "XAUUSD", side: "SELL", qty: 0.01, entryPrice: 4000, magic: 40000 },
      ] },
    } as Envelope;
    const orders = {
      v: 1, instanceId: I, id: "o", seq: 1, ts: OCT(2), type: "state.orders",
      payload: { broker: "EXNESS_P174", orders: [
        { ticket: "5", symbol: "XAUUSD", side: "BUY", qty: 0.01, magic: 31000 },
        { ticket: "6", symbol: "XAUUSD", side: "BUY", qty: 0.01, magic: 175 },
      ] },
    } as Envelope;
    const p = withoutIgnoredHoldings(db, I, positions);
    const o = withoutIgnoredHoldings(db, I, orders);
    expect((p.payload as { positions: Array<{ ticket: string }> }).positions.map((x) => x.ticket)).toEqual(["1", "3"]);
    expect((o.payload as { orders: Array<{ ticket: string }> }).orders.map((x) => x.ticket)).toEqual(["6"]);
    // nothing to drop, or no range for the instance: the envelope itself
    expect(withoutIgnoredHoldings(db, "soak", positions)).toBe(positions);
    replaceIgnoredMagics(db, {});
    expect(withoutIgnoredHoldings(db, I, positions)).toBe(positions);
    expect(ignoredDeals(db, I).ranges).toEqual([]);
  });
});
