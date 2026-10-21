import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import argon2 from "argon2";
import { openDb, ingestEvents, LiveStateStore, Sessions, tradingDayStart, type Db } from "@qkt-insights/store";
import type { Envelope } from "@qkt-insights/contract";
import { registerAuth } from "../src/auth.js";
import { registerRest } from "../src/rest.js";
import { accountToday, floatingByStrategy, limitUse, openRisk, riskRowFor, strategyPeriods } from "../../../apps/web/src/home";
import type { AccountRiskRow, AccountSummary, LiveStateSnapshot } from "../../../apps/web/src/api";

/*
 * Home's figures end to end: deals and account rollups in a real SQLite, read back over the real
 * routes Home calls (/account/summary, /account/risk, /live/state), then reduced by the same
 * functions the page uses. The day basis is a server day that starts 22:00 UTC.
 */

const I = "i1";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const LIMITS = { "*": { basis: "static" as const, startBalance: 10_000, dailyResetHour: 22, timezone: "UTC", dailyLossIncludesFloating: true, dailyLoss: 500, maxDrawdown: 1_000 } };

let app: FastifyInstance; let db: Db; let liveState: LiveStateStore; let session: string;
let now: number; let dayStart: number;

let seq = 0;
function roundTrip(strategyId: string | null, closeTs: number, profit: number, opts: { commission?: number; swap?: number } = {}): Envelope[] {
  const pos = `p${++seq}`;
  const leg = (entry: "IN" | "OUT", ts: number, p: number, extra: Record<string, number> = {}) => ({
    v: 1, instanceId: I, id: `deal-${pos}-${entry}`, seq: ++seq, ts, type: "broker.deal",
    payload: { broker: "ICM", dealTicket: `${pos}-${entry}`, positionTicket: pos, orderTicket: `o-${pos}-${entry}`, symbol: "ICM:XAUUSD",
      side: entry === "IN" ? "BUY" : "SELL", entry, qty: 0.1, price: 4000, profit: p, commission: 0, swap: 0, ...extra, ts, ...(strategyId ? { strategyId } : {}) },
  }) as unknown as Envelope;
  return [leg("IN", closeTs - HOUR, 0), leg("OUT", closeTs, profit, { commission: opts.commission ?? 0, swap: opts.swap ?? 0 })];
}

beforeEach(async () => {
  now = Date.now();
  dayStart = tradingDayStart(now, 22, "UTC");
  db = openDb(":memory:");
  // both strategies on the roster first: a deal of a strategy the instance never reported belongs elsewhere
  for (const id of ["gold", "silver"]) {
    db.prepare("INSERT INTO strategies (instance_id, strategy_id, first_seen, last_seen) VALUES (?, ?, ?, ?)").run(I, id, now - 30 * DAY, now);
  }
  ingestEvents(db, I, [
    // gold: +300 eight days ago, -200 three days ago, +50 just before the day began, +40 at its first ms (incl. -2 commission)
    ...roundTrip("gold", now - 8 * DAY, 300),
    ...roundTrip("gold", now - 3 * DAY, -200),
    ...roundTrip("gold", dayStart - MIN, 50),
    ...roundTrip("gold", dayStart, 42, { commission: -2 }),
    // silver: one loss today
    ...roundTrip("silver", dayStart, -30),
    // a close no strategy claimed
    ...roundTrip(null, now - 2 * DAY, -15),
  ]);
  const eq = db.prepare("INSERT INTO account_equity (instance_id, broker, minute_ts, balance, equity, open_profit, account) VALUES (?, 'ICM', ?, ?, ?, ?, '123@ICM-Live')");
  eq.run(I, dayStart - 10 * MIN, 9_800, 9_800, 0);
  eq.run(I, now - MIN, 9_812, 9_700, -112);
  liveState = new LiveStateStore();
  liveState.upsert(I, { v: 1, instanceId: I, id: "acct", seq: 1, ts: now, type: "state.account",
    payload: { broker: "ICM", currency: "USD", balance: 9_812, equity: 9_690, openProfit: -122, login: "123", server: "ICM-Live" } } as unknown as Envelope);
  liveState.upsert(I, { v: 1, instanceId: I, id: "pos", seq: 2, ts: now, type: "state.positions",
    payload: { broker: "ICM", positions: [
      // long 0.2 XAUUSD: 4000 -> 3995 = -100, so one price unit is worth 20; stop 3990 is 5 units (-100) away
      { ticket: "t1", symbol: "ICM:XAUUSD", side: "BUY", qty: 0.2, entryPrice: 4000, currentPrice: 3995, profit: -100, swap: -4, strategyId: "gold", stopLoss: 3990 },
      // short 0.1 at its entry: priced by its sibling's per-lot value (100), stop 4010 is 15 units (-150) away
      { ticket: "t2", symbol: "ICM_S05:XAUUSD", side: "SELL", qty: 0.1, entryPrice: 3995, currentPrice: 3995, profit: 0, swap: 0, strategyId: "silver", stopLoss: 4010 },
      // no stop: counted, never summed
      { ticket: "t3", symbol: "ICM:EURUSD", side: "BUY", qty: 1, entryPrice: 1.1, currentPrice: 1.0982, profit: -18, swap: 0, strategyId: null },
    ] } } as unknown as Envelope);

  app = Fastify();
  await app.register(cookie);
  registerAuth(app, { username: "admin", passwordHash: await argon2.hash("pw"), sessions: new Sessions(db) });
  registerRest(app, { db, liveState, accountLimits: LIMITS });
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

describe("Home figures over the real API", () => {
  it("puts Today on the account's day basis: realized since the server day began plus floating", async () => {
    const [risk, state] = await Promise.all([get<AccountRiskRow[]>(`/account/risk?instance=${I}`), get<LiveStateSnapshot>("/live/state")]);
    const account = state.accounts[0]!;
    const row = riskRowFor(account, risk)!;
    expect(row.account).toBe("123@ICM-Live");
    expect(row.dailyLoss.dayStart).toBe(dayStart);
    // 42 - 2 commission (gold) - 30 (silver); the +50 a minute before 22:00 belongs to yesterday
    expect(row.dailyLoss.realizedToday).toBeCloseTo(10, 9);
    const today = accountToday(account, row.dailyLoss.realizedToday);
    expect(today.floating).toBeCloseTo(-122, 9);
    expect(today.total).toBeCloseTo(-112, 9);
  });

  it("re-marks the daily loss and static drawdown to the live equity against the account's own limits", async () => {
    const [risk, state] = await Promise.all([get<AccountRiskRow[]>(`/account/risk?instance=${I}`), get<LiveStateSnapshot>("/live/state")]);
    const row = riskRowFor(state.accounts[0]!, risk)!;
    expect(row.basis).toBe("static");
    const use = limitUse(row, state.accounts[0]!.equity);
    // day-start balance 9,800 minus live equity 9,690, floating included
    expect(use.daily).toEqual({ used: 110, cap: 500, pct: 22 });
    // start balance 10,000 minus live equity 9,690
    expect(use.drawdown).toEqual({ used: 310, cap: 1_000, pct: 31 });
  });

  it("sums open risk to the stops in money, counting positions without a stop apart", async () => {
    const state = await get<LiveStateSnapshot>("/live/state");
    const risk = openRisk(state.positions.flatMap((g) => g.list));
    expect(risk.toStops).toBeCloseTo(-250, 9);
    expect(risk.priced).toBe(2);
    expect(risk.noStop).toBe(1);
    expect(risk.unpriced).toBe(0);
    expect(risk.floating).toBeCloseTo(-122, 9);
  });

  it("sums each strategy's periods from every close on the account, unattributed included", async () => {
    const [summary, risk, state] = await Promise.all([
      get<AccountSummary>(`/account/summary?instance=${I}`), get<AccountRiskRow[]>(`/account/risk?instance=${I}`), get<LiveStateSnapshot>("/live/state"),
    ]);
    const periods = strategyPeriods(summary.closes, { now, dayStart: riskRowFor(state.accounts[0]!, risk)!.dailyLoss.dayStart, floating: floatingByStrategy(state.positions.flatMap((g) => g.list)) });
    const gold = periods.get("gold")!;
    expect(gold.todayRealized).toBeCloseTo(40, 9);
    expect(gold.floating).toBeCloseTo(-104, 9);
    expect(gold.today).toBeCloseTo(-64, 9);
    expect(gold.d7).toBeCloseTo(-110, 9);
    expect(gold.all).toBeCloseTo(190, 9);
    // peak +300, trough +100
    expect(gold.maxDd).toBeCloseTo(200, 9);
    expect(gold.trades).toBe(4);
    expect(gold.winRate).toBeCloseTo(0.75, 9);
    expect(gold.lastTs).toBe(dayStart);
    const silver = periods.get("silver")!;
    expect(silver.today).toBeCloseTo(-30, 9);
    expect(silver.maxDd).toBeCloseTo(30, 9);
    const unattributed = periods.get(null)!;
    expect(unattributed.all).toBeCloseTo(-15, 9);
    expect(unattributed.floating).toBeCloseTo(-18, 9);
    // the rows add up to the account total the summary reports
    const all = [...periods.values()].reduce((a, r) => a + r.all, 0);
    expect(all).toBeCloseTo(summary.totalNet, 9);
    expect([...periods.values()].reduce((a, r) => a + r.trades, 0)).toBe(summary.trades);
  });
});
