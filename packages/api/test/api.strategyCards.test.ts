import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import argon2 from "argon2";
import { openDb, ingestEvents, LiveStateStore, Sessions, tradingDayStart, type Db } from "@qkt-insights/store";
import type { Envelope } from "@qkt-insights/contract";
import { registerAuth } from "../src/auth.js";
import { registerRest } from "../src/rest.js";
import { floatingByStrategy, strategyLines, strategyPeriods } from "../../../apps/web/src/home";
import { cardFigures, cardGroups, realizedCurves } from "../../../apps/web/src/strategyCards";
import type { AccountSummary, LiveStateSnapshot, StrategyRow, StrategyStats } from "../../../apps/web/src/api";

/*
 * The Strategies page's cards end to end: deals and live positions in a real SQLite, read back over
 * the real routes, reduced by the functions the page uses, and checked against what the strategy
 * page itself shows (/strategies realized, /stats trades and win rate, open P&L from /live/state).
 */

const I = "i1";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let app: FastifyInstance; let db: Db; let session: string; let now: number;

let seq = 0;
function roundTrip(strategyId: string | null, closeTs: number, profit: number, commission = 0): Envelope[] {
  const pos = `p${++seq}`;
  const leg = (entry: "IN" | "OUT", ts: number, p: number, c: number) => ({
    v: 1, instanceId: I, id: `deal-${pos}-${entry}`, seq: ++seq, ts, type: "broker.deal",
    payload: { broker: "ICM", dealTicket: `${pos}-${entry}`, positionTicket: pos, orderTicket: `o-${pos}-${entry}`, symbol: "ICM:XAUUSD",
      side: entry === "IN" ? "BUY" : "SELL", entry, qty: 0.1, price: 4000, profit: p, commission: c, swap: 0, ts, ...(strategyId ? { strategyId } : {}) },
  }) as unknown as Envelope;
  return [leg("IN", closeTs - HOUR, 0, 0), leg("OUT", closeTs, profit, commission)];
}

beforeEach(async () => {
  now = Date.now();
  db = openDb(":memory:");
  const add = db.prepare("INSERT INTO strategies (instance_id, strategy_id, first_seen, last_seen, metadata) VALUES (?, ?, ?, ?, ?)");
  add.run(I, "gold", now - 30 * DAY, now, null);
  add.run(I, "book:s0", now - 30 * DAY, now, JSON.stringify({ portfolioId: "book", dslName: "eur_fade", allocatedCapital: 5_000 }));
  add.run(I, "book:s1", now - 30 * DAY, now, JSON.stringify({ portfolioId: "book_2", dslName: "gbp_break", allocatedCapital: 5_000 }));
  ingestEvents(db, I, [
    ...roundTrip("gold", now - 9 * DAY, 300),
    ...roundTrip("gold", now - 4 * DAY, -200),
    ...roundTrip("gold", now - 2 * DAY, 0),
    ...roundTrip("gold", now - HOUR, 42.5, -2.25),
    ...roundTrip("book:s0", now - 3 * DAY, 80),
    ...roundTrip("book:s1", now - 2 * DAY, -25),
    ...roundTrip(null, now - DAY, -15),
  ]);
  const liveState = new LiveStateStore();
  liveState.upsert(I, { v: 1, instanceId: I, id: "acct", seq: 1, ts: now, type: "state.account",
    payload: { broker: "ICM", currency: "USD", balance: 10_000, equity: 9_950, openProfit: -50, login: "123", server: "ICM-Live" } } as unknown as Envelope);
  liveState.upsert(I, { v: 1, instanceId: I, id: "pos", seq: 2, ts: now, type: "state.positions",
    payload: { broker: "ICM", positions: [
      { ticket: "t1", symbol: "ICM:XAUUSD", side: "BUY", qty: 0.2, entryPrice: 4000, currentPrice: 3998, profit: -40, swap: -1.5, strategyId: "gold" },
      { ticket: "t2", symbol: "ICM:EURUSD", side: "BUY", qty: 1, entryPrice: 1.1, currentPrice: 1.1007, profit: 7, swap: 0, strategyId: "book:s0" },
    ] } } as unknown as Envelope);

  app = Fastify();
  await app.register(cookie);
  registerAuth(app, { username: "admin", passwordHash: await argon2.hash("pw"), sessions: new Sessions(db) });
  registerRest(app, { db, liveState });
  await app.ready();
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "admin", password: "pw" } });
  session = String(login.headers["set-cookie"]).split(";")[0]!;
});
afterEach(async () => { await app.close(); });

async function get<T>(url: string): Promise<T> {
  const res = await app.inject({ method: "GET", url, headers: { cookie: session } });
  expect(res.statusCode).toBe(200);
  return res.json() as T;
}

async function cards() {
  const [rows, summary, state] = await Promise.all([
    get<StrategyRow[]>(`/strategies?instance=${I}`), get<AccountSummary>(`/account/summary?instance=${I}`), get<LiveStateSnapshot>("/live/state"),
  ]);
  const positions = state.positions.filter((g) => g.instanceId === I).flatMap((g) => g.list);
  const periods = strategyPeriods(summary.closes, { now, dayStart: tradingDayStart(now, 0, "UTC"), floating: floatingByStrategy(positions) });
  return { rows, summary, positions, lines: strategyLines(rows, periods), curves: realizedCurves(summary.closes, { now }) };
}

describe("Strategy cards over the real API", () => {
  it("shows each strategy's figures exactly as /strategies, /stats and the live positions give them", async () => {
    const { rows, lines, positions, curves } = await cards();
    for (const row of rows) {
      const line = lines.find((l) => l.key === row.strategyId)!;
      const card = cardFigures(line);
      const stats = await get<StrategyStats>(`/stats?instance=${I}&strategy=${encodeURIComponent(row.strategyId)}`);
      const open = positions.filter((p) => p.strategyId === row.strategyId).reduce((a, p) => a + (p.profit ?? 0) + (p.swap ?? 0), 0);
      expect(card.realized).toBeCloseTo(row.realizedNet ?? 0, 9);
      expect(card.realized).toBeCloseTo(stats.realizedPnl ?? 0, 9);
      expect(card.floating).toBeCloseTo(open, 9);
      expect(card.net).toBeCloseTo((stats.realizedPnl ?? 0) + open, 9);
      expect(card.trades).toBe(stats.tradeCount);
      expect(card.winRate).toBe(stats.winRate);
      // the sparkline ends where the realized figure does
      expect(curves.get(row.strategyId)!.at(-1)).toBeCloseTo(card.realized, 9);
    }
    const gold = cardFigures(lines.find((l) => l.key === "gold")!);
    // 300 - 200 + 0 + 42.50 - 2.25 realized, -41.50 open
    expect(gold.realized).toBeCloseTo(140.25, 9);
    expect(gold.net).toBeCloseTo(98.75, 9);
    // the breakeven close is no win and no loss
    expect(gold.winRate).toBeCloseTo(2 / 3, 9);
    expect(gold.maxDd).toBeCloseTo(200, 9);
    expect(gold.base).toBeNull();
  });

  it("groups shards of one portfolio into one card whose net and base are its sleeves' sums", async () => {
    const { lines, summary } = await cards();
    const { portfolios, standalone } = cardGroups(lines);
    expect(portfolios.map((p) => p.id)).toEqual(["book"]);
    const book = portfolios[0]!;
    expect(book.children.map((c) => c.key).sort()).toEqual(["book:s0", "book:s1"]);
    expect(book.net).toBeCloseTo(80 + 7 - 25, 9);
    expect(book.base).toBe(10_000);
    expect(book.trades).toBe(2);
    expect(standalone.map((l) => l.key)).toEqual(["gold", null]);
    // every card together adds up to the account
    const realized = lines.reduce((a, l) => a + cardFigures(l).realized, 0);
    expect(realized).toBeCloseTo(summary.totalNet, 9);
  });
});
