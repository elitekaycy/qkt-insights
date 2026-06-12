import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { openDb, LiveBus, LiveStateStore, type Db } from "@qkt-insights/store";
import { registerCollector } from "../src/index.js";
import type { Envelope } from "@qkt-insights/contract";

function env(p: any): Envelope {
  return { v: 1, instanceId: "qkt-prod", id: Math.random().toString(36).slice(2), seq: 1, ts: 1718000000000, ...p } as Envelope;
}

let app: FastifyInstance;
let db: Db;
let bus: LiveBus;
let liveState: LiveStateStore;
beforeEach(async () => {
  db = openDb(":memory:");
  bus = new LiveBus();
  liveState = new LiveStateStore();
  app = Fastify();
  registerCollector(app, { db, bus, liveState, ingestToken: "secret" });
  await app.ready();
});
afterEach(async () => { await app.close(); });

describe("POST /ingest", () => {
  it("rejects without a valid token", async () => {
    const res = await app.inject({ method: "POST", url: "/ingest", payload: { instanceId: "qkt-prod", events: [] } });
    expect(res.statusCode).toBe(401);
  });

  it("accepts a valid batch, persists, and publishes to the live bus", async () => {
    const seen: Envelope[] = [];
    bus.subscribe((e) => seen.push(e));
    const res = await app.inject({
      method: "POST", url: "/ingest",
      headers: { authorization: "Bearer secret" },
      payload: { instanceId: "qkt-prod", events: [
        env({ strategyId: "latch", type: "trade", payload: { orderId: "o1", symbol: "XAUUSD", side: "BUY", price: 2350, qty: 0.1, ts: 1718000000000 } }),
      ] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: 1 });
    expect(db.prepare("SELECT COUNT(*) c FROM events").get()).toMatchObject({ c: 1 });
    expect(seen).toHaveLength(1);
  });

  it("routes state.* into the live store, never the db, and still publishes", async () => {
    const seen: Envelope[] = [];
    bus.subscribe((e) => seen.push(e));
    const res = await app.inject({
      method: "POST", url: "/ingest",
      headers: { authorization: "Bearer secret" },
      payload: { instanceId: "qkt-prod", events: [
        env({ type: "state.account", payload: { broker: "EXNESS", currency: "USD", balance: 7824.05, equity: 7676.54 } }),
      ] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: 1 });
    expect(db.prepare("SELECT COUNT(*) c FROM events").get()).toMatchObject({ c: 0 });
    expect(liveState.snapshot(1718000001000).accounts).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });

  it("persists broker.deal into deals", async () => {
    const res = await app.inject({
      method: "POST", url: "/ingest",
      headers: { authorization: "Bearer secret" },
      payload: { instanceId: "qkt-prod", events: [
        env({ id: "deal-EXNESS-456", type: "broker.deal", payload: {
          broker: "EXNESS", dealTicket: "456", qty: 0.01, price: 2310.2, profit: 9.7,
          ts: 1718000000000, strategyId: "hedge_straddle" } }),
      ] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: 1 });
    expect(db.prepare("SELECT COUNT(*) c FROM deals").get()).toMatchObject({ c: 1 });
    expect(db.prepare("SELECT COUNT(*) c FROM events").get()).toMatchObject({ c: 0 });
  });

  it("returns 400 on a malformed envelope", async () => {
    const res = await app.inject({
      method: "POST", url: "/ingest",
      headers: { authorization: "Bearer secret" },
      payload: { instanceId: "qkt-prod", events: [{ v: 1, instanceId: "qkt-prod", id: "x", seq: 1, ts: 1, type: "trade", payload: { nope: true } }] },
    });
    expect(res.statusCode).toBe(400);
  });
});
