import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { openDb, ingestEvents, LiveStateStore, Shares, type Db } from "@qkt-insights/store";
import type { Envelope } from "@qkt-insights/contract";
import { registerPublic } from "../src/public.js";
import { TtlCache } from "../src/cache.js";

/*
 * Regressions for the independent review of public links: each case is an attack or leak that
 * reproduced against the first implementation.
 */

const MIN = 60_000;
const NOW = Date.UTC(2026, 8, 15, 12, 0);
const DELAY = 15 * MIN;
const CUT = NOW - DELAY;
const T0 = NOW - 600 * MIN;

let app: FastifyInstance;
afterEach(async () => { await app?.close(); });

interface Setup { db: Db; shares: Shares; cache: TtlCache; token: string }

async function setup(seed: (db: Db) => void, opts: { kind?: "strategy" | "overview"; firstSeen?: number; computeBudgetPerMinute?: number } = {}): Promise<Setup> {
  const db = openDb(":memory:");
  const shares = new Shares(db);
  db.prepare("INSERT INTO strategies (instance_id, strategy_id, first_seen, last_seen, starting_balance, metadata) VALUES ('i1', 'a', ?, ?, 10000, '{}')").run(opts.firstSeen ?? T0, NOW);
  seed(db);
  const kind = opts.kind ?? "strategy";
  if (kind === "strategy") shares.set("i1", "strategy", "a", "public");
  else shares.set("i1", "overview", "", "public");
  const token = shares.ensureToken("i1", kind, kind === "strategy" ? "a" : "");
  const cache = new TtlCache(60_000, 1000, () => NOW);
  app = Fastify();
  registerPublic(app, { db, liveState: new LiveStateStore(), shares, cache, delayMs: DELAY, now: () => NOW, computeBudgetPerMinute: opts.computeBudgetPerMinute });
  await app.ready();
  return { db, shares, cache, token };
}

async function get(token: string, path: string) {
  const res = await app.inject({ method: "GET", url: `/public/${token}${path}` });
  return { status: res.statusCode, json: res.statusCode === 200 ? res.json() : null, body: res.body };
}

function event(db: Db, id: string, type: string, ts: number, payload: object) {
  db.prepare("INSERT INTO events (id, instance_id, type, strategy_id, seq, ts, payload) VALUES (?, 'i1', ?, 'a', 1, ?, ?)").run(id, type, ts, JSON.stringify(payload));
}

function deal(ticket: string, position: string, entry: string, side: string, ts: number, qty: number, profit = 0, commission = 0): Envelope {
  return {
    v: 1, instanceId: "i1", id: `deal-${ticket}`, seq: 1, ts, type: "broker.deal",
    payload: { broker: "B", dealTicket: ticket, positionTicket: position, orderTicket: `ot-${ticket}`, symbol: "XAUUSD", side, entry, qty, price: 4000, profit, commission, swap: 0, strategyId: "a", ts },
  } as Envelope;
}

describe("positions open at the cutoff stay invisible", () => {
  it("stats do not count the entry fill of an open position, and a paper strategy shows no unrealized equity", async () => {
    const { token } = await setup((db) => {
      event(db, "f1", "trade", CUT - 60 * MIN, { orderId: "o1", symbol: "XAUUSD", side: "SELL", qty: 2.5, price: 4000 });
      db.prepare("INSERT INTO equity_snapshots (instance_id, strategy_id, ts, realized, unrealized, equity) VALUES ('i1','a',?,0,-12,9988)").run(CUT - 5 * MIN);
    });
    const stats = (await get(token, "/stats?strategy=a")).json;
    expect(stats).toMatchObject({ tradeCount: 0, buyCount: 0, sellCount: 0, volume: 0, realizedPnl: null, equity: null, returnPct: null });
    expect((await get(token, "/equity?strategy=a")).json).toEqual([]);
  });

  it("a partly closed position shows neither its entry nor its partial close anywhere", async () => {
    const { token } = await setup((db) => {
      ingestEvents(db, "i1", [deal("d1", "p1", "IN", "BUY", CUT - 60 * MIN, 3, 0, -21), deal("d2", "p1", "OUT", "SELL", CUT - 30 * MIN, 1, 7)]);
      db.prepare("INSERT INTO orders (instance_id, order_id, strategy_id, symbol, side, type, state, qty, cum_qty, created_ts, updated_ts, broker_order_id) VALUES ('i1','eo1','a','XAUUSD','BUY','MARKET','FILLED',3,3,?,?,'ot-d1')").run(CUT - 60 * MIN, CUT - 60 * MIN);
      event(db, "t1", "trade", CUT - 60 * MIN, { orderId: "eo1", symbol: "XAUUSD", side: "BUY", qty: 3, price: 4000 });
    });
    expect((await get(token, "/deals?strategy=a")).json).toEqual([]);
    expect((await get(token, "/trades?strategy=a")).json).toEqual([]);
    const perf = (await get(token, "/performance?strategy=a")).json as Record<string, any>;
    expect(perf.closes).toEqual([]);
    expect(perf.contribution).toBeNull();
    expect(perf.breakdowns).toBeNull();
    expect(perf.costs?.total.commission ?? 0).toBe(0);
    expect((await get(token, "/stats?strategy=a")).json).toMatchObject({ tradeCount: 0, buyCount: 0, sellCount: 0 });
    expect((await get(token, "/strategies")).json).toEqual([expect.objectContaining({ strategyId: "a", dealCount: 0, realizedNet: null })]);
  });

  it("once the rest closes before the cutoff, the whole position appears", async () => {
    const { token } = await setup((db) => {
      ingestEvents(db, "i1", [
        deal("d1", "p1", "IN", "BUY", CUT - 60 * MIN, 3, 0, -21), deal("d2", "p1", "OUT", "SELL", CUT - 30 * MIN, 1, 7), deal("d3", "p1", "OUT", "SELL", CUT - 10 * MIN, 2, 20),
      ]);
    });
    expect(((await get(token, "/deals?strategy=a")).json as unknown[]).length).toBe(3);
    const perf = (await get(token, "/performance?strategy=a")).json as Record<string, any>;
    expect(perf.closes).toHaveLength(2);
    expect(perf.costs.total.commission).toBe(-21);
  });

  it("an order submitted before the cutoff but filled after it changes nothing public", async () => {
    const seed = (fill: boolean) => (db: Db) => {
      ingestEvents(db, "i1", [deal("d1", "p1", "IN", "BUY", T0, 1), deal("d2", "p1", "OUT", "SELL", T0 + 10 * MIN, 1, 5)]);
      event(db, "s2", "order.submit", CUT - 2 * MIN, { orderId: "o2", side: "BUY", referencePrice: 4000, stopLoss: 3990, takeProfit: 4030, entryPrice: 4000 });
      if (fill) event(db, "f2", "order.filled", NOW - MIN, { orderId: "o2", price: 4001.5 });
    };
    const before = await setup(seed(false));
    const a = (await get(before.token, "/performance?strategy=a")).body;
    await app.close();
    const after = await setup(seed(true));
    const b = (await get(after.token, "/performance?strategy=a")).body;
    expect(b).toBe(a);
    const perf = JSON.parse(b) as Record<string, any>;
    expect(perf.execution).toBeUndefined();
    expect(perf.normalized.averagePlannedRiskReward).toBeNull();
  });

  it("a first close inside the delay window leaves the equity curve and costs untouched", async () => {
    const { token } = await setup((db) => {
      ingestEvents(db, "i1", [deal("d1", "p1", "IN", "BUY", CUT - 60 * MIN, 1, 0, -7), deal("d2", "p1", "OUT", "SELL", NOW - 2 * MIN, 1, 50)]);
    });
    expect((await get(token, "/equity?strategy=a")).json).toEqual([]);
    const perf = (await get(token, "/performance?strategy=a")).json as Record<string, any>;
    expect(perf.costs).toBeNull();
    expect(perf.closes).toEqual([]);
  });

  it("open P&L is never attributed to a strategy, and a strategy link gets none at all", async () => {
    const seed = (db: Db) => {
      db.prepare("INSERT INTO position_valuations (instance_id, broker, ticket, ts, symbol, side, qty, entry_price, current_price, profit, swap, strategy_id) VALUES ('i1','B','p9',?, 'XAUUSD','BUY',1,4000,4010,10,0,'a')").run(CUT - MIN);
    };
    const strategyLink = await setup(seed);
    expect((await get(strategyLink.token, "/live/state")).json).toEqual({ accounts: [], positions: [], orders: [] });
    await app.close();
    const overviewLink = await setup(seed, { kind: "overview" });
    const state = (await get(overviewLink.token, "/live/state")).json as Record<string, unknown>;
    expect(state.positions).toEqual([]);
    // A lone position's total would be its own P&L.
    expect(state.openPositions).toEqual({ count: 1, unrealized: null });
  });

  it("a strategy first seen inside the delay window is not listed yet", async () => {
    const { token } = await setup(() => {}, { kind: "overview", firstSeen: NOW - 5 * MIN });
    expect((await get(token, "/strategies")).json).toEqual([]);
  });
});

describe("abuse", () => {
  it("repeated parameters do not crash, and a strategy array is refused", async () => {
    const { token } = await setup(() => {});
    expect((await get(token, "/performance?strategy=a&include=report&include=closes")).status).toBe(200);
    expect((await get(token, "/stats?strategy=a&strategy=b")).status).toBe(404);
  });

  it("junk and drifting parameters share one cache entry instead of recomputing", async () => {
    const { token, cache } = await setup((db) => {
      ingestEvents(db, "i1", [deal("d1", "p1", "IN", "BUY", T0, 1), deal("d2", "p1", "OUT", "SELL", T0 + 10 * MIN, 1, 5)]);
    });
    await get(token, "/performance?strategy=a");
    const settled = cache.size;
    for (let i = 0; i < 40; i++) {
      await get(token, `/performance?strategy=a&x=${i}&include=report,closes,r${i}&window=${7 + i}&from=${CUT - 7 * 86_400_000 + i * 1000}`);
    }
    expect(cache.size - settled).toBeLessThanOrEqual(6);
  });

  it("uncached computations beyond the global budget get 503 instead of pinning the process", async () => {
    const { token } = await setup((db) => {
      ingestEvents(db, "i1", [deal("d1", "p1", "IN", "BUY", T0, 1), deal("d2", "p1", "OUT", "SELL", T0 + 10 * MIN, 1, 5)]);
    }, { computeBudgetPerMinute: 3 });
    const codes: number[] = [];
    for (const path of ["/stats?strategy=a", "/equity?strategy=a", "/performance?strategy=a", "/trades?strategy=a", "/stats?strategy=a"]) codes.push((await get(token, path)).status);
    expect(codes).toEqual([200, 200, 200, 503, 200]);
  });
});

describe("links die with their visibility", () => {
  it("a link from before a subject went private stays dead after it is public again", async () => {
    const { shares, token, cache } = await setup(() => {});
    expect((await get(token, "/meta")).status).toBe(200);
    // The admin route rotates on a public -> private transition; exercised end to end in api.public.test.ts.
    shares.set("i1", "strategy", "a", "private");
    shares.rotate("i1", "strategy", "a");
    cache.clear();
    shares.set("i1", "strategy", "a", "public");
    expect((await get(token, "/meta")).status).toBe(404);
  });
});

describe("second review: strategies without broker deals", () => {
  it("an engine-only partial close of a still-open position shows nowhere", async () => {
    const { token } = await setup((db) => {
      event(db, "t-in", "trade", CUT - 60 * MIN, { orderId: "o-in", symbol: "XAUUSD", side: "BUY", qty: 3, price: 4000 });
      event(db, "t-out", "trade", CUT - 30 * MIN, { orderId: "o-out", symbol: "XAUUSD", side: "SELL", qty: 1, price: 4010 });
      db.prepare("INSERT INTO trade_closes (id, instance_id, strategy_id, symbol, side, qty, price, realized, entry_ts, ts, order_id) VALUES ('c1','i1','a','XAUUSD','BUY',1,4010,10,?,?,'o-out')").run(CUT - 60 * MIN, CUT - 30 * MIN);
    });
    expect((await get(token, "/stats?strategy=a")).json).toMatchObject({ tradeCount: 0, buyCount: 0, volume: 0, equity: null });
    expect(((await get(token, "/performance?strategy=a")).json as Record<string, any>).closes).toEqual([]);
    expect((await get(token, "/trades?strategy=a")).json).toEqual([]);
    expect((await get(token, "/equity?strategy=a")).json).toEqual([]);
  });

  it("equity snapshots never feed drawdown, rolling or daily figures", async () => {
    const { token } = await setup((db) => {
      const snap = db.prepare("INSERT INTO equity_snapshots (instance_id, strategy_id, ts, realized, unrealized, equity) VALUES ('i1','a',?,?,?,0)");
      snap.run(CUT - 3 * 60 * MIN, 0, 0);
      snap.run(CUT - 2 * 60 * MIN, 20, 0);
      snap.run(CUT - 60 * MIN, 20, -50);
      snap.run(CUT - 5 * MIN, 20, -120);
      event(db, "fill", "trade", CUT - 70 * MIN, { orderId: "o1", symbol: "XAUUSD", side: "SELL", qty: 1, price: 4000 });
    });
    const perf = (await get(token, "/performance?strategy=a")).json as Record<string, any>;
    expect(perf.drawdownPeriods).toEqual([]);
    expect(perf.dailyNets).toEqual([]);
    expect(perf.rolling).toEqual([]);
    expect(perf.report.maxDrawdownAbs ?? 0).toBe(0);
  });
});

describe("second review: availability", () => {
  it("one link spending its compute budget leaves other links and every /meta working, and serves stale values", async () => {
    const db = openDb(":memory:");
    const shares = new Shares(db);
    for (const id of ["a", "b"]) db.prepare("INSERT INTO strategies (instance_id, strategy_id, first_seen, last_seen, starting_balance, metadata) VALUES ('i1', ?, ?, ?, 10000, '{}')").run(id, T0, NOW);
    ingestEvents(db, "i1", [deal("d1", "p1", "IN", "BUY", T0, 1), deal("d2", "p1", "OUT", "SELL", T0 + 10 * MIN, 1, 5)]);
    shares.set("i1", "strategy", "a", "public");
    shares.set("i1", "strategy", "b", "public");
    const ta = shares.ensureToken("i1", "strategy", "a");
    const tb = shares.ensureToken("i1", "strategy", "b");
    let clock = NOW;
    const cache = new TtlCache(60_000, 1000, () => clock);
    app = Fastify();
    registerPublic(app, { db, liveState: new LiveStateStore(), shares, cache, delayMs: DELAY, now: () => clock, computeBudgetPerMinute: 2 });
    await app.ready();
    const hit = async (token: string, path: string, ip = "198.51.100.1") => (await app.inject({ method: "GET", url: `/public/${token}${path}`, remoteAddress: ip }));

    expect((await hit(ta, "/stats?strategy=a")).statusCode).toBe(200);
    expect((await hit(ta, "/equity?strategy=a")).statusCode).toBe(200);
    expect((await hit(ta, "/performance?strategy=a")).statusCode).toBe(503);
    expect((await hit(ta, "/meta")).statusCode).toBe(200);
    expect((await hit(tb, "/stats?strategy=b", "203.0.113.5")).statusCode).toBe(200);

    clock += 90_000;
    const stale = await hit(ta, "/stats?strategy=a", "203.0.113.9");
    expect(stale.statusCode).toBe(200);
  });
});

describe("second review: no per-position open P&L", () => {
  it("an overview gets a count and a total, nothing per position", async () => {
    const { token } = await setup((db) => {
      const mark = db.prepare("INSERT INTO position_valuations (instance_id, broker, ticket, ts, symbol, side, qty, entry_price, current_price, profit, swap, strategy_id) VALUES ('i1','B',?,?, 'XAUUSD','BUY',1,4000,4010,?,0,'a')");
      mark.run("p1", CUT - MIN, -40);
      mark.run("p2", CUT - MIN, 15);
    }, { kind: "overview" });
    const state = (await get(token, "/live/state")).json as Record<string, unknown>;
    expect(state.positions).toEqual([]);
    expect(state.openPositions).toEqual({ count: 2, unrealized: -25 });
  });
});

describe("third review", () => {
  it("an admin change keeps serving unaffected links from their cached answers", async () => {
    const db = openDb(":memory:");
    const shares = new Shares(db);
    for (const id of ["a", "b"]) db.prepare("INSERT INTO strategies (instance_id, strategy_id, first_seen, last_seen, starting_balance, metadata) VALUES ('i1', ?, ?, ?, 10000, '{}')").run(id, T0, NOW);
    ingestEvents(db, "i1", [deal("d1", "p1", "IN", "BUY", T0, 1), deal("d2", "p1", "OUT", "SELL", T0 + 10 * MIN, 1, 5)]);
    shares.set("i1", "strategy", "a", "public");
    const ta = shares.expose("i1", "strategy", "a");
    const cache = new TtlCache(60_000, 1000, () => NOW);
    app = Fastify();
    registerPublic(app, { db, liveState: new LiveStateStore(), shares, cache, delayMs: DELAY, now: () => NOW, computeBudgetPerMinute: 1 });
    await app.ready();
    const hit = (path: string) => app.inject({ method: "GET", url: `/public/${ta}${path}` });
    expect((await hit("/stats?strategy=a")).statusCode).toBe(200);
    expect((await hit("/equity?strategy=a")).statusCode).toBe(503);
    const { invalidateShareScopes } = await import("../src/public.js");
    shares.set("i1", "strategy", "b", "public");
    invalidateShareScopes(cache);
    expect((await hit("/stats?strategy=a")).statusCode).toBe(200);
  });

  it("a link whose scope changed never gets its old answers, not even stale", async () => {
    const db = openDb(":memory:");
    const shares = new Shares(db);
    for (const id of ["a", "b"]) db.prepare("INSERT INTO strategies (instance_id, strategy_id, first_seen, last_seen, starting_balance, metadata) VALUES ('i1', ?, ?, ?, 10000, '{}')").run(id, T0, NOW);
    shares.set("i1", "overview", "", "public");
    const token = shares.expose("i1", "overview", "");
    const cache = new TtlCache(60_000, 1000, () => NOW);
    app = Fastify();
    registerPublic(app, { db, liveState: new LiveStateStore(), shares, cache, delayMs: DELAY, now: () => NOW, computeBudgetPerMinute: 1 });
    await app.ready();
    const list = async () => (await app.inject({ method: "GET", url: `/public/${token}/strategies` }));
    expect(((await list()).json() as Array<{ strategyId: string }>).map((s) => s.strategyId)).toEqual(["a", "b"]);
    const { invalidateShareScopes } = await import("../src/public.js");
    shares.set("i1", "strategy", "b", "private");
    invalidateShareScopes(cache);
    const after = await list();
    expect(after.statusCode).toBe(503);
    expect(after.body).not.toContain("\"b\"");
  });

  it("computation time is budgeted as well as request count", async () => {
    const db = openDb(":memory:");
    const shares = new Shares(db);
    db.prepare("INSERT INTO strategies (instance_id, strategy_id, first_seen, last_seen, starting_balance, metadata) VALUES ('i1', 'a', ?, ?, 10000, '{}')").run(T0, NOW);
    ingestEvents(db, "i1", [deal("d1", "p1", "IN", "BUY", T0, 1), deal("d2", "p1", "OUT", "SELL", T0 + 10 * MIN, 1, 5)]);
    shares.set("i1", "strategy", "a", "public");
    const token = shares.expose("i1", "strategy", "a");
    app = Fastify();
    registerPublic(app, { db, liveState: new LiveStateStore(), shares, cache: new TtlCache(60_000, 1000, () => NOW), delayMs: DELAY, now: () => NOW, computeMsPerMinute: 0.0001 });
    await app.ready();
    const hit = (path: string) => app.inject({ method: "GET", url: `/public/${token}${path}` });
    expect((await hit("/performance?strategy=a")).statusCode).toBe(200);
    expect((await hit("/stats?strategy=a")).statusCode).toBe(503);
  });
});
