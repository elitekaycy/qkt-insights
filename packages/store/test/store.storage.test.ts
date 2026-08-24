import { describe, it, expect } from "vitest";
import { openDb, checkpoint } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { ingestEvents, persistStateEvent, instanceHealth } from "../src/index.js";
import type { Envelope } from "@qkt-insights/contract";

const T0 = 1718000000000;

function env(p: Partial<Envelope> & { type: Envelope["type"]; payload: any }): Envelope {
  return { v: 1, instanceId: "qkt-prod", id: Math.random().toString(36).slice(2), seq: 1, ts: T0, ...p } as Envelope;
}

function positions(ts: number, list: unknown[]): Envelope {
  return env({ id: `posn-EXNESS-${ts}`, ts, type: "state.positions", payload: { broker: "EXNESS", positions: list } });
}

const pos = { ticket: "T1", symbol: "EXNESS:XAUUSD", side: "BUY", qty: 0.01, entryPrice: 2300, currentPrice: 2310, profit: 10 };

describe("insights.health storage", () => {
  it("keeps only the latest health row per instance and writes no event or FTS row", () => {
    const db = openDb(":memory:");
    ingestEvents(db, "qkt-prod", [
      env({ id: "h1", ts: T0, type: "insights.health", payload: { sent: 1, failed: 0, dropped: 0, queued: 0, queueCapacity: 10 } }),
      env({ id: "h2", ts: T0 + 30_000, type: "insights.health", payload: { sent: 2, failed: 0, dropped: 0, queued: 0, queueCapacity: 10 } }),
    ]);
    expect(db.prepare("SELECT COUNT(*) n FROM events WHERE type='insights.health'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM events_fts").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM instance_health").get()).toEqual({ n: 1 });
    const h = instanceHealth(db).find((x) => x.instanceId === "qkt-prod")!;
    expect(h.insightsSent).toBe(2);
    expect(h.insightsHealthTs).toBe(T0 + 30_000);
  });

  it("ignores an out-of-order older health snapshot", () => {
    const db = openDb(":memory:");
    ingestEvents(db, "qkt-prod", [
      env({ id: "h2", ts: T0 + 30_000, type: "insights.health", payload: { sent: 2, failed: 0, dropped: 0, queued: 0, queueCapacity: 10 } }),
      env({ id: "h1", ts: T0, type: "insights.health", payload: { sent: 1, failed: 0, dropped: 0, queued: 0, queueCapacity: 10 } }),
    ]);
    expect(instanceHealth(db).find((x) => x.instanceId === "qkt-prod")!.insightsSent).toBe(2);
  });

  it("migrates existing health events into instance_health and drops them from events", () => {
    const db = openDb(":memory:");
    // Simulate a pre-013 database: insert raw health events, then re-run the migration body.
    db.prepare("DELETE FROM _migrations WHERE name='014_instance_health.sql'").run();
    const ins = db.prepare("INSERT INTO events (id, instance_id, type, strategy_id, seq, ts, payload) VALUES (?,?,?,?,?,?,?)");
    ins.run("old-1", "qkt-prod", "insights.health", null, 1, T0, JSON.stringify({ sent: 5 }));
    ins.run("old-2", "qkt-prod", "insights.health", null, 2, T0 + 1000, JSON.stringify({ sent: 6 }));
    ins.run("keep", "qkt-prod", "order.filled", "s", 3, T0, JSON.stringify({ symbol: "X" }));
    db.prepare("DELETE FROM instance_health").run();
    runMigrations(db);
    expect(db.prepare("SELECT payload FROM instance_health WHERE instance_id='qkt-prod'").get()).toEqual({ payload: JSON.stringify({ sent: 6 }) });
    expect(db.prepare("SELECT COUNT(*) n FROM events WHERE type='insights.health'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM events WHERE type='order.filled'").get()).toEqual({ n: 1 });
  });
});

describe("position valuation dedupe", () => {
  it("writes a valuation only when the position moved, plus a periodic heartbeat", () => {
    const db = openDb(":memory:");
    const count = () => (db.prepare("SELECT COUNT(*) n FROM position_valuations").get() as { n: number }).n;
    persistStateEvent(db, "qkt-dedupe", positions(T0, [pos]));
    expect(count()).toBe(1);
    persistStateEvent(db, "qkt-dedupe", positions(T0 + 30_000, [pos]));
    persistStateEvent(db, "qkt-dedupe", positions(T0 + 60_000, [pos]));
    expect(count()).toBe(1);
    persistStateEvent(db, "qkt-dedupe", positions(T0 + 90_000, [{ ...pos, currentPrice: 2311, profit: 11 }]));
    expect(count()).toBe(2);
    persistStateEvent(db, "qkt-dedupe", positions(T0 + 90_000 + 5 * 60_000, [{ ...pos, currentPrice: 2311, profit: 11 }]));
    expect(count()).toBe(3);
    // positions_current still reflects the latest poll regardless.
    expect(db.prepare("SELECT last_seen FROM positions_current WHERE ticket='T1'").get()).toEqual({ last_seen: T0 + 90_000 + 5 * 60_000 });
  });
});
