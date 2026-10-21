import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import argon2 from "argon2";
import { openDb, ingestEvents, LiveStateStore, Sessions, type Db } from "@qkt-insights/store";
import type { Envelope } from "@qkt-insights/contract";
import { registerAuth } from "../src/auth.js";
import { registerRest } from "../src/rest.js";
import { strategyPeriods } from "../../../apps/web/src/home";
import type { AccountSummary } from "../../../apps/web/src/api";

/*
 * A drill-down lists exactly what the figure clicked counts: the number and net printed on a
 * calendar day, an analytics bucket or a Home strategy row equal the "Showing k of n · net" of
 * the list the click opens (the same query token over /round-trips). The fixture has trades that
 * open one UTC day and close the next, costs on the closing leg, both sides, every exit kind and
 * a close no strategy claimed.
 */

const I = "drill";
const MIN = 60_000, H = 60 * MIN, D = 24 * H;
const T0 = Date.UTC(2026, 8, 7, 0); // a Monday
const STRATEGIES = ["gold", "silver"];

let seq = 0;
function trip(strategyId: string | null, entryTs: number, exitTs: number, long: boolean, profit: number, comment: string, costs: { commission?: number; swap?: number } = {}): Envelope[] {
  const pos = `p${++seq}`;
  const leg = (entry: "IN" | "OUT", ts: number, p: number, extra: Record<string, number> = {}) => ({
    v: 1, instanceId: I, id: `deal-${pos}-${entry}`, seq: ++seq, ts, type: "broker.deal",
    payload: {
      broker: "ICMARKETS", dealTicket: `${pos}-${entry}`, positionTicket: pos, orderTicket: `o-${pos}-${entry}`, symbol: "ICMARKETS:XAUUSD",
      side: (entry === "IN") === long ? "BUY" : "SELL", entry, qty: 0.1, price: 4000, profit: p, commission: 0, swap: 0,
      comment: entry === "OUT" ? comment : "", ...extra, ts, ...(strategyId ? { strategyId } : {}),
    },
  }) as unknown as Envelope;
  return [leg("IN", entryTs, 0), leg("OUT", exitTs, profit, { commission: costs.commission ?? 0, swap: costs.swap ?? 0 })];
}

let app: FastifyInstance; let db: Db; let session: string;

beforeEach(async () => {
  seq = 0;
  db = openDb(":memory:");
  for (const s of STRATEGIES) db.prepare("INSERT INTO strategies (instance_id, strategy_id, first_seen, last_seen) VALUES (?, ?, ?, ?)").run(I, s, T0, T0);
  const events: Envelope[] = [];
  const ends = ["[tp 4010]", "[sl 3990]", ""];
  for (let n = 0; n < 24; n++) {
    const strategy = n % 5 === 4 ? null : STRATEGIES[n % 2]!;
    // entries late in the evening, exits after midnight on every third trade: a trade belongs to its exit day
    const entry = T0 + Math.floor(n / 3) * D + (n % 3 === 0 ? 23 * H + 30 * MIN : (n % 24) * 37 * MIN + 2 * H);
    const exit = entry + (n % 3 === 0 ? 50 * MIN : (n + 1) * 23 * MIN);
    const profit = (n % 4 === 1 ? -1 : 1) * (40 + 13 * n);
    events.push(...trip(strategy, entry, exit, n % 2 === 0, profit, ends[n % 3]!, { commission: -1.5, swap: n % 6 === 0 ? -0.75 : 0 }));
  }
  ingestEvents(db, I, events);
  app = Fastify();
  await app.register(cookie);
  registerAuth(app, { username: "admin", passwordHash: await argon2.hash("pw"), sessions: new Sessions(db) });
  registerRest(app, { db, liveState: new LiveStateStore(), monitors: undefined as never });
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
const enc = encodeURIComponent;
interface Totals { matched: number; closed: number; net: number }
const listTotals = async (params: string) => (await get<{ totals: Totals }>(`/round-trips?instance=${I}&${params}`)).totals;
interface Bucket { filter: string; n: number; pnl: number; label: string }
interface Analytics { daily: Array<{ day: string; n: number; pnl: number }>; side: Bucket[]; ended: Bucket[]; hold: Bucket[]; weekday: Bucket[]; hour: Bucket[] }

describe("drill-downs list exactly what the clicked figure counts", () => {
  it("an account calendar day: its trades and net equal Trades filtered to exit:<day>", async () => {
    const summary = await get<AccountSummary>(`/account/summary?instance=${I}`);
    expect(summary.dailyNets.length).toBeGreaterThan(5);
    for (const d of summary.dailyNets) {
      const t = await listTotals(`q=${enc(`exit:${d.day}`)}`);
      expect([t.matched, t.net]).toEqual([d.trades, expect.closeTo(d.net, 9)]);
    }
    // the cells add up to the whole account
    const all = await listTotals("");
    expect(all.net).toBeCloseTo(summary.dailyNets.reduce((a, d) => a + d.net, 0), 9);
  });

  it("a strategy calendar day: the cell equals the strategy's list for that exit day", async () => {
    for (const s of STRATEGIES) {
      const a = await get<Analytics>(`/round-trips/analytics?instance=${I}&strategy=${s}`);
      for (const d of a.daily) {
        const t = await listTotals(`strategy=${s}&q=${enc(`exit:${d.day}`)}`);
        expect([t.matched, t.net]).toEqual([d.n, expect.closeTo(d.pnl, 9)]);
      }
    }
  });

  it("weekday, hour, side, exit and hold buckets: each bucket's n and net equal its filter's list", async () => {
    for (const scope of ["", "&strategy=gold"]) {
      const a = await get<Analytics>(`/round-trips/analytics?instance=${I}${scope}`);
      for (const kind of ["weekday", "hour", "side", "ended", "hold"] as const) {
        expect(a[kind].length, kind).toBeGreaterThan(1);
        for (const b of a[kind]) {
          const t = await listTotals(`q=${enc(b.filter)}${scope}`);
          expect([t.matched, t.net], `${kind} ${b.label}`).toEqual([b.n, expect.closeTo(b.pnl, 9)]);
        }
      }
    }
  });

  it("a Home strategy row: its all-time net and trades equal the strategy's list", async () => {
    const summary = await get<AccountSummary>(`/account/summary?instance=${I}`);
    const periods = strategyPeriods(summary.closes, { now: T0 + 30 * D, dayStart: T0 + 29 * D, floating: new Map() });
    for (const s of STRATEGIES) {
      const p = periods.get(s)!;
      const t = await listTotals(`strategy=${s}`);
      expect([t.closed, t.net]).toEqual([p.trades, expect.closeTo(p.all, 9)]);
    }
  });
});
