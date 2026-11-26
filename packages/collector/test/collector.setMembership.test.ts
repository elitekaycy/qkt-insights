import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { openDb, LiveBus, LiveStateStore, strategySetMembership, type Db } from "@qkt-insights/store";
import { registerCollector } from "../src/index.js";

const INSTANCE = "qkt-prod";
const TS = Date.UTC(2026, 10, 20, 9);

let app: FastifyInstance;
let db: Db;
let bus: LiveBus;
beforeEach(async () => {
  db = openDb(":memory:");
  bus = new LiveBus();
  app = Fastify();
  registerCollector(app, { db, bus, liveState: new LiveStateStore(), ingestToken: "secret" });
  await app.ready();
});
afterEach(async () => { await app.close(); });

/** A set.membership envelope as qkt's translator sends it. */
const membership = (id: string, payload: Record<string, unknown>) => ({
  v: 1, instanceId: INSTANCE, id, seq: 7, ts: TS, strategyId: "rotator", type: "set.membership",
  payload: { strategyId: "rotator", set: "movers", member: "BINANCE:BTCUSDT", change: "join", rank: 1, closeTs: TS - 60_000, ...payload },
});

async function ingest(events: unknown[]) {
  const res = await app.inject({ method: "POST", url: "/ingest", headers: { authorization: "Bearer secret" }, payload: { instanceId: INSTANCE, events } });
  return { status: res.statusCode, body: res.json() };
}

describe("POST /ingest set.membership", () => {
  it("accepts a membership change, stores it, publishes it live, and dedupes its redelivery", async () => {
    const published: string[] = [];
    bus.subscribe((e) => published.push(`${e.type}:${e.id}`));
    const first = membership("m1", { reason: "entered the ranking" });
    const unranked = membership("m2", { member: "BINANCE:XRPUSDT", change: "unavailable", rank: null, reason: "subscribe failed" });

    const { status, body } = await ingest([first, unranked]);
    expect(status).toBe(200);
    expect(body).toMatchObject({ accepted: 2, quarantined: 0, envelopes: [{ id: "m1", status: "accepted" }, { id: "m2", status: "accepted" }] });
    expect(published).toEqual(["set.membership:m1", "set.membership:m2"]);

    const again = await ingest([first]);
    expect(again.body).toMatchObject({ accepted: 0, envelopes: [{ id: "m1", status: "duplicate" }] });

    const view = strategySetMembership(db, INSTANCE, "rotator");
    expect(view.members).toEqual([{ set: "movers", member: "BINANCE:BTCUSDT", state: "member", change: "join", rank: 1, since: TS }]);
    expect(view.changes).toEqual([
      { id: "m2", set: "movers", member: "BINANCE:XRPUSDT", change: "unavailable", rank: null, closeTs: TS - 60_000, reason: "subscribe failed", ts: TS },
      { id: "m1", set: "movers", member: "BINANCE:BTCUSDT", change: "join", rank: 1, closeTs: TS - 60_000, reason: "entered the ranking", ts: TS },
    ]);
  });

  it("quarantines a change without its member or close time, and keeps the rest of the batch", async () => {
    const { member: _member, ...noMember } = membership("bad-1", {}).payload;
    const { body } = await ingest([
      { ...membership("bad-1", {}), payload: noMember },
      membership("bad-2", { closeTs: "yesterday" }),
      membership("ok", {}),
    ]);
    expect(body).toMatchObject({ accepted: 1, quarantined: 2 });
    expect(body.envelopes.map((e: { status: string }) => e.status)).toEqual(["quarantined", "quarantined", "accepted"]);
    expect(strategySetMembership(db, INSTANCE, "rotator").changes.map((c) => c.id)).toEqual(["ok"]);
  });

  it("lists set.membership among the types /ingest/capabilities accepts, since 1.7.0", async () => {
    const res = await app.inject({ method: "GET", url: "/ingest/capabilities", headers: { authorization: "Bearer secret" } });
    expect(res.json().contractVersion).toBe("1.7.0");
    expect(res.json().types).toContainEqual({ type: "set.membership", since: "1.7.0" });
  });
});
