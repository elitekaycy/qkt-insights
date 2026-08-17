import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import { pruneRetention } from "../src/retention.js";

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

    expect(r).toEqual({ logs: 1, events: 1, valuations: 1 });

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

  it("is a no-op on an empty window (nothing older than cutoff)", () => {
    const db = openDb(":memory:");
    seedLog(db, "log-new", RECENT, "new line");
    seedEvent(db, "ev-new", RECENT, "insights.health");
    expect(pruneRetention(db, NOW)).toEqual({ logs: 0, events: 0, valuations: 0 });
  });
});
