import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import argon2 from "argon2";
import { openDb, ingestEvents, LiveStateStore, Sessions, type Db } from "@qkt-insights/store";
import type { Envelope } from "@qkt-insights/contract";
import { registerAuth } from "../src/auth.js";
import { registerRest } from "../src/rest.js";
import { csvField } from "../src/roundTrips.js";

const I = "qkt-prod";
const MIN = 60_000, H = 3_600_000, D = 86_400_000;
const T0 = Date.UTC(2026, 9, 12, 8);
let seq = 1;

function env(type: string, ts: number, payload: Record<string, unknown>, strategyId?: string, id?: string): Envelope {
  return { v: 1, instanceId: I, id: id ?? `e${seq}`, seq: seq++, ts, type, strategyId, payload } as Envelope;
}

function deal(ticket: string, position: string, entry: "IN" | "OUT", side: "BUY" | "SELL", ts: number, price: number, profit = 0, strategyId = "gold", comment = ""): Envelope {
  return env("broker.deal", ts, {
    broker: "ICMARKETS", dealTicket: ticket, positionTicket: position, orderTicket: position, symbol: "ICMARKETS:XAUUSD", side, entry, qty: 0.5,
    price, profit, commission: 0, swap: 0, comment, ts, strategyId,
  }, strategyId, `deal-${ticket}`);
}

let app: FastifyInstance; let db: Db; let session: string;

beforeEach(async () => {
  seq = 1;
  db = openDb(":memory:");
  // deals naming a strategy the instance does not run are another instance's: register both
  for (const s of ["gold", "silver"]) db.prepare("INSERT INTO strategies (instance_id, strategy_id, first_seen, last_seen) VALUES (?, ?, ?, ?)").run(I, s, T0, T0);
  const events: Envelope[] = [];
  // 30 round trips over 30 days: even days long and winning, odd days short and losing
  for (let n = 0; n < 30; n++) {
    const long = n % 2 === 0;
    const t = T0 + n * D;
    events.push(
      deal(`${n}a`, `${1000 + n}`, "IN", long ? "BUY" : "SELL", t, 4000, 0, n < 20 ? "gold" : "silver"),
      deal(`${n}b`, `${1000 + n}`, "OUT", long ? "SELL" : "BUY", t + (n + 1) * 10 * MIN, long ? 4010 : 4010, long ? 500 : -500, n < 20 ? "gold" : "silver", long ? "[tp 4010]" : "[sl 4010]"),
    );
  }
  events.push(
    env("log", T0, { level: "ERROR", logger: "com.qkt.connector.mt5.MT5Broker", message: "order rejected: no money" }, "gold"),
    env("log", T0 + MIN, { level: "WARN", logger: "com.qkt.app.OrderManager", message: "retrying order" }, "gold"),
    env("log", T0 + 2 * D, { level: "ERROR", logger: "com.qkt.app.LiveSession", message: "session lost" }, "silver"),
  );
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

const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url, headers: { cookie: session, ...headers } });
const q = (s: string) => encodeURIComponent(s);
interface Page { rows: Array<{ id: string; side: string; pnl: number; strategyId: string }>; nextCursor: string | null; totals: Record<string, number | null> | null; query: { canonical: string; errors: string[] } }

describe("GET /round-trips", () => {
  it("needs a session and an instance", async () => {
    expect((await app.inject({ method: "GET", url: `/round-trips?instance=${I}` })).statusCode).toBe(401);
    expect((await get("/round-trips")).json()).toEqual({ error: "instance required" });
  });

  it("filters by the query and returns totals of the whole match on the first page", async () => {
    const res = await get(`/round-trips?instance=${I}&q=${q("side:short pnl:<0")}&limit=5`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Page;
    expect(body.rows).toHaveLength(5);
    expect(body.rows.every((r) => r.side === "short" && r.pnl === -500)).toBe(true);
    expect(body.totals).toEqual({ total: 30, matched: 15, closed: 15, open: 0, net: -7500, wins: 0, losses: 15, winRate: 0, avg: -500, best: -500, worst: -500 });
    expect(body.query).toEqual({ canonical: "side:short pnl:<0", errors: [] });
  });

  it("applies the valid tokens and reports the rest", async () => {
    const body = (await get(`/round-trips?instance=${I}&q=${q("side:long held:forever strategy:gol")}`)).json() as Page;
    expect(body.query.canonical).toBe("side:long strategy:gold");
    expect(body.query.errors).toEqual(['"held:forever": held: a duration like <1h, >=4h, 1h..4h, 30m or 2d']);
    expect(body.totals!.matched).toBe(10);
  });

  it("pages by cursor with no gaps or repeats; later pages skip the totals", async () => {
    const seen: string[] = [];
    let url = `/round-trips?instance=${I}&sort=pnl&dir=desc&limit=7`;
    for (;;) {
      const page = (await get(url)).json() as Page;
      if (seen.length > 0) expect(page.totals).toBeNull();
      seen.push(...page.rows.map((r) => r.id));
      if (!page.nextCursor) break;
      url = `/round-trips?instance=${I}&sort=pnl&dir=desc&limit=7&cursor=${page.nextCursor}`;
    }
    expect(seen).toHaveLength(30);
    expect(new Set(seen).size).toBe(30);
  });

  it("scopes to a strategy and a date range", async () => {
    expect(((await get(`/round-trips?instance=${I}&strategy=silver`)).json() as Page).totals!.total).toBe(10);
    expect(((await get(`/round-trips?instance=${I}&from=${T0 + 25 * D}`)).json() as Page).totals!.total).toBe(5);
  });

  it("refuses what it cannot read instead of guessing", async () => {
    expect((await get(`/round-trips?instance=${I}&sort=payload`)).statusCode).toBe(400);
    expect((await get(`/round-trips?instance=${I}&dir=sideways`)).statusCode).toBe(400);
    expect((await get(`/round-trips?instance=${I}&limit=5000`)).statusCode).toBe(400);
    expect((await get(`/round-trips?instance=${I}&from=yesterday`)).statusCode).toBe(400);
    expect((await get(`/round-trips?instance=${I}&q=${"x".repeat(501)}`)).statusCode).toBe(400);
  });

  it("answers an unchanged poll with 304, and a new trade with fresh rows", async () => {
    const url = `/round-trips?instance=${I}&limit=1`;
    const first = await get(url);
    expect((await get(url, { "if-none-match": String(first.headers.etag) })).statusCode).toBe(304);
    ingestEvents(db, I, [deal("new", "2000", "IN", "BUY", T0 + 40 * D, 4100)]);
    const next = await get(url, { "if-none-match": String(first.headers.etag) });
    expect(next.statusCode).toBe(200);
    expect((next.json() as Page).rows[0]!.id).toBe("2000");
  });
});

describe("GET /round-trips/analytics", () => {
  interface Analytics { matched: number; pnl: number; wins: number; losses: number; winRate: number | null; side: Array<{ filter: string; n: number; pnl: number }>; daily: unknown[]; trades: unknown[]; query: { errors: string[] } }

  it("aggregates the same match as the list, for any scope and query", async () => {
    for (const url of [`instance=${I}`, `instance=${I}&strategy=gold`, `instance=${I}&q=${q("side:short")}`, `instance=${I}&from=${T0 + 25 * D}`]) {
      const a = (await get(`/round-trips/analytics?${url}`)).json() as Analytics;
      const t = ((await get(`/round-trips?${url}`)).json() as Page).totals!;
      expect([a.matched, a.pnl, a.wins, a.losses, a.winRate]).toEqual([t.matched, t.net, t.wins, t.losses, t.winRate]);
    }
  });

  it("gives every bucket the filter that lists its trades", async () => {
    const a = (await get(`/round-trips/analytics?instance=${I}&strategy=gold`)).json() as Analytics;
    expect(a.daily).toHaveLength(20);
    expect(a.trades).toHaveLength(20);
    for (const b of a.side) {
      const t = ((await get(`/round-trips?instance=${I}&strategy=gold&q=${q(b.filter)}`)).json() as Page).totals!;
      expect([t.matched, t.net]).toEqual([b.n, b.pnl]);
    }
  });

  it("reports what it could not read and refuses bad parameters", async () => {
    expect(((await get(`/round-trips/analytics?instance=${I}&q=${q("held:soon")}`)).json() as Analytics).query.errors).toHaveLength(1);
    expect((await get(`/round-trips/analytics?instance=${I}&from=yesterday`)).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/round-trips/analytics?instance=${I}` })).statusCode).toBe(401);
  });
});

describe("GET /round-trips/facets, /round-trips/:id, /round-trips/export", () => {
  it("lists strategies, instruments, days and sizes", async () => {
    const f = (await get(`/round-trips/facets?instance=${I}`)).json() as { strategies: unknown[]; instruments: unknown[]; days: string[]; sizes: number[] };
    expect(f.strategies).toEqual([{ id: "gold", n: 20 }, { id: "silver", n: 10 }]);
    expect(f.instruments).toEqual([{ name: "XAUUSD", n: 30 }]);
    expect(f.days).toHaveLength(30);
    expect(f.sizes).toEqual([0.5]);
  });

  it("returns one round trip in full, 404 for none", async () => {
    const d = (await get(`/round-trips/1003?instance=${I}`)).json() as { trip: { id: string; ended: string }; legs: unknown[]; timeline: Array<{ kind: string }> };
    expect(d.trip).toMatchObject({ id: "1003", ended: "stop" });
    expect(d.legs).toHaveLength(2);
    expect(d.timeline.map((s) => s.kind)).toEqual(["deal", "deal"]);
    expect((await get(`/round-trips/nope?instance=${I}`)).statusCode).toBe(404);
  });

  it("streams the whole match as CSV", async () => {
    const res = await get(`/round-trips/export?instance=${I}&q=${q("strategy:silver")}&sort=entry&dir=asc`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="round-trips-qkt-prod-\d{4}-\d{2}-\d{2}\.csv"$/);
    const lines = res.body.trim().split("\n");
    expect(lines[0]).toBe("ticket,strategy,instrument,symbol,side,status,entry_utc,entry_price,exit_utc,exit_price,size,pnl,r,risk,held_ms,ended,stop,target,stop_raw,target_raw,legs");
    expect(lines).toHaveLength(11);
    expect(lines[1]).toBe(`1020,silver,XAUUSD,ICMARKETS:XAUUSD,long,closed,${new Date(T0 + 20 * D).toISOString()},4000.00,${new Date(T0 + 20 * D + 210 * MIN).toISOString()},4010.00,0.5,500,,,${210 * MIN},tp,,,,,2`);
  });

  it("quotes CSV fields and defuses formulas", () => {
    expect(csvField('a,"b"')).toBe('"a,""b"""');
    expect(csvField("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvField(-5)).toBe("-5");
    expect(csvField(null)).toBe("");
  });
});

describe("GET /logs with the query bar's filters", () => {
  const msgs = async (url: string) => ((await get(url)).json() as Array<{ message: string }>).map((l) => l.message);

  it("keeps its contract and adds logger, from and to", async () => {
    expect(await msgs(`/logs?instance=${I}&level=ERROR`)).toEqual(["session lost", "order rejected: no money"]);
    expect(await msgs(`/logs?instance=${I}&logger=mt5broker`)).toEqual(["order rejected: no money"]);
    expect(await msgs(`/logs?instance=${I}&from=${T0 + H}`)).toEqual(["session lost"]);
    expect(await msgs(`/logs?instance=${I}&to=${T0 + MIN}`)).toEqual(["order rejected: no money"]);
    expect(await msgs(`/logs?instance=${I}&strategy=gold&q=order`)).toEqual(["retrying order", "order rejected: no money"]);
  });

  it("reads text FTS cannot parse as plain words instead of failing", async () => {
    const res = await get(`/logs?instance=${I}&q=${q('rejected: "no')}`);
    expect(res.statusCode).toBe(200);
    expect((res.json() as Array<{ message: string }>).map((l) => l.message)).toEqual(["order rejected: no money"]);
  });
});
