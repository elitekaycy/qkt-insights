import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import { pruneRetention, pruneStaleStrategies } from "../src/retention.js";
import { quarantineEnvelopes } from "../src/write.js";
import { listStrategies } from "../src/queries.js";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const OLD = NOW - 40 * DAY; // beyond the 30d window
const RECENT = NOW - 5 * DAY; // inside the window

function seedLog(db: any, id: string, ts: number, text: string) {
  db.prepare(
    "INSERT INTO logs (id, instance_id, strategy_id, level, logger, message, ts, seq) VALUES (?,?,?,?,?,?,?,?)",
  ).run(id, "qkt-prod", "s1", "INFO", "lg", text, ts, 1);
  const rowid = db.prepare("SELECT rowid FROM logs WHERE instance_id='qkt-prod' AND id=?").get(id).rowid;
  db.prepare("INSERT INTO logs_fts (text, instance_id, log_rowid) VALUES (?,?,?)").run(text, "qkt-prod", rowid);
}

function seedEvent(db: any, id: string, ts: number, type: string) {
  db.prepare(
    "INSERT INTO events (id, instance_id, type, strategy_id, seq, ts, payload) VALUES (?,?,?,?,?,?,?)",
  ).run(id, "qkt-prod", type, "s1", 1, ts, "{}");
  const rowid = db.prepare("SELECT rowid FROM events WHERE instance_id='qkt-prod' AND id=?").get(id).rowid;
  db.prepare("INSERT INTO events_fts (text, instance_id, event_rowid) VALUES (?,?,?)").run(type, "qkt-prod", rowid);
}

function seedMark(db: any, ticket: string, ts: number) {
  db.prepare(
    `INSERT INTO position_valuations (instance_id, broker, ticket, ts, symbol, side, qty, entry_price)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run("qkt-prod", "exness", ticket, ts, "XAUUSD", "BUY", 0.1, 2350);
}

function openPosition(db: any, ticket: string) {
  db.prepare(
    `INSERT INTO positions_current (instance_id, broker, ticket, symbol, side, qty, entry_price, last_seen, last_seq)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run("qkt-prod", "exness", ticket, "XAUUSD", "BUY", 0.1, 2350, NOW, 1);
}

describe("pruneRetention", () => {
  it("drops old logs, old non-trade events, and stale closed-position marks; keeps the rest", () => {
    const db = openDb(":memory:");
    seedLog(db, "log-old", OLD, "old line");
    seedLog(db, "log-new", RECENT, "new line");
    seedEvent(db, "ev-trade-old", OLD, "trade");
    seedEvent(db, "ev-health-old", OLD, "insights.health");
    seedEvent(db, "ev-health-new", RECENT, "insights.health");
    // ticket "open" is still open -> all its marks kept even when old; "closed" is gone from positions_current
    openPosition(db, "open");
    seedMark(db, "open", OLD);
    seedMark(db, "closed", OLD);
    seedMark(db, "closed", RECENT);

    const r = pruneRetention(db, NOW);

    expect(r).toEqual({ logs: 1, events: 1, valuations: 1, monitors: 0, views: 0, quarantined: 0 });

    const logIds = db.prepare("SELECT id FROM logs ORDER BY id").all().map((x: any) => x.id);
    expect(logIds).toEqual(["log-new"]);
    // FTS mirror pruned in lockstep with logs
    expect(db.prepare("SELECT COUNT(*) c FROM logs_fts").get().c).toBe(1);

    const evIds = db.prepare("SELECT id FROM events ORDER BY id").all().map((x: any) => x.id);
    expect(evIds).toEqual(["ev-health-new", "ev-trade-old"]); // trade kept despite age; old health gone
    expect(db.prepare("SELECT COUNT(*) c FROM events_fts").get().c).toBe(2);

    const marks = db
      .prepare("SELECT ticket, ts FROM position_valuations ORDER BY ticket, ts")
      .all()
      .map((x: any) => `${x.ticket}@${x.ts}`);
    // open ticket keeps its old mark; closed ticket keeps only the recent one
    expect(marks).toEqual([`closed@${RECENT}`, `open@${OLD}`]);
  });

  it("prunes quarantined envelopes by when they were received, not by their own ts", () => {
    const db = openDb(":memory:");
    const quarantine = (id: string, receivedAt: number, ts: number) =>
      quarantineEnvelopes(db, "qkt-prod", [{ id, instanceId: "qkt-prod", type: "signal.future", v: 1, ts, reason: "unknown type", raw: { id } }], receivedAt);
    quarantine("q-old", OLD, RECENT);
    quarantine("q-new", RECENT, OLD);
    expect(pruneRetention(db, NOW).quarantined).toBe(1);
    expect(db.prepare("SELECT id FROM quarantined_events").all()).toEqual([{ id: "q-new" }]);
  });

  it("is a no-op on an empty window (nothing older than cutoff)", () => {
    const db = openDb(":memory:");
    seedLog(db, "log-new", RECENT, "new line");
    seedEvent(db, "ev-new", RECENT, "insights.health");
    expect(pruneRetention(db, NOW)).toEqual({ logs: 0, events: 0, valuations: 0, monitors: 0, views: 0, quarantined: 0 });
  });
});

function seedStrategy(db: any, sid: string, lastSeen: number) {
  db.prepare(
    "INSERT INTO strategies (instance_id, strategy_id, first_seen, last_seen) VALUES (?,?,?,?)",
  ).run("qkt-prod", sid, lastSeen, lastSeen);
}

function seedStratLog(db: any, id: string, sid: string, ts: number) {
  db.prepare(
    "INSERT INTO logs (id, instance_id, strategy_id, level, logger, message, ts, seq) VALUES (?,?,?,?,?,?,?,?)",
  ).run(id, "qkt-prod", sid, "INFO", "lg", "x", ts, 1);
  const rowid = db.prepare("SELECT rowid FROM logs WHERE instance_id='qkt-prod' AND id=?").get(id).rowid;
  db.prepare("INSERT INTO logs_fts (text, instance_id, log_rowid) VALUES (?,?,?)").run("x", "qkt-prod", rowid);
}

function seedDeal(db: any, ticket: string, position: string, entry: string, sid: string, ts: number, profit: number) {
  db.prepare(
    `INSERT INTO deals (id, instance_id, broker, deal_ticket, position_ticket, symbol, side, entry, qty, price, profit, commission, strategy_id, ts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(`d-${ticket}`, "qkt-prod", "exness", ticket, position, "XAUUSD", "BUY", entry, 0.1, 2350, profit, -0.5, sid, ts);
}

describe("pruneStaleStrategies", () => {
  it("keeps a retired strategy's money history and all-time totals; clears only its operational rows", () => {
    const db = openDb(":memory:");
    // 'gone' is a swapped-out strategy silent for 31+ days; 'live' still reports (5d ago)
    seedStrategy(db, "gone", OLD); // silent 40 days, 35 behind its sibling
    seedStrategy(db, "live", RECENT);
    seedStratLog(db, "gl1", "gone", OLD);
    seedStratLog(db, "gl2", "gone", OLD);
    seedStratLog(db, "ll1", "live", RECENT);
    seedDeal(db, "1", "p1", "IN", "gone", OLD, 0);
    seedDeal(db, "2", "p1", "OUT", "gone", OLD + 3_600_000, 120);
    seedDeal(db, "3", "p2", "IN", "gone", OLD + 7_200_000, 0);
    seedDeal(db, "4", "p2", "OUT", "gone", OLD + 9_000_000, -45);
    db.prepare("INSERT INTO trade_closes (id, instance_id, strategy_id, symbol, side, qty, price, realized, ts, order_id) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run("tc-gone", "qkt-prod", "gone", "XAUUSD", "BUY", 0.1, 2350, 75, OLD, "o1");
    const before = listStrategies(db, "qkt-prod").find((s) => s.strategyId === "gone")!.realizedNet;

    const r = pruneStaleStrategies(db, NOW);

    expect(r.strategies).toBe(1);
    expect(r.rows).toBe(2); // the two logs, nothing else
    // Registration, deals and closes survive; the strategy only leaves the active roster.
    const roster = listStrategies(db, "qkt-prod");
    const gone = roster.find((s) => s.strategyId === "gone")!;
    expect(gone.active).toBe(false);
    expect(roster.find((s) => s.strategyId === "live")!.active).toBe(true);
    expect(db.prepare("SELECT COUNT(*) c FROM deals WHERE strategy_id='gone'").get().c).toBe(4);
    expect(db.prepare("SELECT COUNT(*) c FROM trade_closes WHERE strategy_id='gone'").get().c).toBe(1);
    // all-time: 120 - 45 less four 0.5 commissions
    expect(before).toBeCloseTo(73, 9);
    expect(gone.realizedNet).toBeCloseTo(73, 9);
    expect(gone.dealCount).toBe(2);
    expect(db.prepare("SELECT COUNT(*) c FROM logs WHERE strategy_id='gone'").get().c).toBe(0);
    expect(db.prepare("SELECT COUNT(*) c FROM logs_fts").get().c).toBe(1);
    expect(db.prepare("SELECT COUNT(*) c FROM logs WHERE strategy_id='live'").get().c).toBe(1);
    // A second sweep finds nothing more to delete.
    expect(pruneStaleStrategies(db, NOW).rows).toBe(0);
  });

  it("is a no-op when every strategy is inside the window", () => {
    const db = openDb(":memory:");
    seedStrategy(db, "a", RECENT);
    seedStrategy(db, "b", NOW - 29 * DAY);
    expect(pruneStaleStrategies(db, NOW)).toEqual({ strategies: 0, rows: 0 });
  });
});
