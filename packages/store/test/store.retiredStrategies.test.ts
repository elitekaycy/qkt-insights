import { describe, it, expect } from "vitest";
import { openDb, ingestEvents, attributeRetiredStrategies, strategyFromOrderComment, refreshProjections, type Db } from "../src/index.js";
import type { Envelope } from "@qkt-insights/contract";

const T0 = 1718000000000;
const I = "qkt-prod";

function deal(p: {
  ticket: string; position: string; entry: "IN" | "OUT"; comment?: string | null; strategyId?: string | null;
  attribution?: string | null; ts?: number; profit?: number;
}): Envelope {
  return {
    v: 1, instanceId: I, id: `deal-EXNESS-${p.ticket}`, seq: 1, ts: p.ts ?? T0, type: "broker.deal",
    payload: {
      broker: "EXNESS", dealTicket: p.ticket, positionTicket: p.position, symbol: "EXNESS:XAUUSD",
      side: p.entry === "IN" ? "BUY" : "SELL", entry: p.entry, qty: 0.01, price: 4300, profit: p.profit ?? 0,
      commission: 0, swap: 0, strategyId: p.strategyId ?? null, ts: p.ts ?? T0,
      ...(p.comment != null ? { comment: p.comment } : {}),
      ...(p.attribution !== null ? { attribution: p.attribution ?? "none" } : {}),
    },
  } as Envelope;
}

const owner = (db: Db, ticket: string) => ((db.prepare("SELECT strategy_id s FROM deals WHERE deal_ticket=?").get(ticket) as any) ?? { s: null }).s;
const strategies = (db: Db) => (db.prepare("SELECT strategy_id s FROM strategies WHERE instance_id=? ORDER BY 1").all(I) as { s: string }[]).map((r) => r.s);
const seed = (db: Db, id: string) => db.prepare("INSERT INTO strategies (instance_id, strategy_id, first_seen, last_seen) VALUES (?,?,?,?)").run(I, id, T0, T0);

describe("strategyFromOrderComment", () => {
  it("reads the name up to the sequence separator, even when the venue cut the sequence", () => {
    expect(strategyFromOrderComment("dsl-gold_ema_pullback--863")).toBe("gold_ema_pullback");
    expect(strategyFromOrderComment("dsl-gold_ema_pullback--86")).toBe("gold_ema_pullback");
    expect(strategyFromOrderComment("dsl-eurusd_rsi_fade--")).toBe("eurusd_rsi_fade");
  });

  it("names nothing from a comment cut inside the name, or one qkt did not write", () => {
    for (const c of ["dsl-gold_silver_ratio_acc", "dsl---4", "dsl-", "[tp 4332.689]", "ORD-7", "", null]) {
      expect(strategyFromOrderComment(c)).toBeNull();
    }
  });
});

describe("retired strategies at ingest", () => {
  it("gives a deal qkt could not attribute to the retired strategy its comment names, and its close too", () => {
    const db = openDb(":memory:");
    seed(db, "live_book");
    ingestEvents(db, I, [
      deal({ ticket: "1", position: "100", entry: "IN", comment: "dsl-gold_ema_pullback--86" }),
      deal({ ticket: "2", position: "100", entry: "OUT", comment: "[tp 4332.689]", ts: T0 + 60_000, profit: 12.5 }),
    ]);
    expect(owner(db, "1")).toBe("gold_ema_pullback");
    expect(owner(db, "2")).toBe("gold_ema_pullback");
    expect(strategies(db)).toEqual(["gold_ema_pullback", "live_book"]);
  });

  it("adopts a close stored before its opening deal arrived", () => {
    const db = openDb(":memory:");
    seed(db, "live_book");
    ingestEvents(db, I, [deal({ ticket: "4", position: "101", entry: "OUT", comment: "[sl 4315.7]", ts: T0 + 1 })]);
    expect(owner(db, "4")).toBeNull();
    ingestEvents(db, I, [deal({ ticket: "3", position: "101", entry: "IN", comment: "dsl-eurusd_rsi_fade--12" })]);
    expect(owner(db, "3")).toBe("eurusd_rsi_fade");
    expect(owner(db, "4")).toBe("eurusd_rsi_fade");
  });

  it("keeps a cut name, and qkt's own attribution, as they are", () => {
    const db = openDb(":memory:");
    seed(db, "live_book");
    ingestEvents(db, I, [
      deal({ ticket: "5", position: "102", entry: "IN", comment: "dsl-gold_silver_ratio_acc" }),
      deal({ ticket: "6", position: "103", entry: "IN", comment: "dsl-other_name--1", strategyId: "live_book", attribution: "order" }),
    ]);
    expect(owner(db, "5")).toBeNull();
    expect(owner(db, "6")).toBe("live_book");
  });

  it("still drops a strategy qkt names that is not this instance's", () => {
    const db = openDb(":memory:");
    seed(db, "live_book");
    ingestEvents(db, I, [deal({ ticket: "7", position: "104", entry: "IN", comment: "dsl-foreign--1", strategyId: "foreign", attribution: "order" })]);
    expect(owner(db, "7")).toBeNull();
    expect((db.prepare("SELECT COUNT(*) c FROM deals").get() as any).c).toBe(0);
  });
});

describe("041_retired_strategy_attribution", () => {
  const raw = (db: Db, ticket: string, position: string, entry: string, comment: string | null, ts: number, profit = 0) =>
    db.prepare(
      "INSERT INTO deals (id, instance_id, broker, deal_ticket, position_ticket, entry, side, symbol, qty, price, profit, commission, swap, comment, strategy_id, ts, canonical) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)",
    ).run(`deal-EXNESS-${ticket}`, I, "EXNESS", ticket, position, entry, entry === "IN" ? "BUY" : "SELL", "EXNESS:XAUUSD", 0.01, 4300, profit, 0, 0, comment, null, ts);

  it("attributes stored history once, registers the retired strategy, and leaves the unknowable alone", () => {
    const db = openDb(":memory:");
    raw(db, "10", "200", "IN", "dsl-gold_rsi_fade--3", T0);
    raw(db, "11", "200", "OUT", "[tp 4400.1]", T0 + 3_600_000, 40);
    raw(db, "12", "201", "IN", "dsl-gold_silver_ratio_acc", T0);
    raw(db, "13", "201", "OUT", "[sl 4200.0]", T0 + 1, -20);
    expect(attributeRetiredStrategies(db)).toBe(2);
    expect([owner(db, "10"), owner(db, "11"), owner(db, "12"), owner(db, "13")]).toEqual(["gold_rsi_fade", "gold_rsi_fade", null, null]);
    expect(strategies(db)).toEqual(["gold_rsi_fade"]);
    const row = db.prepare("SELECT first_seen f, last_seen l FROM strategies WHERE strategy_id='gold_rsi_fade'").get() as { f: number; l: number };
    expect(row).toEqual({ f: T0, l: T0 + 3_600_000 });
    expect(attributeRetiredStrategies(db)).toBe(0);
    refreshProjections(db);
    const trips = db.prepare("SELECT position_ticket p, strategy_id s, realized r FROM round_trips WHERE instance_id=? ORDER BY 1").all(I);
    expect(trips).toEqual([{ p: "200", s: "gold_rsi_fade", r: 40 }, { p: "201", s: null, r: -20 }]);
  });
});
