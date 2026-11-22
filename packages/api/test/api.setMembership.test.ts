import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import argon2 from "argon2";
import { openDb, ingestEvents, LiveStateStore, Sessions, type Db } from "@qkt-insights/store";
import type { Envelope } from "@qkt-insights/contract";
import { registerAuth } from "../src/auth.js";
import { registerRest } from "../src/rest.js";

const T0 = Date.UTC(2026, 10, 20, 9);
const M = 60_000;
const change = (ts: number, member: string, kind: string, rank: number | null) => ({
  v: 1, instanceId: "i1", id: `m-${ts}-${member}`, seq: 1, ts, strategyId: "rotator", type: "set.membership",
  payload: { strategyId: "rotator", set: "movers", member, change: kind, rank, closeTs: ts - M },
}) as Envelope;

let app: FastifyInstance; let db: Db; let session: string;
beforeEach(async () => {
  db = openDb(":memory:");
  ingestEvents(db, "i1", [
    change(T0, "BINANCE:BTCUSDT", "join", 1),
    change(T0, "BINANCE:ETHUSDT", "join", 2),
    change(T0 + M, "BINANCE:ETHUSDT", "leave", null),
  ]);
  app = Fastify();
  await app.register(cookie);
  registerAuth(app, { username: "admin", passwordHash: await argon2.hash("pw"), sessions: new Sessions(db) });
  registerRest(app, { db, liveState: new LiveStateStore() });
  await app.ready();
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "admin", password: "pw" } });
  session = String(login.headers["set-cookie"]).split(";")[0]!;
});
afterEach(async () => { await app.close(); });

describe("GET /set-membership", () => {
  it("is refused without a session, and names no member", async () => {
    const res = await app.inject({ method: "GET", url: "/set-membership?instance=i1&strategy=rotator" });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain("BTCUSDT");
  });

  it("answers the members now and the latest changes, newest first", async () => {
    const res = await app.inject({ method: "GET", url: "/set-membership?instance=i1&strategy=rotator", headers: { cookie: session } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.members).toEqual([{ set: "movers", member: "BINANCE:BTCUSDT", state: "member", change: "join", rank: 1, since: T0 }]);
    expect(body.changes.map((c: { member: string; change: string }) => `${c.change} ${c.member}`)).toEqual([
      "leave BINANCE:ETHUSDT", "join BINANCE:ETHUSDT", "join BINANCE:BTCUSDT",
    ]);
    expect(body.changes[0]).toEqual({ id: `m-${T0 + M}-BINANCE:ETHUSDT`, set: "movers", member: "BINANCE:ETHUSDT", change: "leave", rank: null, closeTs: T0, reason: null, ts: T0 + M });
  });

  it("caps the changes at the limit asked for", async () => {
    const res = await app.inject({ method: "GET", url: "/set-membership?instance=i1&strategy=rotator&limit=1", headers: { cookie: session } });
    expect(res.json().changes).toHaveLength(1);
    expect(res.json().members).toHaveLength(1);
  });

  it("needs an instance and a strategy", async () => {
    for (const url of ["/set-membership?instance=i1", "/set-membership?strategy=rotator"]) {
      expect((await app.inject({ method: "GET", url, headers: { cookie: session } })).statusCode).toBe(400);
    }
  });
});
