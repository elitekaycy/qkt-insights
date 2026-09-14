import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { openDb, ingestEvents, type Db } from "../src/index.js";
import type { Envelope } from "@qkt-insights/contract";

const T0 = 1718000000000;

function dealEnv(p: {
  ticket: string; positionTicket?: string | null; entry?: string; side?: string;
  comment?: string | null; strategyId?: string | null; ts?: number; profit?: number;
  magic?: number | null; broker?: string;
}): Envelope {
  return {
    v: 1, instanceId: "qkt-prod", id: `deal-${p.broker ?? "EXNESS"}-${p.ticket}`, seq: 1, ts: p.ts ?? T0,
    type: "broker.deal",
    payload: {
      broker: p.broker ?? "EXNESS", dealTicket: p.ticket,
      ...(p.magic != null ? { magic: p.magic } : {}),
      ...(p.positionTicket != null ? { positionTicket: p.positionTicket } : {}),
      symbol: "EXNESS:XAUUSD", side: p.side ?? "BUY", entry: p.entry ?? "IN",
      qty: 0.01, price: 4300, profit: p.profit ?? 0, commission: -0.07, swap: 0,
      ...(p.comment != null ? { comment: p.comment } : {}),
      ...(p.strategyId !== undefined ? { strategyId: p.strategyId } : { strategyId: null }),
      ts: p.ts ?? T0,
    },
  } as Envelope;
}

function seedStrategy(db: Db, id: string): void {
  db.prepare(
    "INSERT INTO strategies (instance_id, strategy_id, first_seen, last_seen, starting_balance) VALUES (?,?,?,?,?)",
  ).run("qkt-prod", id, T0, T0, 10000);
}

function strategyOf(db: Db, ticket: string): string | null {
  return ((db.prepare("SELECT strategy_id s FROM deals WHERE deal_ticket=?").get(ticket) as any) ?? { s: null }).s;
}

function dealCount(db: Db): number {
  return (db.prepare("SELECT COUNT(*) c FROM deals").get() as any).c;
}

describe("broker.deal strategy resolution at ingest", () => {
  it("resolves a null-strategy OUT through its position's attributed IN", () => {
    const db = openDb(":memory:");
    ingestEvents(db, "qkt-prod", [
      dealEnv({ ticket: "1", positionTicket: "100", entry: "IN", strategyId: "hedge_straddle", comment: "dsl-hedge_straddle" }),
      dealEnv({ ticket: "2", positionTicket: "100", entry: "OUT", side: "SELL", strategyId: null, comment: "[tp 4332.689]", ts: T0 + 1000 }),
    ]);
    expect(strategyOf(db, "2")).toBe("hedge_straddle");
  });

  it("resolves a dsl- comment by unique prefix match, tolerant of truncation both ways", () => {
    const db = openDb(":memory:");
    seedStrategy(db, "hedge_straddle");
    seedStrategy(db, "latch_stack");
    ingestEvents(db, "qkt-prod", [
      // MT5 truncated the comment: stripped tag is a prefix of the strategy id.
      dealEnv({ ticket: "3", positionTicket: "101", strategyId: null, comment: "dsl-hedge_str" }),
      // Strategy id shorter than the tag: the id is a prefix of the stripped tag.
      dealEnv({ ticket: "4", positionTicket: "102", strategyId: null, comment: "dsl-latch_stack_v2_extras", ts: T0 + 1000 }),
    ]);
    expect(strategyOf(db, "3")).toBe("hedge_straddle");
    expect(strategyOf(db, "4")).toBe("latch_stack");
  });

  it("leaves unknown, empty, and ambiguous comments unattributed", () => {
    const db = openDb(":memory:");
    seedStrategy(db, "alpha_one");
    seedStrategy(db, "alpha_two");
    ingestEvents(db, "qkt-prod", [
      dealEnv({ ticket: "5", positionTicket: "103", strategyId: null, comment: "ORD-5" }),
      dealEnv({ ticket: "6", positionTicket: "104", strategyId: null, comment: "dsl-" }),
      dealEnv({ ticket: "7", positionTicket: "105", strategyId: null, comment: "dsl-alpha" }),
      dealEnv({ ticket: "8", positionTicket: "106", strategyId: null }),
    ]);
    for (const t of ["5", "6", "7", "8"]) expect(strategyOf(db, t)).toBeNull();
  });

  it("prefers the position sibling over the comment", () => {
    const db = openDb(":memory:");
    seedStrategy(db, "hedge_straddle");
    seedStrategy(db, "latch_stack");
    ingestEvents(db, "qkt-prod", [
      dealEnv({ ticket: "9", positionTicket: "107", entry: "IN", strategyId: "hedge_straddle" }),
      dealEnv({ ticket: "10", positionTicket: "107", entry: "OUT", strategyId: null, comment: "dsl-latch_stack", ts: T0 + 1000 }),
    ]);
    expect(strategyOf(db, "10")).toBe("hedge_straddle");
  });

  it("backfills earlier null rows of the position when an attributed deal arrives", () => {
    const db = openDb(":memory:");
    ingestEvents(db, "qkt-prod", [
      dealEnv({ ticket: "11", positionTicket: "200", entry: "OUT", strategyId: null, comment: "[sl 4315.737]" }),
    ]);
    expect(strategyOf(db, "11")).toBeNull();
    ingestEvents(db, "qkt-prod", [
      dealEnv({ ticket: "12", positionTicket: "200", entry: "IN", strategyId: "hedge_straddle", ts: T0 + 1000 }),
    ]);
    expect(strategyOf(db, "11")).toBe("hedge_straddle");
    expect(strategyOf(db, "12")).toBe("hedge_straddle");
  });

  it("drops unattributed account-wide backfill after the instance has a local strategy", () => {
    const db = openDb(":memory:");
    seedStrategy(db, "hedge_straddle");
    ingestEvents(db, "qkt-prod", [
      dealEnv({ ticket: "13", positionTicket: "201", strategyId: null, comment: "dsl-unrelated_strategy" }),
      dealEnv({ ticket: "14", positionTicket: "202", strategyId: null, comment: "" }),
    ]);
    expect(dealCount(db)).toBe(0);
  });

  it("keeps this instance's unattributed close by magic and adopts its owner from the opening deal (#1143)", () => {
    const db = openDb(":memory:");
    seedStrategy(db, "gold_ema_pullback");
    ingestEvents(db, "qkt-prod", [
      // The opening deal was attributed when it happened.
      dealEnv({ ticket: "30", positionTicket: "300", entry: "IN", strategyId: "gold_ema_pullback", comment: "dsl-gold_ema_pullback--3", magic: 20001, ts: T0 }),
    ]);
    ingestEvents(db, "qkt-prod", [
      // After a restart qkt no longer knows the owner, and the venue rewrote the comment.
      dealEnv({ ticket: "31", positionTicket: "300", entry: "OUT", strategyId: null, comment: "[sl 4354.64]", magic: 20001, ts: T0 + 60_000, profit: -12.5 }),
    ]);
    expect(dealCount(db)).toBe(2);
    expect(strategyOf(db, "31")).toBe("gold_ema_pullback");
  });

  it("keeps an unattributed deal with this instance's magic even before its position resolves", () => {
    const db = openDb(":memory:");
    seedStrategy(db, "gold_ema_pullback");
    ingestEvents(db, "qkt-prod", [
      dealEnv({ ticket: "40", positionTicket: "400", entry: "IN", strategyId: "gold_ema_pullback", magic: 20001, ts: T0 }),
      // A manual close of a position whose opening deal predates the backfill window.
      dealEnv({ ticket: "41", positionTicket: "401", entry: "OUT", strategyId: null, comment: null, magic: 20001, ts: T0 + 1 }),
      // Another tool on the same account: different magic, dropped.
      dealEnv({ ticket: "42", positionTicket: "402", entry: "OUT", strategyId: null, comment: null, magic: 777, ts: T0 + 2 }),
    ]);
    expect(dealCount(db)).toBe(2);
    expect(strategyOf(db, "41")).toBeNull();
    // Its opening deal arrives later (a wider backfill): the close adopts the owner.
    ingestEvents(db, "qkt-prod", [
      dealEnv({ ticket: "43", positionTicket: "401", entry: "IN", strategyId: "gold_ema_pullback", magic: 20001, ts: T0 - 1_000 }),
    ]);
    expect(strategyOf(db, "41")).toBe("gold_ema_pullback");
  });

  it("every copy of a deal sent by several broker profiles ends up with the owner", () => {
    const db = openDb(":memory:");
    seedStrategy(db, "fx3_GBPUSD_2");
    ingestEvents(db, "qkt-prod", [
      dealEnv({ ticket: "50", positionTicket: "500", entry: "IN", strategyId: "fx3_GBPUSD_2", magic: 20107, broker: "EXNESS_P549", ts: T0 }),
    ]);
    // The same closing deal reported by two sessions: one knows the owner, one does not.
    ingestEvents(db, "qkt-prod", [
      dealEnv({ ticket: "51", positionTicket: "500", entry: "OUT", strategyId: null, magic: 20107, broker: "EXNESS_P174", ts: T0 + 5 }),
      dealEnv({ ticket: "51", positionTicket: "500", entry: "OUT", strategyId: "fx3_GBPUSD_2", magic: 20107, broker: "EXNESS_P549", ts: T0 + 5 }),
    ]);
    const owners = db.prepare("SELECT strategy_id s FROM deals WHERE deal_ticket='51' ORDER BY rowid").all() as { s: string | null }[];
    expect(owners.map((r) => r.s)).toEqual(["fx3_GBPUSD_2", "fx3_GBPUSD_2"]);
  });

  it("drops explicit foreign strategy deals in an already-scoped instance", () => {
    const db = openDb(":memory:");
    seedStrategy(db, "hedge_straddle");
    ingestEvents(db, "qkt-prod", [
      dealEnv({ ticket: "15", positionTicket: "203", strategyId: "foreign_breakout", comment: "dsl-foreign_breakout" }),
      dealEnv({ ticket: "16", positionTicket: "204", strategyId: "hedge_straddle", comment: "dsl-hedge_straddle" }),
    ]);
    expect(dealCount(db)).toBe(1);
    expect(strategyOf(db, "16")).toBe("hedge_straddle");
    expect(strategyOf(db, "15")).toBeNull();
  });
});

describe("006_deal_attribution migration", () => {
  const sql = readFileSync(new URL("../src/migrations/006_deal_attribution.sql", import.meta.url), "utf8");

  const rawDeal = (db: Db, ticket: string, position: string | null, entry: string, strategyId: string | null, comment: string | null) =>
    db.prepare(
      "INSERT INTO deals (id, instance_id, broker, deal_ticket, position_ticket, entry, qty, price, profit, comment, strategy_id, ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(`deal-EXNESS-${ticket}`, "qkt-prod", "EXNESS", ticket, position, entry, 0.01, 4300, 0, comment, strategyId, T0);

  it("repairs history: position propagation, dsl- comments, ORD-N untouched", () => {
    const db = openDb(":memory:");
    seedStrategy(db, "hedge_straddle");
    seedStrategy(db, "latch_stack");
    // Attributed IN + venue-closed OUT of the same position.
    rawDeal(db, "20", "300", "IN", "hedge_straddle", "dsl-hedge_straddle");
    rawDeal(db, "21", "300", "OUT", null, "[tp 4332.689]");
    // Both legs null, but the IN carries a truncated dsl- comment: the comment
    // repairs the IN, then propagation carries it to the OUT.
    rawDeal(db, "22", "301", "IN", null, "dsl-latch_sta");
    rawDeal(db, "23", "301", "OUT", null, "[sl 4315.737]");
    // Old-era rows: unknowable, must stay NULL.
    rawDeal(db, "24", "302", "IN", null, "ORD-7");
    rawDeal(db, "25", null, "OUT", null, "");

    db.exec(sql);

    expect(strategyOf(db, "21")).toBe("hedge_straddle");
    expect(strategyOf(db, "22")).toBe("latch_stack");
    expect(strategyOf(db, "23")).toBe("latch_stack");
    expect(strategyOf(db, "24")).toBeNull();
    expect(strategyOf(db, "25")).toBeNull();
  });

  it("creates the position lookup index", () => {
    const db = openDb(":memory:");
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r: any) => r.name);
    expect(names).toContain("idx_deals_position");
  });
});
