import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import argon2 from "argon2";
import { openDb, ingestEvents, listDeals, listStrategies, LiveStateStore, Sessions, Shares, type Db } from "@qkt-insights/store";
import type { Envelope } from "@qkt-insights/contract";
import { registerAuth } from "../src/auth.js";
import { registerPublic, registerShares } from "../src/public.js";
import { TtlCache } from "../src/cache.js";

const MIN = 60_000;
const NOW = Date.UTC(2026, 8, 15, 12, 0);
const DELAY = 15 * MIN;
const BEFORE = NOW - 60 * MIN;
const AFTER = NOW - 5 * MIN;

/** Values that must never reach a public response. */
const SECRETS = ["EXNESS", "exness_p549", "/strategies/gold.qkt", "deadbeefsha", "stopAtr", "476422618", "Exness-MT5Trial9", "forward-test", "dsl-", "777123", "ticket-before", "pos-before"];

let hash: string;
let app: FastifyInstance;
let db: Db;
let shares: Shares;
let session: string;

function strategy(id: string, metadata: Record<string, unknown>) {
  db.prepare("INSERT INTO strategies (instance_id, strategy_id, first_seen, last_seen, starting_balance, metadata) VALUES ('i1', ?, ?, ?, 10000, ?)")
    .run(id, BEFORE - MIN, NOW, JSON.stringify({ strategyId: id, ...metadata }));
}

function deal(strategyId: string, ticket: string, position: string, entry: "IN" | "OUT", ts: number, profit = 0): Envelope {
  return {
    v: 1, instanceId: "i1", id: `deal-${ticket}`, seq: 1, ts, type: "broker.deal",
    payload: { broker: "EXNESS_P549", dealTicket: ticket, positionTicket: position, orderTicket: `order-${ticket}`, symbol: "EXNESS_P549:GBPUSD", side: entry === "IN" ? "BUY" : "SELL", entry, qty: 1, price: 1.35, profit, commission: 0, swap: 0, magic: 777123, comment: "dsl-gold--1", strategyId, ts },
  } as Envelope;
}

function trade(strategyId: string, id: string, ts: number): Envelope {
  return { v: 1, instanceId: "i1", id, seq: 1, ts, strategyId, type: "trade", payload: { orderId: `ticket-${id}`, symbol: "EXNESS_P549:GBPUSD", side: "BUY", price: 1.35, qty: 1, ts } } as Envelope;
}

async function build(opts: { publicRequestsPerMinute?: number } = {}) {
  db = openDb(":memory:");
  shares = new Shares(db);
  strategy("gold", {
    dslName: "gold_breakout", sourcePath: "/strategies/gold.qkt", sourceSha256: "deadbeefsha",
    brokers: ["exness_p549"], symbols: ["EXNESS_P549:GBPUSD"], params: { stopAtr: 3 },
    risk: { maxDrawdownPct: 0.15, maxDailyDrawdownPct: 0.06, perStrategyMaxDailyLoss: 15000 },
  });
  strategy("book:s0", { dslName: "leg_a", portfolioId: "book", portfolioWeight: 0.5, allocatedCapital: 5000 });
  strategy("book_2:s1", { dslName: "leg_b", portfolioId: "book_2", portfolioWeight: 0.5, allocatedCapital: 5000 });
  strategy("secret", { dslName: "secret_sauce" });
  ingestEvents(db, "i1", [
    deal("gold", "g1", "pos-before", "IN", BEFORE - 10 * MIN), deal("gold", "g2", "pos-before", "OUT", BEFORE, 25),
    deal("gold", "g3", "pos-after", "IN", BEFORE + 10 * MIN), deal("gold", "g4", "pos-after", "OUT", AFTER, -40),
    deal("secret", "s1", "pos-secret", "IN", BEFORE - 10 * MIN), deal("secret", "s2", "pos-secret", "OUT", BEFORE, 999),
    trade("gold", "before", BEFORE), trade("gold", "open", BEFORE + 10 * MIN), trade("gold", "after", AFTER), trade("secret", "secret-trade", BEFORE),
  ]);
  // Engine orders linked to broker tickets: the close of pos-before, and the entry of pos-after (still open at the cutoff).
  const order = db.prepare("INSERT INTO orders (instance_id, order_id, strategy_id, symbol, side, type, state, qty, cum_qty, created_ts, updated_ts, broker_order_id) VALUES ('i1', ?, 'gold', 'EXNESS_P549:GBPUSD', 'BUY', 'MARKET', 'FILLED', 1, 1, ?, ?, ?)");
  order.run("ticket-before", BEFORE, BEFORE, "order-g2");
  order.run("ticket-open", BEFORE + 10 * MIN, BEFORE + 10 * MIN, "order-g3");
  const eq = db.prepare("INSERT INTO account_equity (instance_id, broker, minute_ts, balance, equity, open_profit) VALUES ('i1', 'EXNESS_P549', ?, ?, ?, 0)");
  eq.run(BEFORE, 10000, 10000);
  eq.run(NOW - 20 * MIN, 10025, 10025);
  eq.run(AFTER, 9985, 9950);
  const liveState = new LiveStateStore();
  liveState.upsert("i1", { v: 1, instanceId: "i1", id: "a", seq: 1, ts: NOW, type: "state.account",
    payload: { broker: "EXNESS_P549", currency: "USD", balance: 9985, equity: 9950, margin: 12, marginLevel: 80000, openProfit: -35, login: "476422618", server: "Exness-MT5Trial9", name: "forward-test" } } as unknown as Envelope);
  liveState.upsert("i1", { v: 1, instanceId: "i1", id: "p", seq: 2, ts: NOW, type: "state.positions",
    payload: { broker: "EXNESS_P549", positions: [
      { ticket: "ticket-old", symbol: "EXNESS_P549:GBPUSD", side: "SELL", qty: 1.23, entryPrice: 1.3525, profit: 50, openedAt: BEFORE, strategyId: "gold", stopLoss: 1.39, magic: 777123 },
      { ticket: "ticket-new", symbol: "EXNESS_P549:GBPUSD", side: "BUY", qty: 2, entryPrice: 1.35, profit: -3, openedAt: AFTER, strategyId: "gold" },
      { ticket: "ticket-secret", symbol: "EXNESS_P549:XAUUSD", side: "BUY", qty: 1, entryPrice: 4300, profit: 500, openedAt: BEFORE, strategyId: "secret" },
    ] } } as unknown as Envelope);

  // Stored marks, as the collector persists them from every state.positions poll.
  const markRow = db.prepare("INSERT INTO position_valuations (instance_id, broker, ticket, ts, symbol, side, qty, entry_price, current_price, profit, swap, strategy_id) VALUES ('i1','EXNESS_P549',?,?,'EXNESS_P549:GBPUSD','SELL',1.23,1.3525,1.35,?,0,?)");
  markRow.run("ticket-old", NOW - DELAY - MIN, 12, "gold");
  markRow.run("ticket-old", AFTER, 50, "gold");
  markRow.run("ticket-new", AFTER, -3, "gold");
  markRow.run("ticket-secret", NOW - DELAY - MIN, 500, "secret");

  app = Fastify();
  await app.register(cookie);
  hash ??= await argon2.hash("admin-password-long");
  registerAuth(app, { username: "admin", passwordHash: hash, sessions: new Sessions(db) });
  const cache = new TtlCache(30_000, 500, () => NOW);
  registerShares(app, { db, shares, cache });
  registerPublic(app, { db, liveState, shares, cache, delayMs: DELAY, now: () => NOW, requestsPerMinute: opts.publicRequestsPerMinute });
  await app.ready();
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "admin", password: "admin-password-long" } });
  session = String(login.headers["set-cookie"]).split(";")[0]!;
}

function admin(method: "GET" | "PUT" | "POST", url: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method, url, payload: payload as never, headers: { cookie: session, ...headers } });
}

async function share(kind: "overview" | "portfolio" | "strategy", subject: string, visibility: "public" | "private" | null) {
  const res = await admin("PUT", "/shares", { instance: "i1", kind, subject, visibility });
  expect(res.statusCode).toBe(200);
  return res.json() as SharesView;
}

interface ShareState { visibility: "public" | "private" | null; effective: boolean; token: string | null }
interface SharesView { overview: ShareState; portfolios: Array<ShareState & { id: string }>; strategies: Array<ShareState & { id: string }> }

function pub(token: string, path: string) {
  return app.inject({ method: "GET", url: `/public/${token}${path}` });
}

function expectNoSecrets(body: string) {
  for (const s of SECRETS) expect(body, `leaked ${s}`).not.toContain(s);
}

beforeEach(() => build());
afterEach(async () => { await app.close(); });

describe("share management", () => {
  it("requires a session", async () => {
    expect((await app.inject({ method: "GET", url: "/shares?instance=i1" })).statusCode).toBe(401);
    expect((await app.inject({ method: "PUT", url: "/shares", payload: { instance: "i1", kind: "overview", subject: "", visibility: "public" } })).statusCode).toBe(401);
  });

  it("refuses cross-origin writes", async () => {
    const res = await admin("PUT", "/shares", { instance: "i1", kind: "overview", subject: "", visibility: "public" }, { origin: "https://evil.example", host: "forward.example" });
    expect(res.statusCode).toBe(403);
  });

  it("is private everywhere by default, with no tokens handed out", async () => {
    const view = (await admin("GET", "/shares?instance=i1")).json() as SharesView;
    expect(view.overview).toEqual({ visibility: null, effective: false, token: null, views: 0 });
    expect(view.strategies.every((s) => !s.effective && s.token == null)).toBe(true);
  });

  it("a public overview makes strategies public unless set otherwise, and hands out their tokens", async () => {
    await share("strategy", "secret", "private");
    const view = await share("overview", "", "public");
    expect(view.overview.effective).toBe(true);
    expect(view.overview.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const byId = new Map(view.strategies.map((s) => [s.id, s]));
    expect(byId.get("gold")).toMatchObject({ visibility: null, effective: true });
    expect(byId.get("gold")!.token).toBeTruthy();
    expect(byId.get("secret")).toMatchObject({ visibility: "private", effective: false, token: null });
    expect(view.portfolios).toEqual([expect.objectContaining({ id: "book", effective: true })]);
  });

  it("rejects subjects that do not exist", async () => {
    expect((await admin("PUT", "/shares", { instance: "i1", kind: "strategy", subject: "nope", visibility: "public" })).statusCode).toBe(404);
    expect((await admin("PUT", "/shares", { instance: "i1", kind: "overview", subject: "", visibility: "sideways" })).statusCode).toBe(400);
  });
});

describe("public links", () => {
  it("the leak scan has something to find: the seeded admin data carries every secret", () => {
    const raw = JSON.stringify([listStrategies(db, "i1"), listDeals(db, { instanceId: "i1", limit: 100 })]);
    for (const s of ["EXNESS", "exness_p549", "/strategies/gold.qkt", "deadbeefsha", "stopAtr", "dsl-", "777123", "pos-before"]) expect(raw).toContain(s);
  });

  it("answers an unknown token and a private subject's token with the same 404", async () => {
    const view = await share("strategy", "gold", "public");
    const token = view.strategies.find((s) => s.id === "gold")!.token!;
    await share("strategy", "gold", "private");
    const privateRes = await pub(token, "/meta");
    const unknownRes = await pub("A".repeat(32), "/meta");
    expect(privateRes.statusCode).toBe(404);
    expect(unknownRes.statusCode).toBe(404);
    expect(privateRes.body).toBe(unknownRes.body);
  });

  it("rotating a link kills the old token at once", async () => {
    const view = await share("overview", "", "public");
    const old = view.overview.token!;
    expect((await pub(old, "/meta")).statusCode).toBe(200);
    const rotated = (await admin("POST", "/shares/rotate", { instance: "i1", kind: "overview", subject: "" })).json() as SharesView;
    expect(rotated.overview.token).not.toBe(old);
    expect((await pub(old, "/meta")).statusCode).toBe(404);
    expect((await pub(rotated.overview.token!, "/meta")).statusCode).toBe(200);
  });

  it("describes the link and its delay", async () => {
    const token = (await share("overview", "", "public")).overview.token!;
    expect((await pub(token, "/meta")).json()).toEqual({ kind: "overview", instanceId: "i1", subject: "", delayMinutes: 15, asOf: NOW - DELAY });
  });

  it("an overview link lists only public strategies, with metadata cut to the allow-list", async () => {
    await share("strategy", "secret", "private");
    const token = (await share("overview", "", "public")).overview.token!;
    const res = await pub(token, "/strategies?instance=other");
    const rows = res.json() as Array<{ strategyId: string; metadata: Record<string, unknown>; realizedNet: number; dealCount: number }>;
    expect(rows.map((r) => r.strategyId).sort()).toEqual(["book:s0", "book_2:s1", "gold"]);
    const gold = rows.find((r) => r.strategyId === "gold")!;
    expect(gold.metadata).toEqual({ dslName: "gold_breakout", symbols: ["GBPUSD"], risk: { maxDrawdownPct: 0.15, maxDailyDrawdownPct: 0.06 } });
    expect(gold.realizedNet).toBe(25);
    expect(gold.dealCount).toBe(1);
    expectNoSecrets(res.body);
  });

  it("keeps a strategy's live halt state off shared links", async () => {
    ingestEvents(db, "i1", [{
      v: 1, instanceId: "i1", id: "halt-gold", seq: 2, ts: BEFORE, strategyId: "gold", type: "risk.halted",
      payload: { strategyId: "gold", reason: "max drawdown breached", scope: "PERSISTENT", persistent: true },
    } as Envelope]);
    expect(listStrategies(db, "i1", NOW).find((r) => r.strategyId === "gold")!.halted).toBe(true);
    const token = (await share("overview", "", "public")).overview.token!;
    const res = await pub(token, "/strategies");
    const gold = (res.json() as Array<Record<string, unknown>>).find((r) => r.strategyId === "gold")!;
    for (const k of ["halted", "haltReason", "haltScope", "haltPersistent", "haltedAt"]) expect(gold).not.toHaveProperty(k);
    expect(res.body).not.toContain("max drawdown breached");
  });

  it("every overview endpoint stops at the cutoff and leaks nothing", async () => {
    await share("strategy", "secret", "private");
    const token = (await share("overview", "", "public")).overview.token!;
    const cutoff = NOW - DELAY;
    const q = "?instance=i1&strategy=gold";

    const stats = (await pub(token, `/stats${q}`)).json() as { realizedPnl: number; tradeCount: number };
    expect(stats).toMatchObject({ realizedPnl: 25, tradeCount: 1 });

    const perf = await pub(token, `/performance${q}`);
    const bundle = perf.json() as { closes: Array<{ ts: number; symbol: string; orderId: string }>; dailyNets: Array<{ net: number }> };
    expect(bundle.closes.map((c) => c.ts)).toEqual([BEFORE]);
    expect(bundle.closes[0]!.symbol).toBe("GBPUSD");
    expect(bundle.closes[0]!.orderId).toMatch(/^[0-9a-f]{16}$/);
    expect(bundle.dailyNets.reduce((a, d) => a + d.net, 0)).toBe(25);

    // Only fills of positions closed by the cutoff: the fill opening pos-after (open at the cutoff) stays hidden.
    const trades = (await pub(token, "/trades?instance=i1&limit=100")).json() as Array<{ ts: number; strategyId: string; payload: { symbol: string } }>;
    expect(trades.map((t) => [t.strategyId, t.ts])).toEqual([["gold", BEFORE]]);
    expect(trades[0]!.payload.symbol).toBe("GBPUSD");

    const deals = (await pub(token, "/deals?instance=i1&limit=100")).json() as Array<{ ts: number; magic: unknown; comment: unknown; broker: string }>;
    // Both legs of pos-before; the IN of pos-after happened before the cutoff but its position was still open then.
    expect(deals.every((d) => d.ts <= cutoff)).toBe(true);
    expect(deals.map((d) => d.ts).sort()).toEqual([BEFORE - 10 * MIN, BEFORE]);
    expect(deals.every((d) => d.magic === null && d.comment === null && d.broker === "Account")).toBe(true);

    const equity = (await pub(token, `/equity${q}`)).json() as Array<{ ts: number }>;
    expect(equity.length).toBeGreaterThan(0);
    expect(equity.every((p) => p.ts <= cutoff)).toBe(true);

    const account = (await pub(token, "/account/equity?instance=i1")).json() as Array<{ minuteTs: number; broker: string }>;
    expect(account.map((p) => p.minuteTs)).toEqual([BEFORE, NOW - 20 * MIN]);
    expect(account.every((p) => p.broker === "Account")).toBe(true);

    const dd = (await pub(token, "/account/drawdown?instance=i1")).json() as Array<{ currentEquity: number }>;
    expect(dd[0]!.currentEquity).toBe(10025);

    for (const res of [perf]) expectNoSecrets(res.body);
    for (const path of [`/stats${q}`, "/trades?limit=100", "/deals?limit=100", `/equity${q}`, "/account/equity", "/account/drawdown", "/live/state", "/strategies", "/meta"]) {
      expectNoSecrets((await pub(token, path)).body);
    }
  });

  it("refuses a strategy outside the link's public set", async () => {
    await share("strategy", "secret", "private");
    const token = (await share("overview", "", "public")).overview.token!;
    for (const path of ["/stats?strategy=secret", "/equity?strategy=secret", "/performance?strategy=secret", "/trades?strategy=secret", "/deals?strategy=secret"]) {
      expect((await pub(token, path)).statusCode, path).toBe(404);
    }
  });

  it("shows account state without identity, and open positions only as a count and total marked at the cutoff", async () => {
    await share("strategy", "secret", "private");
    const token = (await share("overview", "", "public")).overview.token!;
    const state = (await pub(token, "/live/state")).json() as {
      accounts: Array<Record<string, unknown>>;
      positions: unknown[];
      orders: unknown[];
      openPositions: { count: number; unrealized: number };
    };
    expect(state.accounts).toEqual([{ instanceId: "i1", broker: "Account", currency: "USD", balance: 10025, equity: 10025, openProfit: 0, lastSeen: NOW - 20 * MIN, stale: false }]);
    expect(state.positions).toEqual([]);
    expect(state.orders).toEqual([]);
    // ticket-old at its cutoff mark (12, not the live 50); ticket-new was only marked after the cutoff; the secret strategy is excluded.
    expect(state.openPositions).toEqual({ count: 1, unrealized: 12 });
    expect((state as unknown as { openByStrategy: Record<string, number> }).openByStrategy).toEqual({ gold: 12 });
  });

  it("a strategy link exposes only that strategy and no account-level data", async () => {
    const token = (await share("strategy", "gold", "public")).strategies.find((s) => s.id === "gold")!.token!;
    expect(((await pub(token, "/strategies")).json() as Array<{ strategyId: string }>).map((r) => r.strategyId)).toEqual(["gold"]);
    expect((await pub(token, "/stats?strategy=book:s0")).statusCode).toBe(404);
    expect((await pub(token, "/account/equity")).statusCode).toBe(404);
    expect((await pub(token, "/account/drawdown")).statusCode).toBe(404);
    const state = (await pub(token, "/live/state")).json() as { accounts: unknown[] };
    expect(state.accounts).toEqual([]);
  });

  it("a portfolio link exposes its public children only", async () => {
    await share("strategy", "book_2:s1", "private");
    const token = (await share("portfolio", "book", "public")).portfolios.find((p) => p.id === "book")!.token!;
    expect(((await pub(token, "/strategies")).json() as Array<{ strategyId: string }>).map((r) => r.strategyId)).toEqual(["book:s0"]);
    expect((await pub(token, "/stats?strategy=gold")).statusCode).toBe(404);
    expect((await pub(token, "/account/equity")).statusCode).toBe(404);
  });

  it("offers no logs, health, search, orders or instance list", async () => {
    const token = (await share("overview", "", "public")).overview.token!;
    for (const path of ["/logs?instance=i1", "/health/instances", "/search?q=gold", "/orders?instance=i1", "/instances", "/health/monitors", "/ingest/observations?instance=i1"]) {
      expect((await pub(token, path)).statusCode, path).toBe(404);
    }
  });

  it("throttles public requests per IP", async () => {
    await app.close();
    await build({ publicRequestsPerMinute: 3 });
    const token = (await share("overview", "", "public")).overview.token!;
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await pub(token, "/meta")).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
  });
});

describe("revocation through the admin route", () => {
  it("making a subject private regenerates its link and those that inherited through it", async () => {
    const before = await share("overview", "", "public");
    const overviewToken = before.overview.token!;
    const goldToken = before.strategies.find((s) => s.id === "gold")!.token!;
    await share("overview", "", "private");
    const again = await share("overview", "", "public");
    expect(again.overview.token).not.toBe(overviewToken);
    expect(again.strategies.find((s) => s.id === "gold")!.token).not.toBe(goldToken);
    expect((await pub(overviewToken, "/meta")).statusCode).toBe(404);
    expect((await pub(goldToken, "/meta")).statusCode).toBe(404);
  });

  it("a subject that stays public keeps its link when an unrelated setting changes", async () => {
    const before = await share("strategy", "gold", "public");
    const goldToken = before.strategies.find((s) => s.id === "gold")!.token!;
    const after = await share("overview", "", "public");
    expect(after.strategies.find((s) => s.id === "gold")!.token).toBe(goldToken);
  });
});

describe("revocation without an admin change", () => {
  it("a strategy that stops being public through its metadata loses its link for good", async () => {
    const view = await share("overview", "", "public");
    const goldToken = view.strategies.find((s) => s.id === "gold")!.token!;
    await share("portfolio", "book", "private");
    expect((await pub(goldToken, "/meta")).statusCode).toBe(200);
    // gold's deploy metadata moves it into the private portfolio.
    db.prepare("UPDATE strategies SET metadata=json_set(metadata,'$.portfolioId','book') WHERE strategy_id='gold'").run();
    const { sweepHiddenShares } = await import("../src/public.js");
    expect(sweepHiddenShares(db, shares)).toBe(1);
    db.prepare("UPDATE strategies SET metadata=json_remove(metadata,'$.portfolioId') WHERE strategy_id='gold'").run();
    expect((await pub(goldToken, "/meta")).statusCode).toBe(404);
  });
});


describe("account labels on a public overview", () => {
  it("shows one account when the account was polled under several broker labels over time", async () => {
    db.prepare("INSERT INTO account_equity (instance_id, broker, minute_ts, balance, equity, open_profit) VALUES ('i1', 'EXNESS', ?, 9000, 9000, 0)").run(BEFORE - 3 * 60 * MIN);
    const token = (await share("overview", "", "public")).overview.token!;
    const state = (await pub(token, "/live/state")).json() as { accounts: Array<{ broker: string }> };
    expect(state.accounts.map((a) => a.broker)).toEqual(["Account"]);
    const curve = (await pub(token, "/account/equity")).json() as Array<{ broker: string }>;
    expect([...new Set(curve.map((p) => p.broker))]).toEqual(["Account"]);
    const dd = (await pub(token, "/account/drawdown")).json() as Array<{ broker: string }>;
    expect(dd.every((r) => r.broker === "Account" || r.broker === "TOTAL")).toBe(true);
  });
});
