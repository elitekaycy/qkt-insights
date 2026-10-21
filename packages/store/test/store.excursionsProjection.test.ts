import { describe, it, expect } from "vitest";
import {
  openDb, ingestEvents, persistStateEvent, excursionStats, dealClosedTrades, pruneRetention, rebuildProjection,
  refreshProjections, type Db,
} from "../src/index.js";
import type { Envelope } from "@qkt-insights/contract";

const M = 60_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 2, 2);
const I = "i1";
const S = "alpha";
const F = { instanceId: I, strategyId: S };

let seq = 0;
function deal(ticket: string, entry: "IN" | "OUT", ts: number, qty: number, profit = 0, position = "P1"): Envelope {
  return {
    v: 1, instanceId: I, id: `deal-${ticket}`, seq: seq++, ts, type: "broker.deal",
    payload: { broker: "B", dealTicket: ticket, positionTicket: position, symbol: "B:XAUUSD", side: entry === "IN" ? "BUY" : "SELL", entry, qty, price: 4000, profit, strategyId: S, ts },
  } as Envelope;
}

function mark(db: Db, ts: number, profit: number | undefined, opts: { ticket?: string; strategyId?: string | null; qty?: number; broker?: string } = {}): void {
  persistStateEvent(db, I, {
    v: 1, instanceId: I, id: `m-${seq}`, seq: seq++, ts, type: "state.positions",
    payload: { broker: opts.broker ?? "B", positions: [{ ticket: opts.ticket ?? "P1", symbol: "B:XAUUSD", side: "BUY", qty: opts.qty ?? 2, entryPrice: 4000, profit, strategyId: opts.strategyId === undefined ? S : opts.strategyId }] },
  } as Envelope);
}

/** The excursion of each close as the marks give it directly: min, max and count inside its held window. */
function reference(db: Db): Array<{ ticket: string; ts: number; mae: number; mfe: number; observations: number }> {
  return dealClosedTrades(db, F).flatMap((t) => {
    if (!t.orderId || t.entryTs == null) return [];
    const m = db.prepare(
      `SELECT MIN(profit) lo, MAX(profit) hi, COUNT(profit) n FROM position_valuations
       WHERE instance_id=? AND ticket=? AND ts>=? AND ts<=? AND (strategy_id=? OR strategy_id IS NULL)`,
    ).get(I, t.orderId, t.entryTs, t.ts, S) as { lo: number | null; hi: number | null; n: number };
    return m.n === 0 ? [] : [{ ticket: t.orderId, ts: t.ts, mae: Math.min(m.lo ?? 0, 0), mfe: Math.max(m.hi ?? 0, 0), observations: m.n }];
  });
}

function served(db: Db) {
  return (excursionStats(db, F)?.rows ?? []).map(({ ticket, ts, mae, mfe, observations }) => ({ ticket, ts, mae, mfe, observations }));
}

function seeded(): Db {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO strategies (instance_id, strategy_id, first_seen, last_seen) VALUES (?,?,?,?)").run(I, S, T0, T0);
  return db;
}

describe("position_excursions projection", () => {
  it("measures each partial close over its own window, with marks before and after the close lands", () => {
    const db = seeded();
    ingestEvents(db, I, [deal("1", "IN", T0, 2)]);
    mark(db, T0 + M, -4);
    mark(db, T0 + 2 * M, 7);
    ingestEvents(db, I, [deal("2", "OUT", T0 + 10 * M, 1, 3)]);
    // A poll stamped inside the first close's window arrives after the close: it still counts.
    mark(db, T0 + 5 * M, -9);
    mark(db, T0 + 12 * M, 11, { qty: 1 });
    mark(db, T0 + 14 * M, undefined, { qty: 1 });
    ingestEvents(db, I, [deal("3", "OUT", T0 + 20 * M, 1, 5)]);
    mark(db, T0 + 25 * M, 99, { qty: 1 });
    expect(served(db)).toEqual(reference(db));
    expect(served(db)).toEqual([
      { ticket: "P1", ts: T0 + 10 * M, mae: -9, mfe: 7, observations: 3 },
      { ticket: "P1", ts: T0 + 20 * M, mae: -9, mfe: 11, observations: 4 },
    ]);
  });

  it("counts unattributed marks and leaves out another strategy's", () => {
    const db = seeded();
    ingestEvents(db, I, [deal("1", "IN", T0, 1), deal("2", "OUT", T0 + 10 * M, 1, 1)]);
    mark(db, T0 + M, -2, { strategyId: null, broker: "C" });
    // Ingest attributes a mark through its position's deals; a row stored for another strategy is skipped.
    db.prepare(
      `INSERT INTO position_valuations (instance_id, broker, ticket, ts, symbol, side, qty, entry_price, profit, strategy_id)
       VALUES (?, 'D', 'P1', ?, 'B:XAUUSD', 'BUY', 1, 4000, 50, 'other')`,
    ).run(I, T0 + 2 * M);
    expect(served(db)).toEqual(reference(db));
    expect(served(db)[0]).toMatchObject({ mae: -2, mfe: 0, observations: 1 });
  });

  it("follows a retention prune of the marks of a closed position", () => {
    const db = seeded();
    ingestEvents(db, I, [deal("1", "IN", T0, 1), deal("2", "OUT", T0 + 2 * DAY, 1, 1)]);
    mark(db, T0 + M, -3);
    mark(db, T0 + DAY + M, 8);
    persistStateEvent(db, I, { v: 1, instanceId: I, id: "flat", seq: seq++, ts: T0 + 2 * DAY + M, type: "state.positions", payload: { broker: "B", positions: [] } } as Envelope);
    expect(served(db)[0]).toMatchObject({ mae: -3, mfe: 8, observations: 2 });
    pruneRetention(db, T0 + 31 * DAY);
    expect(served(db)).toEqual(reference(db));
    expect(served(db)[0]).toMatchObject({ mae: 0, mfe: 8, observations: 1 });
  });

  it("rebuilds to the rows the marks maintained", () => {
    const db = seeded();
    for (let p = 0; p < 12; p++) {
      const t = T0 + p * 60 * M;
      ingestEvents(db, I, [deal(`${p}i`, "IN", t, 2, 0, `P${p}`)]);
      for (let k = 1; k < 6; k++) mark(db, t + k * M, ((p * 7 + k * 13) % 17) - 8, { ticket: `P${p}` });
      ingestEvents(db, I, [deal(`${p}a`, "OUT", t + 3 * M, 1, 1, `P${p}`), deal(`${p}b`, "OUT", t + 7 * M, 1, 1, `P${p}`)]);
    }
    refreshProjections(db);
    const rows = () => db.prepare("SELECT * FROM position_excursions ORDER BY deal_rowid").all();
    const maintained = rows();
    expect(maintained).toHaveLength(24);
    rebuildProjection(db, "position_excursions", { force: true, batch: 5 });
    expect(rows()).toEqual(maintained);
  });
});
