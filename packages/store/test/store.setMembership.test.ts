import { describe, it, expect } from "vitest";
import type { Envelope } from "@qkt-insights/contract";
import { openDb, ingestEnvelopes, listStrategies, pruneRetention, pruneStaleStrategies, searchEvents, strategySetMembership, type Db } from "../src/index.js";

const I = "fwd";
const T0 = Date.UTC(2026, 10, 20, 9);
const M = 60_000;
const DAY = 86_400_000;

let seq = 0;
function change(ts: number, member: string, kind: string, extra: Record<string, unknown> = {}): Envelope {
  seq++;
  return {
    v: 1, instanceId: I, id: `event-set.membership-gold-${ts}-${seq}`, seq, ts, strategyId: "gold", type: "set.membership",
    payload: { strategyId: "gold", set: "movers", member, change: kind, rank: null, closeTs: ts - M, ...extra },
  } as Envelope;
}

function fresh(events: Envelope[]): Db {
  const db = openDb(":memory:");
  ingestEnvelopes(db, I, events);
  return db;
}

describe("set membership", () => {
  it("stores every field of a change in its own table, once per envelope id, and never as an event", () => {
    const join = change(T0, "BINANCE:BTCUSDT", "join", { rank: 1, reason: "entered the ranking" });
    const db = openDb(":memory:");
    expect(ingestEnvelopes(db, I, [join]).statuses).toEqual(["accepted"]);
    expect(ingestEnvelopes(db, I, [join]).statuses).toEqual(["duplicate"]);

    const row = db.prepare("SELECT * FROM set_membership").all();
    expect(row).toEqual([{
      instance_id: I, id: join.id, strategy_id: "gold", set_name: "movers", member: "BINANCE:BTCUSDT", change: "join",
      rank: 1, close_ts: T0 - M, reason: "entered the ranking", ts: T0, seq: join.seq,
    }]);
    expect(db.prepare("SELECT COUNT(*) c FROM events").get()).toEqual({ c: 0 });
    expect(searchEvents(db, { q: "BTCUSDT", instanceId: I, limit: 10 })).toEqual([]);
    expect(listStrategies(db, I).map((s) => s.strategyId)).toEqual(["gold"]);
  });

  it("lists the latest changes newest first and the members in each set now, by rank", () => {
    const db = fresh([
      change(T0, "BINANCE:BTCUSDT", "join", { rank: 2 }),
      change(T0, "BINANCE:ETHUSDT", "join", { rank: 1 }),
      change(T0, "BINANCE:SOLUSDT", "join", { rank: 3 }),
      change(T0 + M, "BINANCE:SOLUSDT", "leave"),
      change(T0 + M, "BINANCE:BTCUSDT", "stick"),
      change(T0 + 2 * M, "BINANCE:XRPUSDT", "unavailable", { reason: "subscribe failed" }),
      change(T0 + 2 * M, "BINANCE:DOGEUSDT", "JOIN", { rank: 3, set: "laggards" }),
    ]);
    const view = strategySetMembership(db, I, "gold");
    expect(view.members).toEqual([
      { set: "laggards", member: "BINANCE:DOGEUSDT", state: "member", change: "join", rank: 3, since: T0 + 2 * M },
      { set: "movers", member: "BINANCE:ETHUSDT", state: "member", change: "join", rank: 1, since: T0 },
      { set: "movers", member: "BINANCE:BTCUSDT", state: "sticky", change: "stick", rank: null, since: T0 + M },
    ]);
    expect(view.changes.map((c) => [c.member, c.change])).toEqual([
      ["BINANCE:DOGEUSDT", "join"], ["BINANCE:XRPUSDT", "unavailable"], ["BINANCE:BTCUSDT", "stick"],
      ["BINANCE:SOLUSDT", "leave"], ["BINANCE:SOLUSDT", "join"], ["BINANCE:ETHUSDT", "join"], ["BINANCE:BTCUSDT", "join"],
    ]);
    expect(view.changes[1]).toMatchObject({ reason: "subscribe failed", rank: null, closeTs: T0 + M });
    expect(strategySetMembership(db, I, "gold", 2).changes).toHaveLength(2);
    expect(strategySetMembership(db, I, "other")).toEqual({ members: [], changes: [] });
  });

  it("drops a member a restart did not restore, and keeps one that joined after it", () => {
    const db = fresh([
      change(T0, "BINANCE:BTCUSDT", "join", { rank: 1 }),
      change(T0, "BINANCE:ETHUSDT", "join", { rank: 2 }),
      change(T0 + 10 * M, "BINANCE:BTCUSDT", "restore", { rank: 1 }),
      change(T0 + 11 * M, "BINANCE:SOLUSDT", "join", { rank: 2 }),
    ]);
    expect(strategySetMembership(db, I, "gold").members.map((m) => [m.member, m.change])).toEqual([
      ["BINANCE:BTCUSDT", "restore"], ["BINANCE:SOLUSDT", "join"],
    ]);
  });

  it("prunes changes past the retention window but keeps each member's latest, so it still says where the member stands", () => {
    const db = fresh([
      change(T0, "BINANCE:BTCUSDT", "join", { rank: 1 }),
      change(T0 + M, "BINANCE:BTCUSDT", "stick"),
      change(T0, "BINANCE:ETHUSDT", "join", { rank: 2 }),
      change(T0 + 40 * DAY, "BINANCE:ETHUSDT", "leave"),
    ]);
    expect(pruneRetention(db, T0 + 41 * DAY).membership).toBe(2);
    const view = strategySetMembership(db, I, "gold");
    expect(view.changes.map((c) => [c.member, c.change])).toEqual([["BINANCE:ETHUSDT", "leave"], ["BINANCE:BTCUSDT", "stick"]]);
    expect(view.members.map((m) => [m.member, m.state])).toEqual([["BINANCE:BTCUSDT", "sticky"]]);
  });

  it("clears a retired strategy's membership with its other operational history", () => {
    const db = fresh([change(T0, "BINANCE:BTCUSDT", "join", { rank: 1 })]);
    expect(pruneStaleStrategies(db, T0 + 31 * DAY).rows).toBe(1);
    expect(strategySetMembership(db, I, "gold")).toEqual({ members: [], changes: [] });
  });
});
