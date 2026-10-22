import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import argon2 from "argon2";
import { openDb, LiveStateStore, Sessions, reconcile, type Db } from "@qkt-insights/store";
import { registerAuth } from "../src/auth.js";
import { registerRest } from "../src/rest.js";

const I = "qkt-prod";
const OCT = (day: number, hour = 0, minute = 0) => Date.UTC(2026, 9, day, hour, minute);

let app: FastifyInstance; let db: Db; let session: string;
beforeEach(async () => {
  db = openDb(":memory:");
  const deal = db.prepare(
    `INSERT INTO deals (id, instance_id, broker, deal_ticket, position_ticket, symbol, side, entry, qty, price, profit, commission, swap, fee, ts, account_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  deal.run("d1", I, "ICM_S01", "1", "p1", "ICM:XAUUSD", "BUY", "IN", 0.1, 2400, 0, 0, 0, 0, OCT(2, 9), "mt5:00000000000000aa");
  deal.run("d2", I, "ICM_S01", "2", "p1", "ICM:XAUUSD", "SELL", "OUT", 0.1, 2410, 100, -2, 0, 0, OCT(2, 10, 0) + 30_000, "mt5:00000000000000aa");
  const minute = db.prepare("INSERT INTO account_equity (instance_id, broker, minute_ts, balance, equity, open_profit, account) VALUES (?,?,?,?,?,?,?)");
  for (let ts = OCT(1, 6); ts <= OCT(4, 1); ts += 10 * 60_000) {
    // the 98.00 net of p1, then 500.00 the venue booked on Oct 3 without a deal
    const balance = 10_000 + (ts > OCT(2, 10) ? 98 : 0) + (ts >= OCT(3, 12) ? 500 : 0);
    minute.run(I, "ICM", ts, balance, balance, 0, "mt5:00000000000000aa");
  }
  app = Fastify();
  await app.register(cookie);
  registerAuth(app, { username: "admin", passwordHash: await argon2.hash("pw"), sessions: new Sessions(db) });
  registerRest(app, { db, liveState: new LiveStateStore() });
  await app.ready();
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "admin", password: "pw" } });
  session = String(login.headers["set-cookie"]).split(";")[0]!;
});
afterEach(async () => { await app.close(); });

const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url, headers: { cookie: session, ...headers } });

describe("GET /health/reconciliation", () => {
  it("is behind the session and needs an instance", async () => {
    expect((await app.inject({ method: "GET", url: `/health/reconciliation?instance=${I}` })).statusCode).toBe(401);
    expect((await get("/health/reconciliation")).statusCode).toBe(400);
  });

  it("says why it is empty before the first run", async () => {
    expect((await get(`/health/reconciliation?instance=${I}`)).json()).toEqual({ instanceId: I, digits: 2, checkedAt: null, unassigned: { deals: 0, labels: [] }, accounts: [] });
  });

  it("serves the stored run, and answers 304 until the next run writes", async () => {
    reconcile(db, I, { now: OCT(4, 2) });
    const first = await get(`/health/reconciliation?instance=${I}`);
    expect(first.statusCode).toBe(200);
    expect(first.headers["cache-control"]).toBe("private, no-cache");
    const body = first.json();
    expect(body.checkedAt).toBe(OCT(4, 2));
    expect(body.unassigned).toEqual({ deals: 0, labels: [] });
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]).toMatchObject({
      account: "mt5:00000000000000aa", label: "ICM", daysOk: 1, daysDiff: 0, daysExternal: 1, daysIncomplete: 1, throughDay: "2026-10-03",
      positions: { status: "stale" }, ledger: { status: "ok", trips: 1, tripsNet: 98, dealsNet: 98 },
    });
    expect(body.accounts[0].days[0]).toMatchObject({ day: "2026-10-03", status: "external", reason: "no-deals", balanceChange: 500, dealNet: 0, diff: 500, deals: 0 });

    const tag = String(first.headers.etag);
    expect((await get(`/health/reconciliation?instance=${I}`, { "if-none-match": tag })).statusCode).toBe(304);
    reconcile(db, I, { now: OCT(4, 3) });
    const next = await get(`/health/reconciliation?instance=${I}`, { "if-none-match": tag });
    expect(next.statusCode).toBe(200);
    expect(next.json().checkedAt).toBe(OCT(4, 3));
  });
});
