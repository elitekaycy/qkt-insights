import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import argon2 from "argon2";
import { openDb, ingestEvents, LiveStateStore, Sessions, type Db } from "@qkt-insights/store";
import type { Envelope } from "@qkt-insights/contract";
import { registerAuth } from "../src/auth.js";
import { ACCOUNT_EQUITY_POINTS, registerRest } from "../src/rest.js";
import { matchesTag } from "../src/revalidate.js";

const T0 = Date.UTC(2026, 4, 11);
let seq = 0;
function deal(ticket: string, position: string, entry: "IN" | "OUT", ts: number, strategyId: string, profit = 0): Envelope {
  return {
    v: 1, instanceId: "qkt-prod", id: `deal-EXNESS-${ticket}`, seq: ++seq, ts, type: "broker.deal",
    payload: {
      broker: "EXNESS", dealTicket: ticket, positionTicket: position, symbol: "EXNESS:XAUUSD",
      side: entry === "IN" ? "BUY" : "SELL", entry, qty: 0.01, price: 4300, profit, strategyId, ts,
    },
  } as Envelope;
}

let app: FastifyInstance; let db: Db; let liveState: LiveStateStore; let session: string;
beforeEach(async () => {
  db = openDb(":memory:");
  liveState = new LiveStateStore();
  ingestEvents(db, "qkt-prod", [
    deal("1", "P1", "IN", T0, "gold"), deal("2", "P1", "OUT", T0 + 60_000, "gold", 5),
    deal("3", "P2", "IN", T0, "silver"), deal("4", "P2", "OUT", T0 + 60_000, "silver", -2),
  ]);
  app = Fastify();
  await app.register(cookie);
  registerAuth(app, { username: "admin", passwordHash: await argon2.hash("pw"), sessions: new Sessions(db) });
  registerRest(app, { db, liveState } as never);
  await app.ready();
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "admin", password: "pw" } });
  session = String(login.headers["set-cookie"]).split(";")[0]!;
});
afterEach(async () => { await app.close(); });

const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url, headers: { cookie: session, ...headers } });

describe("ETag revalidation", () => {
  const perf = "/performance?instance=qkt-prod&strategy=gold&include=report,closes";

  it("answers 304 with no body while the strategy's rows are unchanged", async () => {
    const first = await get(perf);
    expect(first.statusCode).toBe(200);
    const tag = first.headers.etag as string;
    expect(tag).toMatch(/^W\//u);
    expect(first.headers["cache-control"]).toBe("private, no-cache");
    const again = await get(perf, { "if-none-match": tag });
    expect(again.statusCode).toBe(304);
    expect(again.rawPayload.length).toBe(0);
  });

  it("ignores writes to another strategy and rebuilds after one to this strategy", async () => {
    const tag = (await get(perf)).headers.etag as string;
    ingestEvents(db, "qkt-prod", [deal("5", "P3", "IN", T0 + 120_000, "silver"), deal("6", "P3", "OUT", T0 + 180_000, "silver", 1)]);
    expect((await get(perf, { "if-none-match": tag })).statusCode).toBe(304);
    ingestEvents(db, "qkt-prod", [deal("7", "P4", "IN", T0 + 120_000, "gold"), deal("8", "P4", "OUT", T0 + 180_000, "gold", 3)]);
    const changed = await get(perf, { "if-none-match": tag });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).not.toBe(tag);
    expect(changed.json().closes).toHaveLength(2);
    expect(changed.json().report.totalNet).toBe(8);
  });

  it("never serves a body cached under an older version", async () => {
    expect((await get(perf)).json().closes).toHaveLength(1);
    ingestEvents(db, "qkt-prod", [deal("7", "P4", "IN", T0 + 120_000, "gold"), deal("8", "P4", "OUT", T0 + 180_000, "gold", 3)]);
    expect((await get(perf)).json().closes).toHaveLength(2);
  });

  it("tags per URL", async () => {
    const gold = (await get(perf)).headers.etag as string;
    const silver = await get("/performance?instance=qkt-prod&strategy=silver&include=report,closes", { "if-none-match": gold });
    expect(silver.statusCode).toBe(200);
  });

  it("parses If-None-Match lists and weak tags", () => {
    expect(matchesTag('W/"a", W/"b"', 'W/"b"')).toBe(true);
    expect(matchesTag('"b"', 'W/"b"')).toBe(true);
    expect(matchesTag("*", 'W/"b"')).toBe(true);
    expect(matchesTag('W/"c"', 'W/"b"')).toBe(false);
    expect(matchesTag(undefined, 'W/"b"')).toBe(false);
  });
});

describe("/account/equity sampling", () => {
  function seedMinutes(n: number): void {
    const ins = db.prepare("INSERT INTO account_equity (instance_id, broker, minute_ts, balance, equity, open_profit) VALUES (?,?,?,?,?,?)");
    db.transaction(() => {
      for (let i = 0; i < n; i++) ins.run("qkt-prod", "EXNESS", T0 + i * 60_000, 1000, 1000 + i, 0);
    })();
  }

  it("returns at most ACCOUNT_EQUITY_POINTS by default, more on request, every minute on resolution=full", async () => {
    seedMinutes(6000);
    const sampled = (await get("/account/equity?instance=qkt-prod")).json() as Array<{ minuteTs: number; equity: number }>;
    expect(sampled.length).toBeLessThanOrEqual(ACCOUNT_EQUITY_POINTS);
    expect(sampled.length).toBeGreaterThan(ACCOUNT_EQUITY_POINTS * 0.9);
    expect(sampled[sampled.length - 1]).toMatchObject({ minuteTs: T0 + 5999 * 60_000, equity: 6999 });
    const fewer = (await get("/account/equity?instance=qkt-prod&points=100")).json() as unknown[];
    expect(fewer.length).toBeLessThanOrEqual(100);
    const full = (await get("/account/equity?instance=qkt-prod&resolution=full")).json() as unknown[];
    expect(full).toHaveLength(6000);
  });

  it("revalidates on the account rollup", async () => {
    seedMinutes(10);
    const first = await get("/account/equity?instance=qkt-prod");
    const tag = first.headers.etag as string;
    expect((await get("/account/equity?instance=qkt-prod", { "if-none-match": tag })).statusCode).toBe(304);
    liveState.upsert("qkt-prod", { v: 1, instanceId: "qkt-prod", id: "a1", seq: 0, ts: T0 + 20 * 60_000, type: "state.account",
      payload: { broker: "EXNESS", currency: "USD", balance: 1000, equity: 1100 } } as Envelope);
    liveState.flushRollup(db, T0 + 20 * 60_000 + 1000);
    const after = await get("/account/equity?instance=qkt-prod", { "if-none-match": tag });
    expect(after.statusCode).toBe(200);
    expect(after.json()).toHaveLength(11);
  });
});
