import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import argon2 from "argon2";
import { openDb, ingestEvents, LiveStateStore, Sessions, type Db } from "@qkt-insights/store";
import type { Envelope } from "@qkt-insights/contract";
import { registerAuth } from "../src/auth.js";
import { registerRest } from "../src/rest.js";

const T0 = Date.UTC(2026, 9, 28, 9);
const start = (ts: number, sha: string, extra: Record<string, unknown>) => ({
  v: 1, instanceId: "i1", id: `s-${ts}`, seq: 1, ts, strategyId: "gold", type: "strategy.started",
  payload: { strategyId: "gold", ts, effectiveConfigSha256: sha, ...extra },
}) as Envelope;

let app: FastifyInstance; let db: Db; let session: string;
beforeEach(async () => {
  db = openDb(":memory:");
  ingestEvents(db, "i1", [
    start(T0, "aa", { effectiveConfig: { schema: 1, risk: { maxDailyLoss: { value: 500, source: "configured" } } } }),
    start(T0 + 1000, "bb", { effectiveConfig: { schema: 1, risk: { maxDailyLoss: { value: 250, source: "configured" } } } }),
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

describe("GET /strategy-config", () => {
  it("is refused without a session, and states nothing", async () => {
    const res = await app.inject({ method: "GET", url: "/strategy-config?instance=i1&strategy=gold" });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain("maxDailyLoss");
  });

  it("answers the versions, newest first, and is never cached", async () => {
    const res = await app.inject({ method: "GET", url: "/strategy-config?instance=i1&strategy=gold", headers: { cookie: session } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    const body = res.json();
    expect(body.running).toBe("bb");
    expect(body.versions.map((v: { sha256: string }) => v.sha256)).toEqual(["bb", "aa"]);
    expect(body.versions[0].config.risk.maxDailyLoss.value).toBe(250);
  });

  it("needs an instance and a strategy", async () => {
    const res = await app.inject({ method: "GET", url: "/strategy-config?instance=i1", headers: { cookie: session } });
    expect(res.statusCode).toBe(400);
  });
});
