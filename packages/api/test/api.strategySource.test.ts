import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import argon2 from "argon2";
import { openDb, ingestEvents, LiveStateStore, Sessions, type Db } from "@qkt-insights/store";
import type { Envelope } from "@qkt-insights/contract";
import { registerAuth } from "../src/auth.js";
import { registerRest } from "../src/rest.js";

const T0 = Date.UTC(2026, 9, 28, 9);
const TEXT = "STRATEGY gold VERSION 1\nSYMBOLS\n    g = EXNESS:XAUUSD EVERY 1h\n";

function started(ts: number, sha: string, extra: Record<string, unknown>): Envelope {
  return {
    v: 1, instanceId: "i1", id: `strategy-started-gold-${ts}`, seq: 1, ts, strategyId: "gold", type: "strategy.started",
    payload: { strategyId: "gold", ts, sourcePath: "/srv/qkt/gold.qkt", sourceSha256: sha, dslVersion: 1, ...extra },
  } as Envelope;
}

let app: FastifyInstance; let db: Db; let session: string;
beforeEach(async () => {
  db = openDb(":memory:");
  ingestEvents(db, "i1", [
    started(T0, "aa", { sourceText: TEXT, sourceTruncated: false }),
    started(T0 + 1000, "bb", { sourceTextOmitted: true }),
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

function get(url: string, authed = true) {
  return app.inject({ method: "GET", url, headers: authed ? { cookie: session } : {} });
}

describe("strategy source", () => {
  it("is behind the session", async () => {
    expect((await get("/strategy-source?instance=i1&strategy=gold", false)).statusCode).toBe(401);
    expect((await get("/strategy-source/text?instance=i1&strategy=gold&sha=aa", false)).statusCode).toBe(401);
  });

  it("lists the versions without their text and names the running one", async () => {
    const res = await get("/strategy-source?instance=i1&strategy=gold");
    expect(res.json()).toMatchObject({
      running: "bb",
      versions: [{ sha256: "bb", text: "not-received", bytes: null }, { sha256: "aa", text: "stored", bytes: TEXT.length, firstSeen: T0 }],
    });
    expect(res.body).not.toContain("SYMBOLS");
  });

  it("answers one version's text, and 404 for a version it holds no text for", async () => {
    expect((await get("/strategy-source/text?instance=i1&strategy=gold&sha=aa")).json()).toEqual({ sha256: "aa", text: TEXT, truncated: false });
    expect((await get("/strategy-source/text?instance=i1&strategy=gold&sha=bb")).statusCode).toBe(404);
    expect((await get("/strategy-source/text?instance=i1&strategy=gold")).statusCode).toBe(400);
  });
});
