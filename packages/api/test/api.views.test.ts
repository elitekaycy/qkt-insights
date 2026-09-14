import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import argon2 from "argon2";
import { openDb, LiveStateStore, Sessions, Shares, Views, type Db } from "@qkt-insights/store";
import { registerAuth } from "../src/auth.js";
import { registerPublic, registerShares } from "../src/public.js";
import { registerViews } from "../src/views.js";
import { TtlCache } from "../src/cache.js";

const NOW = Date.UTC(2026, 8, 15, 12, 0);
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1";

let app: FastifyInstance;
let db: Db;
let shares: Shares;
let views: Views;
let session: string;
let hash: string;

beforeEach(async () => {
  db = openDb(":memory:");
  shares = new Shares(db);
  views = new Views(db);
  for (const id of ["gold", "silver"]) {
    db.prepare("INSERT INTO strategies (instance_id, strategy_id, first_seen, last_seen, starting_balance, metadata) VALUES ('i1', ?, 0, ?, 10000, '{}')").run(id, NOW);
  }
  hash ??= await argon2.hash("admin-password-long");
  app = Fastify();
  await app.register(cookie);
  registerAuth(app, { username: "admin", passwordHash: hash, sessions: new Sessions(db) });
  const cache = new TtlCache(60_000, 1000, () => NOW);
  registerShares(app, { db, shares, cache, views });
  registerPublic(app, { db, liveState: new LiveStateStore(), shares, cache, delayMs: 15 * 60_000, now: () => NOW, views });
  registerViews(app, { views, now: () => NOW });
  await app.ready();
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "admin", password: "admin-password-long" } });
  session = String(login.headers["set-cookie"]).split(";")[0]!;
});
afterEach(async () => { await app.close(); });

async function publish(kind: "overview" | "strategy", subject: string): Promise<string> {
  const res = await app.inject({ method: "PUT", url: "/shares", headers: { cookie: session }, payload: { instance: "i1", kind, subject, visibility: "public" } });
  const view = res.json() as { overview: { token: string }; strategies: Array<{ id: string; token: string }> };
  return kind === "overview" ? view.overview.token : view.strategies.find((s) => s.id === subject)!.token;
}

function beacon(token: string, payload: Record<string, unknown>, headers: Record<string, string> = {}, remoteAddress = "203.0.113.9") {
  return app.inject({ method: "POST", url: `/public/${token}/view`, payload, remoteAddress, headers: { "user-agent": CHROME, ...headers } });
}

describe("view beacon", () => {
  it("records a page view with browser, device, country, referrer and language, and no IP", async () => {
    const token = await publish("overview", "");
    const res = await beacon(token, { page: "strategies", referrer: "T.CO" }, { "cf-ipcountry": "GH", "accept-language": "en-GB,en;q=0.9" });
    expect(res.statusCode).toBe(204);
    const [row] = views.list({ instanceId: "i1", limit: 5 });
    expect(row).toMatchObject({ kind: "overview", subject: "", page: "strategies", strategyId: null, browser: "Chrome", os: "macOS", device: "desktop", country: "GH", referrer: "t.co", language: "en-GB" });
    expect(JSON.stringify(db.prepare("SELECT * FROM share_views").all())).not.toContain("203.0.113.9");
  });

  it("ties a strategy view to the strategy only when the link covers it", async () => {
    await app.inject({ method: "PUT", url: "/shares", headers: { cookie: session }, payload: { instance: "i1", kind: "strategy", subject: "silver", visibility: "private" } });
    const token = await publish("overview", "");
    await beacon(token, { page: "strategy", strategy: "gold" });
    await beacon(token, { page: "strategy", strategy: "silver" }, {}, "198.51.100.2");
    expect(views.list({ instanceId: "i1", limit: 5 }).map((r) => r.strategyId ?? "none").sort()).toEqual(["gold", "none"]);
  });

  it("accepts only pages the link can show", async () => {
    const token = await publish("strategy", "gold");
    expect((await beacon(token, { page: "strategy", strategy: "gold" })).statusCode).toBe(204);
    expect((await beacon(token, { page: "overview" })).statusCode).toBe(400);
    expect((await beacon(token, { page: "logs" })).statusCode).toBe(400);
  });

  it("drops junk headers and referrers instead of storing them", async () => {
    const token = await publish("overview", "");
    await beacon(token, { page: "overview", referrer: "<script>alert(1)</script>" }, { "cf-ipcountry": "Hacked", "accept-language": "x".repeat(200) });
    const [row] = views.list({ instanceId: "i1", limit: 1 });
    expect(row).toMatchObject({ referrer: null, country: null, language: null });
  });

  it("does not count bots, unknown tokens, private links or oversized bodies", async () => {
    const token = await publish("strategy", "gold");
    expect((await beacon(token, { page: "strategy" }, { "user-agent": "Googlebot/2.1" })).statusCode).toBe(204);
    expect((await beacon("A".repeat(32), { page: "strategy" })).statusCode).toBe(404);
    expect((await beacon(token, { page: "strategy", referrer: "x".repeat(5000) })).statusCode).toBeGreaterThanOrEqual(400);
    await app.inject({ method: "PUT", url: "/shares", headers: { cookie: session }, payload: { instance: "i1", kind: "strategy", subject: "gold", visibility: "private" } });
    expect((await beacon(token, { page: "strategy" })).statusCode).toBe(404);
    expect(views.list({ instanceId: "i1", limit: 5 })).toEqual([]);
  });
});

describe("viewership admin API", () => {
  it("requires a session", async () => {
    expect((await app.inject({ method: "GET", url: "/views/summary?instance=i1" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/views?instance=i1" })).statusCode).toBe(401);
  });

  it("summarises and searches views for a range, and share state carries each link's count", async () => {
    const overview = await publish("overview", "");
    const gold = await publish("strategy", "gold");
    await beacon(overview, { page: "overview" });
    await beacon(overview, { page: "equity" }, { "user-agent": IPHONE }, "198.51.100.7");
    await beacon(gold, { page: "strategy", strategy: "gold" }, { "cf-ipcountry": "US" });
    const summary = (await app.inject({ method: "GET", url: "/views/summary?instance=i1&range=7d", headers: { cookie: session } })).json() as Record<string, any>;
    expect(summary.views).toBe(3);
    expect(summary.visitors).toBe(2);
    expect(summary.devices).toEqual([{ key: "desktop", views: 2 }, { key: "mobile", views: 1 }]);
    const found = (await app.inject({ method: "GET", url: "/views?instance=i1&q=ios", headers: { cookie: session } })).json() as Array<{ os: string }>;
    expect(found.map((r) => r.os)).toEqual(["iOS"]);
    const byLink = (await app.inject({ method: "GET", url: "/views/summary?instance=i1&range=7d&kind=strategy&subject=gold", headers: { cookie: session } })).json() as { views: number };
    expect(byLink.views).toBe(1);
    const state = (await app.inject({ method: "GET", url: "/shares?instance=i1", headers: { cookie: session } })).json() as { overview: { views: number }; strategies: Array<{ id: string; views: number }> };
    expect(state.overview.views).toBe(2);
    expect(state.strategies.find((s) => s.id === "gold")!.views).toBe(1);
  });

  it("rejects an unknown range", async () => {
    expect((await app.inject({ method: "GET", url: "/views/summary?instance=i1&range=forever", headers: { cookie: session } })).statusCode).toBe(400);
  });
});
