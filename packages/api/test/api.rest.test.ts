import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import argon2 from "argon2";
import { openDb, ingestEvents, type Db } from "@qkt-insights/store";
import { registerAuth } from "../src/auth.js";
import { registerRest } from "../src/rest.js";
import type { Envelope } from "@qkt-insights/contract";

function env(p: any): Envelope {
  return { v: 1, instanceId: "qkt-prod", id: Math.random().toString(36).slice(2), seq: 1, ts: 1718000000000, ...p } as Envelope;
}

let app: FastifyInstance; let db: Db; let session: string;
beforeEach(async () => {
  db = openDb(":memory:");
  ingestEvents(db, "qkt-prod", [
    env({ strategyId: "latch", type: "order.filled", payload: { orderId: "o1", brokerOrderId: "b1", symbol: "XAUUSD", price: 2350, qty: 0.1 } }),
    env({ strategyId: "latch", type: "trade", payload: { orderId: "o1", symbol: "XAUUSD", side: "BUY", price: 2350, qty: 0.1, ts: 1718000000000 } }),
  ]);
  app = Fastify();
  await app.register(cookie);
  const hash = await argon2.hash("pw");
  registerAuth(app, { passwordHash: hash, sessionSecret: "session-secret-key-at-least-32-chars!!" });
  registerRest(app, { db });
  await app.ready();
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { password: "pw" } });
  session = String(login.headers["set-cookie"]).split(";")[0]!;
});
afterEach(async () => { await app.close(); });

function get(url: string) { return app.inject({ method: "GET", url, headers: { cookie: session } }); }

describe("REST", () => {
  it("guards routes behind the session", async () => {
    const res = await app.inject({ method: "GET", url: "/instances" });
    expect(res.statusCode).toBe(401);
  });
  it("lists instances", async () => {
    expect((await get("/instances")).json()).toMatchObject([{ id: "qkt-prod" }]);
  });
  it("lists strategies for an instance", async () => {
    expect((await get("/strategies?instance=qkt-prod")).json()).toMatchObject([{ strategyId: "latch" }]);
  });
  it("lists orders", async () => {
    const rows = (await get("/orders?instance=qkt-prod&state=FILLED")).json();
    expect(rows).toHaveLength(1);
  });
  it("lists trades by symbol", async () => {
    const rows = (await get("/trades?instance=qkt-prod&symbol=XAUUSD")).json();
    expect(rows).toHaveLength(1);
  });
  it("searches", async () => {
    const rows = (await get("/search?q=XAUUSD&instance=qkt-prod")).json();
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
  it("returns 400 when instance is missing on a scoped route", async () => {
    expect((await get("/orders")).statusCode).toBe(400);
  });
});

describe("spec2 REST", () => {
  it("serves logs with level filter and search", async () => {
    ingestEvents(db, "qkt-prod", [
      env({ strategyId: "latch", type: "log", payload: { level: "WARN", logger: "com.qkt.x", message: "stale symbol XAUUSD" } }),
      env({ strategyId: "latch", type: "log", payload: { level: "INFO", logger: "com.qkt.x", message: "engine started" } }),
    ]);
    const all = (await get("/logs?instance=qkt-prod")).json();
    expect(all).toHaveLength(2);
    const warns = (await get("/logs?instance=qkt-prod&level=WARN")).json();
    expect(warns).toHaveLength(1);
    const hits = (await get("/logs?instance=qkt-prod&q=stale")).json();
    expect(hits).toHaveLength(1);
  });

  it("serves strategy stats", async () => {
    const res = await get("/stats?instance=qkt-prod&strategy=latch");
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.tradeCount).toBe(1);
    expect(s).toHaveProperty("sharpe");
    expect(s).toHaveProperty("winRate");
  });

  it("requires instance on /logs", async () => {
    expect((await get("/logs")).statusCode).toBe(400);
  });
});
