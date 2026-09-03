import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { openDb, Monitors, touchInstance } from "@qkt-insights/store";
import {
  HEARTBEAT_STALE_MS, channelsFromEnv, formatTransition, parseHttpMonitors, probe, startMonitors, tick,
  type MonitorRunnerDeps,
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
    touchInstance(d.db, "qkt-live", NOW - 10_000, 1);
    touchInstance(d.db, "qkt-bench", NOW - HEARTBEAT_STALE_MS - 1, 1);
    touchInstance(d.db, "qkt-retired", NOW - 31 * DAY, 1);
    telegram.length = 0; hooks.length = 0; pings = 0;

    const first = await tick(d, NOW);
    expect(first.map((t) => [t.name, t.status])).toEqual([["qkt-live", "up"]]);
    expect(d.monitors.list().map((m) => [m.name, m.status])).toEqual([["qkt-bench", "pending"], ["qkt-live", "up"]]);

    expect(await tick(d, NOW + 30_000)).toEqual([]);
    const third = await tick(d, NOW + 60_000);
    expect(third).toMatchObject([{ name: "qkt-bench", kind: "heartbeat", status: "down", detail: "silent for 150s" }]);

    expect(pings).toBe(3);
    expect(telegram).toEqual([
      { chat_id: "42", text: "bot2 · qkt-live is UP" },
      { chat_id: "42", text: "bot2 · qkt-bench is DOWN: silent for 150s" },
    ]);
    expect(hooks[1]).toMatchObject({ name: "qkt-bench", status: "down", brand: "bot2", text: "bot2 · qkt-bench is DOWN: silent for 150s" });

    touchInstance(d.db, "qkt-bench", NOW + 70_000, 2);
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
