import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import argon2 from "argon2";
import { openDb, ingestEvents, LiveStateStore, type Db } from "@qkt-insights/store";
import { registerAuth } from "../src/auth.js";
import { registerRest } from "../src/rest.js";
import type { Envelope } from "@qkt-insights/contract";

function env(p: any): Envelope {
  return { v: 1, instanceId: "qkt-prod", id: Math.random().toString(36).slice(2), seq: 1, ts: 1718000000000, ...p } as Envelope;
}

let app: FastifyInstance; let db: Db; let liveState: LiveStateStore; let session: string;
beforeEach(async () => {
  db = openDb(":memory:");
  liveState = new LiveStateStore();
  ingestEvents(db, "qkt-prod", [
    env({ strategyId: "latch", type: "order.filled", payload: { orderId: "o1", brokerOrderId: "b1", symbol: "XAUUSD", price: 2350, qty: 0.1 } }),
    env({ strategyId: "latch", type: "trade", payload: { orderId: "o1", symbol: "XAUUSD", side: "BUY", price: 2350, qty: 0.1, ts: 1718000000000 } }),
  ]);
  app = Fastify();
  await app.register(cookie);
  const hash = await argon2.hash("pw");
  registerAuth(app, { username: "admin", passwordHash: hash, sessionSecret: "session-secret-key-at-least-32-chars!!" });
  registerRest(app, { db, liveState });
  await app.ready();
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "admin", password: "pw" } });
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

describe("spec3 REST", () => {
  it("serves the performance bundle", async () => {
    ingestEvents(db, "qkt-prod", [
      env({ strategyId: "latch", type: "snapshot.equity", ts: 1718000000000, payload: { strategyId: "latch", realized: 0, unrealized: 0, equity: 1000, startingBalance: 1000 } }),
      env({ strategyId: "latch", type: "snapshot.equity", ts: 1718086400000, payload: { strategyId: "latch", realized: 50, unrealized: 0, equity: 1050, startingBalance: 1000 } }),
    ]);
    const res = await get("/performance?instance=qkt-prod&strategy=latch");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.report.wins).toBe(1);
    expect(body.report.approximate).toBe(true);
    expect(Array.isArray(body.dailyNets)).toBe(true);
    expect(Array.isArray(body.drawdownPeriods)).toBe(true);
    expect(Array.isArray(body.postLoss)).toBe(true);
    expect(Array.isArray(body.closes)).toBe(true);
  });

  it("includes closed trades in the performance bundle", async () => {
    ingestEvents(db, "qkt-prod", [
      env({ strategyId: "latch", type: "trade.closed", ts: 1718000005000,
        payload: { orderId: "o-77", symbol: "XAUUSD", side: "SELL", qty: 0.1, price: 2360, realized: 25, ts: 1718000005000 } }),
    ]);
    const body = (await get("/performance?instance=qkt-prod&strategy=latch")).json();
    expect(body.closes).toHaveLength(1);
    expect(body.closes[0]).toMatchObject({ symbol: "XAUUSD", realized: 25, orderId: "o-77" });
  });

  it("serves open positions", async () => {
    // openPositions reads legacy snapshot.position events rows; ingest no longer
    // writes them, so the test seeds the events table directly.
    db.prepare("INSERT INTO events (id, instance_id, type, strategy_id, seq, ts, payload) VALUES (?,?,?,?,?,?,?)")
      .run("pos-1", "qkt-prod", "snapshot.position", "latch", 1, 1718000000000,
        JSON.stringify({ strategyId: "latch", symbol: "XAUUSD", legs: [{ side: "BUY", qty: 0.1, entryPrice: 2350, entryTs: 1718000000000 }] }));
    const rows = (await get("/positions?instance=qkt-prod")).json();
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe("XAUUSD");
  });

  it("requires instance and strategy on /performance", async () => {
    expect((await get("/performance?instance=qkt-prod")).statusCode).toBe(400);
    expect((await get("/performance")).statusCode).toBe(400);
  });
});

describe("broker state REST", () => {
  it("guards the new routes behind the session", async () => {
    for (const url of ["/live/state", "/deals?instance=qkt-prod", "/account/equity?instance=qkt-prod"]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    }
  });

  it("serves the live state snapshot", async () => {
    liveState.upsert("qkt-prod", env({ type: "state.account", ts: Date.now(),
      payload: { broker: "EXNESS", currency: "USD", balance: 7824.05, equity: 7676.54, openProfit: -147.51 } }));
    liveState.upsert("qkt-prod", env({ type: "state.positions", ts: Date.now(),
      payload: { broker: "EXNESS", positions: [{ ticket: "123", symbol: "EXNESS:XAUUSD", side: "BUY",
        qty: 0.01, entryPrice: 2300.5, profit: 9.7, strategyId: null }] } }));
    const res = await get("/live/state");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]).toMatchObject({ instanceId: "qkt-prod", broker: "EXNESS",
      balance: 7824.05, equity: 7676.54, stale: false });
    expect(body.positions).toHaveLength(1);
    expect(body.positions[0].list[0]).toMatchObject({ ticket: "123", strategyId: null });
  });

  it("serves deals filtered by instance and strategy", async () => {
    ingestEvents(db, "qkt-prod", [
      env({ id: "deal-EXNESS-1", type: "broker.deal", ts: 1718000001000, payload: {
        broker: "EXNESS", dealTicket: "1", symbol: "EXNESS:XAUUSD", side: "SELL", entry: "OUT",
        qty: 0.01, price: 2310.2, profit: 9.7, commission: -0.07, swap: -0.12,
        ts: 1718000001000, strategyId: "hedge_straddle" } }),
    ]);
    expect((await get("/deals")).statusCode).toBe(400);
    const rows = (await get("/deals?instance=qkt-prod&strategy=hedge_straddle")).json();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dealTicket: "1", entry: "OUT", profit: 9.7, strategyId: "hedge_straddle" });
  });

  it("serves the account equity rollup", async () => {
    db.prepare("INSERT INTO account_equity (instance_id, broker, minute_ts, balance, equity, open_profit) VALUES (?,?,?,?,?,?)")
      .run("qkt-prod", "EXNESS", 1718000040000, 7824.05, 7676.54, -147.51);
    expect((await get("/account/equity")).statusCode).toBe(400);
    const rows = (await get("/account/equity?instance=qkt-prod")).json();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ broker: "EXNESS", minuteTs: 1718000040000, equity: 7676.54 });
  });
});
