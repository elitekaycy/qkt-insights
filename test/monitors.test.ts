import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import type { Envelope } from "@qkt-insights/contract";
import { ingestEvents, openDb, MarketDataEpisodes, Monitors, touchInstance, type Db } from "@qkt-insights/store";
import {
  HEARTBEAT_STALE_MS, channelsFromEnv, episodeDuration, formatEpisodes, formatTransition, parseHttpMonitors, parseMarketDataMonitor,
  probe, startMonitors, tick, type MonitorRunnerDeps,
} from "../src/monitors.js";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

/** A real HTTP world: a probe target whose answer the test controls, and receivers for every channel. */
const world = Fastify();
const health = { code: 200, body: { status: "healthy", mt5_status: "connected" } as unknown };
const telegram: unknown[] = [];
const hooks: unknown[] = [];
let pings = 0;
let base = "";

beforeAll(async () => {
  world.get("/health", async (_req, reply) => reply.code(health.code).send(health.body));
  world.get("/text", async (_req, reply) => reply.type("text/plain").send("ok"));
  world.get("/guarded", async (req, reply) => (req.headers.authorization === "Bearer k" ? { ok: true } : reply.code(401).send({})));
  world.post("/bot/sendMessage", async (req) => { telegram.push(req.body); return { ok: true }; });
  world.post("/hook", async (req) => { hooks.push(req.body); return {}; });
  world.post("/hook-broken", async (_req, reply) => reply.code(500).send({}));
  world.get("/ping", async () => { pings += 1; return "ok"; });
  await world.listen({ port: 0, host: "127.0.0.1" });
  const addr = world.server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => world.close());

function deps(over: Partial<MonitorRunnerDeps> = {}): MonitorRunnerDeps {
  const db = openDb(":memory:");
  return { db, monitors: new Monitors(db), http: [], channels: {}, brand: null, log: Fastify({ logger: false }).log, ...over };
}

describe("parseHttpMonitors", () => {
  it("accepts an empty value and a well-formed list", () => {
    expect(parseHttpMonitors(undefined)).toEqual([]);
    expect(parseHttpMonitors("  ")).toEqual([]);
    expect(parseHttpMonitors('[{"name":"gw","url":"http://gw:5001/health","expect":{"mt5_status":"connected"},"headers":{"Authorization":"Bearer k"}},{"name":"plain","url":"https://x/"}]'))
      .toEqual([{ name: "gw", url: "http://gw:5001/health", expect: { mt5_status: "connected" }, headers: { Authorization: "Bearer k" } }, { name: "plain", url: "https://x/" }]);
  });

  it("rejects malformed config with a message naming the field", () => {
    expect(() => parseHttpMonitors("{")).toThrow(/not valid JSON/u);
    expect(() => parseHttpMonitors("{}")).toThrow(/must be a JSON array/u);
    expect(() => parseHttpMonitors('[{"url":"http://x"}]')).toThrow(/\[0\]\.name/u);
    expect(() => parseHttpMonitors('[{"name":"a","url":"ftp://x"}]')).toThrow(/\[0\]\.url/u);
    expect(() => parseHttpMonitors('[{"name":"a","url":"http://x","expect":[1]}]')).toThrow(/\[0\]\.expect must be an object/u);
    expect(() => parseHttpMonitors('[{"name":"a","url":"http://x","expect":{"k":{}}}]')).toThrow(/expect\.k/u);
    expect(() => parseHttpMonitors('[{"name":"a","url":"http://x","headers":"k"}]')).toThrow(/\[0\]\.headers must be an object/u);
    expect(() => parseHttpMonitors('[{"name":"a","url":"http://x","headers":{"k":1}}]')).toThrow(/headers\.k/u);
    expect(() => parseHttpMonitors('[{"name":"a","url":"http://x"},{"name":"a","url":"http://y"}]')).toThrow(/two monitors named a/u);
  });
});

describe("channelsFromEnv", () => {
  it("builds the Telegram URL from the bot token and leaves unset channels undefined", () => {
    expect(channelsFromEnv({ TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "42", DEADMAN_URL: " " })).toEqual({
      telegram: { url: "https://api.telegram.org/bot123:abc/sendMessage", chatId: "42" }, webhook: undefined, deadman: undefined,
    });
    expect(channelsFromEnv({ TELEGRAM_BOT_TOKEN: "123:abc", ALERT_WEBHOOK_URL: "http://h/x" })).toEqual({ telegram: undefined, webhook: "http://h/x", deadman: undefined });
  });
});

describe("probe", () => {
  it("is up on 2xx with matching fields, reporting latency", async () => {
    health.code = 200;
    health.body = { status: "healthy", mt5_status: "connected" };
    const r = await probe({ name: "gw", url: `${base}/health`, expect: { mt5_status: "connected" } });
    expect(r.up).toBe(true);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(await probe({ name: "t", url: `${base}/text` })).toMatchObject({ up: true });
  });

  it("sends configured headers, which is what gets it past the gateway's auth", async () => {
    expect(await probe({ name: "g", url: `${base}/guarded` })).toMatchObject({ up: false, detail: "HTTP 401" });
    expect(await probe({ name: "g", url: `${base}/guarded`, headers: { Authorization: "Bearer k" } })).toMatchObject({ up: true });
  });

  it("names the failing field, status, body shape or connection error", async () => {
    health.body = { status: "degraded", mt5_status: "disconnected" };
    expect(await probe({ name: "gw", url: `${base}/health`, expect: { mt5_status: "connected" } })).toMatchObject({ up: false, detail: "mt5_status=disconnected" });
    health.code = 503;
    expect(await probe({ name: "gw", url: `${base}/health` })).toMatchObject({ up: false, detail: "HTTP 503" });
    health.code = 200;
    expect(await probe({ name: "t", url: `${base}/text`, expect: { a: 1 } })).toMatchObject({ up: false, detail: "body is not JSON" });
    const vacated = Fastify();
    await vacated.listen({ port: 0, host: "127.0.0.1" });
    const addr = vacated.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    await vacated.close();
    const refused = await probe({ name: "dead", url: `http://127.0.0.1:${port}/health` });
    expect(refused.up).toBe(false);
    expect(refused.detail).toMatch(/ECONNREFUSED/u);
  });
});

describe("tick", () => {
  it("derives a heartbeat per instance and takes a silent one down after three ticks, alerting every channel", async () => {
    const d = deps({
      brand: "bot2",
      channels: { telegram: { url: `${base}/bot/sendMessage`, chatId: "42" }, webhook: `${base}/hook`, deadman: `${base}/ping` },
    });
    touchInstance(d.db, "qkt-live", NOW - 10_000, 1, NOW - 10_000);
    touchInstance(d.db, "qkt-bench", NOW - HEARTBEAT_STALE_MS - 1, 1, NOW - HEARTBEAT_STALE_MS - 1);
    touchInstance(d.db, "qkt-retired", NOW - 31 * DAY, 1, NOW - 31 * DAY);
    // a box whose clock runs 10 minutes slow: envelope timestamps look ancient, but the
    // collector heard from it a second ago
    touchInstance(d.db, "qkt-slow-clock", NOW - 600_000, 1, NOW - 1_000);
    telegram.length = 0; hooks.length = 0; pings = 0;

    const first = await tick(d, NOW);
    expect(first.map((t) => [t.name, t.status])).toEqual([["qkt-live", "up"], ["qkt-slow-clock", "up"]]);
    expect(d.monitors.list().map((m) => [m.name, m.status])).toEqual([["qkt-bench", "pending"], ["qkt-live", "up"], ["qkt-slow-clock", "up"]]);

    expect(await tick(d, NOW + 30_000)).toEqual([]);
    const third = await tick(d, NOW + 60_000);
    expect(third).toMatchObject([{ name: "qkt-bench", kind: "heartbeat", status: "down", detail: "silent for 150s" }]);

    expect(pings).toBe(3);
    expect(telegram).toEqual([
      { chat_id: "42", text: "bot2 · qkt-live is UP" },
      { chat_id: "42", text: "bot2 · qkt-slow-clock is UP" },
      { chat_id: "42", text: "bot2 · qkt-bench is DOWN: silent for 150s" },
    ]);
    expect(hooks[2]).toMatchObject({ name: "qkt-bench", status: "down", brand: "bot2", text: "bot2 · qkt-bench is DOWN: silent for 150s" });

    touchInstance(d.db, "qkt-bench", NOW + 70_000, 2, NOW + 70_000);
    expect(await tick(d, NOW + 90_000)).toMatchObject([{ name: "qkt-bench", status: "up" }]);
    expect(telegram.at(-1)).toEqual({ chat_id: "42", text: "bot2 · qkt-bench is UP" });
  });

  it("probes declared http monitors alongside heartbeats and survives a broken channel", async () => {
    health.code = 200;
    health.body = { mt5_status: "connected" };
    const d = deps({ http: [{ name: "gw", url: `${base}/health`, expect: { mt5_status: "connected" } }], channels: { webhook: `${base}/hook-broken` } });
    const t = await tick(d, NOW);
    expect(t).toMatchObject([{ name: "gw", kind: "http", status: "up", target: `${base}/health` }]);
    health.body = { mt5_status: "disconnected" };
    for (let i = 1; i <= 2; i++) expect(await tick(d, NOW + i * 30_000)).toEqual([]);
    expect(await tick(d, NOW + 90_000)).toMatchObject([{ name: "gw", status: "down", detail: "mt5_status=disconnected" }]);
    expect(d.monitors.list()[0]).toMatchObject({ status: "down", failures: 3 });
  });

  it("formats an alert with and without a brand", () => {
    const t = { name: "gw", kind: "http" as const, target: "u", status: "down" as const, ts: NOW, detail: "HTTP 503" };
    expect(formatTransition(t, null)).toBe("gw is DOWN: HTTP 503");
    expect(formatTransition({ ...t, status: "up", detail: null }, "bot2")).toBe("bot2 · gw is UP");
  });
});

describe("parseMarketDataMonitor", () => {
  it("is off unless switched on, and defaults to a 180s threshold", () => {
    expect(parseMarketDataMonitor({})).toBeNull();
    expect(parseMarketDataMonitor({ INSIGHTS_MARKETDATA_MONITOR: "0", INSIGHTS_MARKETDATA_ALERT_AFTER_S: "60" })).toBeNull();
    expect(parseMarketDataMonitor({ INSIGHTS_MARKETDATA_MONITOR: " " })).toBeNull();
    expect(parseMarketDataMonitor({ INSIGHTS_MARKETDATA_MONITOR: "1" })).toEqual({ alertAfterMs: 180_000 });
    expect(parseMarketDataMonitor({ INSIGHTS_MARKETDATA_MONITOR: "true", INSIGHTS_MARKETDATA_ALERT_AFTER_S: "300" })).toEqual({ alertAfterMs: 300_000 });
  });

  it("refuses values it cannot read rather than guessing", () => {
    expect(() => parseMarketDataMonitor({ INSIGHTS_MARKETDATA_MONITOR: "maybe" })).toThrow(/INSIGHTS_MARKETDATA_MONITOR/u);
    expect(() => parseMarketDataMonitor({ INSIGHTS_MARKETDATA_MONITOR: "1", INSIGHTS_MARKETDATA_ALERT_AFTER_S: "3m" })).toThrow(/INSIGHTS_MARKETDATA_ALERT_AFTER_S/u);
    expect(() => parseMarketDataMonitor({ INSIGHTS_MARKETDATA_MONITOR: "1", INSIGHTS_MARKETDATA_ALERT_AFTER_S: "0" })).toThrow(/INSIGHTS_MARKETDATA_ALERT_AFTER_S/u);
  });
});

describe("market-data monitor", () => {
  const ALERT_AFTER = 180_000;
  const MIN = 60_000;
  let seq = 0;

  function md(db: Db, type: string, ts: number, payload: Record<string, unknown>): void {
    seq += 1;
    const e = { v: 1, instanceId: "qkt-live", id: `md-${seq}`, seq, ts, type: `marketdata.${type}`, payload: { source: "Composite", ...payload } } as Envelope;
    ingestEvents(db, "qkt-live", [e], ts);
  }
  const quoteAge = (db: Db, symbol: string, ts: number, extra: Record<string, unknown> = {}) =>
    md(db, "stale", ts, { symbols: [symbol], state: "stale", reason: "quote age 60553ms exceeds 60000ms threshold", ts, ...extra });

  /** A live instance whose heartbeat keeps flowing, so only the market-data monitor can move. */
  function live(over: Partial<MonitorRunnerDeps> = {}, withMonitor = true): MonitorRunnerDeps {
    const d = deps({ brand: "bot1", channels: { telegram: { url: `${base}/bot/sendMessage`, chatId: "42" }, webhook: `${base}/hook` }, ...over });
    if (withMonitor) d.marketData = { episodes: new MarketDataEpisodes(d.db), alertAfterMs: ALERT_AFTER };
    return d;
  }
  async function at(d: MonitorRunnerDeps, now: number) {
    touchInstance(d.db, "qkt-live", now, 1, now);
    return (await tick(d, now)).filter((t) => t.kind === "marketdata");
  }

  it("formats durations and episodes, reading the cause from kind or, for older engines, the reason", () => {
    expect([45_000, 12 * MIN, 65 * MIN, 51 * 60 * MIN].map(episodeDuration)).toEqual(["45s", "12m", "1h05m", "2d03h"]);
    const since = NOW - 12 * MIN;
    expect(formatEpisodes([
      { symbol: "PROP_S01:EURUSD", source: "c", since, kind: null, reason: "quote age 60553ms exceeds 60000ms threshold" },
      { symbol: "PROP_S01:XAUUSD", source: "c", since, kind: null, reason: "broker tick clock skew -61441ms exceeds 60000ms" },
      { symbol: "PROP_S01:GBPUSD", source: "c", since, kind: "outlier", reason: "3 consecutive outlier tick(s) rejected" },
      { symbol: "PROP_S01:USDJPY", source: "c", since, kind: "stale", reason: null },
      { symbol: "PROP_S01:US30", source: "c", since, kind: null, reason: "feed wedged" },
    ], NOW)).toBe("market data stale: PROP_S01:EURUSD 12m (quote age), PROP_S01:XAUUSD 12m (clock skew), "
      + "PROP_S01:GBPUSD 12m (outliers), PROP_S01:USDJPY 12m (quote age), PROP_S01:US30 12m (feed wedged)");
  });

  it("is up with no episode and while an episode is younger than the threshold", async () => {
    const d = live();
    expect(await at(d, NOW)).toMatchObject([{ name: "qkt-live market data", kind: "marketdata", status: "up", target: "quote health · alert after 180s" }]);
    quoteAge(d.db, "PROP_S01:EURUSD", NOW + 10_000);
    for (let t = NOW + 30_000; t <= NOW + 10_000 + ALERT_AFTER; t += 30_000) expect(await at(d, t)).toEqual([]);
    expect(d.monitors.list().find((m) => m.kind === "marketdata")).toMatchObject({ status: "up", failures: 0 });
  });

  it("goes down past the threshold naming every overdue symbol, and up again on recovered", async () => {
    const d = live();
    await at(d, NOW);
    telegram.length = 0; hooks.length = 0;
    quoteAge(d.db, "PROP_S01:EURUSD", NOW);
    quoteAge(d.db, "PROP_S01:XAUUSD", NOW + 30_000, { kind: "clock_skew", reason: "broker tick clock skew -61441ms exceeds 60000ms" });
    quoteAge(d.db, "PROP_S01:GBPUSD", NOW + 11 * MIN);
    // first failing checks, then the third straight failure is the outage
    expect(await at(d, NOW + 11.5 * MIN)).toEqual([]);
    expect(await at(d, NOW + 12 * MIN)).toEqual([]);
    const [down] = await at(d, NOW + 12.5 * MIN);
    expect(down).toMatchObject({ name: "qkt-live market data", status: "down",
      detail: "market data stale: PROP_S01:EURUSD 12m (quote age), PROP_S01:XAUUSD 12m (clock skew)" });
    expect(telegram).toEqual([{ chat_id: "42",
      text: "bot1 · qkt-live market data is DOWN: market data stale: PROP_S01:EURUSD 12m (quote age), PROP_S01:XAUUSD 12m (clock skew)" }]);
    expect(hooks[0]).toMatchObject({ name: "qkt-live market data", kind: "marketdata", status: "down", brand: "bot1" });

    // one symbol healthy again is not enough; GBPUSD, 2m in, is not overdue yet
    md(d.db, "recovered", NOW + 13 * MIN, { symbols: ["PROP_S01:EURUSD"], state: "recovered", unhealthyForMs: 13 * MIN });
    expect(await at(d, NOW + 13 * MIN)).toEqual([]);
    expect(d.monitors.list().find((m) => m.kind === "marketdata")?.detail)
      .toBe("market data stale: PROP_S01:XAUUSD 12m (clock skew)");
    md(d.db, "recovered", NOW + 14 * MIN, { symbols: ["PROP_S01:XAUUSD"], state: "recovered", unhealthyForMs: 13.5 * MIN });
    md(d.db, "recovered", NOW + 14 * MIN, { symbols: ["PROP_S01:GBPUSD"], state: "recovered", unhealthyForMs: 3 * MIN });
    expect(await at(d, NOW + 14 * MIN)).toMatchObject([{ status: "up" }]);
    expect(telegram.at(-1)).toEqual({ chat_id: "42", text: "bot1 · qkt-live market data is UP" });
  });

  it("closes an episode when the engine starts a session again (marketdata.connected)", async () => {
    const d = live();
    await at(d, NOW);
    quoteAge(d.db, "PROP_S01:EURUSD", NOW);
    for (const t of [4, 4.5, 5]) await at(d, NOW + t * MIN);
    expect(d.monitors.list().find((m) => m.kind === "marketdata")).toMatchObject({ status: "down" });
    md(d.db, "reconnected", NOW + 6 * MIN, { symbols: ["PROP_S01:EURUSD"], state: "reconnected" });
    expect(await at(d, NOW + 6 * MIN)).toEqual([]);
    md(d.db, "connected", NOW + 7 * MIN, { symbols: ["PROP_S01:EURUSD"], state: "connected", reason: "session-start" });
    expect(await at(d, NOW + 7 * MIN)).toMatchObject([{ status: "up" }]);
  });

  it("survives a collector restart mid-episode without re-announcing", async () => {
    const d = live();
    await at(d, NOW);
    quoteAge(d.db, "PROP_S01:EURUSD", NOW);
    for (const t of [4, 4.5, 5]) await at(d, NOW + t * MIN);
    const restarted = { ...d, monitors: new Monitors(d.db), marketData: { episodes: new MarketDataEpisodes(d.db), alertAfterMs: ALERT_AFTER } };
    expect(await at(restarted, NOW + 6 * MIN)).toEqual([]);
    expect(restarted.monitors.list().find((m) => m.kind === "marketdata"))
      .toMatchObject({ status: "down", detail: "market data stale: PROP_S01:EURUSD 6m (quote age)" });
  });

  it("is absent when switched off, even for an older engine that only ever sends stale", async () => {
    const d = live({}, false);
    quoteAge(d.db, "PROP_S01:EURUSD", NOW - 60 * MIN);
    telegram.length = 0;
    for (let i = 0; i < 4; i++) await at(d, NOW + i * 30_000);
    expect(d.monitors.list().map((m) => [m.name, m.kind])).toEqual([["qkt-live", "heartbeat"]]);
    expect(telegram).toEqual([{ chat_id: "42", text: "bot1 · qkt-live is UP" }]);
  });

  it("leaves the heartbeat monitor exactly as it was", async () => {
    const d = live();
    quoteAge(d.db, "PROP_S01:EURUSD", NOW - 60 * MIN);
    touchInstance(d.db, "qkt-live", NOW, 1, NOW);
    const first = await tick(d, NOW);
    expect(first.map((t) => [t.name, t.kind, t.status])).toEqual([["qkt-live", "heartbeat", "up"]]);
    expect(d.monitors.list().map((m) => [m.name, m.status])).toEqual([["qkt-live", "up"], ["qkt-live market data", "pending"]]);
  });
});

describe("startMonitors", () => {
  it("ticks immediately and on the interval until stopped", async () => {
    const d = deps({ channels: { deadman: `${base}/ping` } });
    pings = 0;
    const stop = startMonitors(d, 20);
    await new Promise((r) => setTimeout(r, 120));
    stop();
    // a tick already in flight when the timer is cleared still lands
    await new Promise((r) => setTimeout(r, 40));
    const seen = pings;
    expect(seen).toBeGreaterThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 80));
    expect(pings).toBe(seen);
  });
});

describe("authAlertText", () => {
  it("announces sign-ins, sign-out-everywhere and lockouts, never single failures", async () => {
    const { authAlertText } = await import("../src/monitors.js");
    expect(authAlertText({ kind: "login", ip: "203.0.113.9", userAgent: "Safari" }, "forward")).toBe("forward · dashboard: new sign-in from 203.0.113.9 (Safari)");
    expect(authAlertText({ kind: "logout-all", ip: "203.0.113.9" }, null)).toBe("dashboard: every session was signed out from 203.0.113.9");
    expect(authAlertText({ kind: "lockout", ip: "198.51.100.7", lock: "ip" }, "forward")).toBe("forward · dashboard: sign-in locked for 198.51.100.7 after repeated failed attempts");
    expect(authAlertText({ kind: "lockout", ip: "198.51.100.7", lock: "global" }, null)).toContain("locked for everyone");
    expect(authAlertText({ kind: "failure", ip: "198.51.100.7" }, "forward")).toBeNull();
  });
});
