import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { openDb, instanceHealth, LiveBus, LiveStateStore, type Db } from "@qkt-insights/store";
import { registerCollector } from "../src/index.js";

const INSTANCE = "qkt-prod";
const TS = 1718000000000;

let app: FastifyInstance;
let db: Db;
let bus: LiveBus;
beforeEach(async () => {
  db = openDb(":memory:");
  bus = new LiveBus();
  app = Fastify();
  registerCollector(app, { db, bus, liveState: new LiveStateStore(), ingestToken: "secret" });
  await app.ready();
});
afterEach(async () => { await app.close(); });

function env(p: Record<string, unknown>): Record<string, unknown> {
  return { v: 1, instanceId: INSTANCE, seq: 1, ts: TS, ...p };
}

const trade = (id: string, payload: Record<string, unknown> = {}) =>
  env({ id, strategyId: "latch", type: "trade",
    payload: { orderId: "o1", symbol: "XAUUSD", side: "BUY", price: 2350, qty: 0.1, ts: TS, ...payload } });

async function ingest(events: unknown[]) {
  const res = await app.inject({
    method: "POST", url: "/ingest",
    headers: { authorization: "Bearer secret" },
    payload: { instanceId: INSTANCE, events },
  });
  return { status: res.statusCode, body: res.json() };
}

const count = (table: string): number => (db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;

function quarantinedRow(id: string) {
  return db.prepare("SELECT instance_id instanceId, type, v, ts, reason, envelope FROM quarantined_events WHERE id=?").get(id) as
    { instanceId: string; type: string | null; v: number | null; ts: number | null; reason: string; envelope: string } | undefined;
}

describe("POST /ingest tolerates envelopes the contract cannot read", () => {
  it("stores the valid envelopes of a batch and quarantines an unknown type beside them", async () => {
    const published: string[] = [];
    bus.subscribe((e) => published.push(e.id));
    const { status, body } = await ingest([
      trade("t1"),
      env({ id: "future-1", type: "signal.future", payload: { anything: 1 } }),
      trade("t2"),
    ]);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      accepted: 2,
      quarantined: 1,
      envelopes: [
        { id: "t1", status: "accepted" },
        { id: "future-1", status: "quarantined", reason: 'unknown type "signal.future"' },
        { id: "t2", status: "accepted" },
      ],
      ack: { received: 3, acknowledgedIds: ["t1", "future-1", "t2"] },
    });
    expect(count("events")).toBe(2);
    expect(quarantinedRow("future-1")).toMatchObject({ instanceId: INSTANCE, type: "signal.future", v: 1, ts: TS });
    expect(JSON.parse(quarantinedRow("future-1")!.envelope)).toMatchObject({ type: "signal.future", payload: { anything: 1 } });
    expect(published).toEqual(["t1", "t2"]);
  });

  it("quarantines an unsupported major version", async () => {
    const { status, body } = await ingest([trade("t1"), { ...trade("t2"), v: 2 }]);
    expect(status).toBe(200);
    expect(body.envelopes).toEqual([
      { id: "t1", status: "accepted" },
      { id: "t2", status: "quarantined", reason: "unsupported major version 2" },
    ]);
    expect(count("events")).toBe(1);
    expect(quarantinedRow("t2")).toMatchObject({ type: "trade", v: 2 });
  });

  it("quarantines a payload whose required field was renamed", async () => {
    const renamed = trade("t-renamed");
    const payload = { ...(renamed.payload as Record<string, unknown>) };
    payload.quantity = payload.qty;
    delete payload.qty;
    const { status, body } = await ingest([{ ...renamed, payload }, trade("t-ok")]);
    expect(status).toBe(200);
    expect(body.envelopes[0]).toMatchObject({ id: "t-renamed", status: "quarantined" });
    expect(body.envelopes[0].reason).toContain("payload.qty");
    expect(body.envelopes[1]).toEqual({ id: "t-ok", status: "accepted" });
    expect(count("events")).toBe(1);
  });

  it("quarantines a numeric sent as a string instead of storing a mistyped price", async () => {
    const { status, body } = await ingest([trade("t-str", { price: "2350.5" }), trade("t-num")]);
    expect(status).toBe(200);
    expect(body.envelopes[0]).toMatchObject({ id: "t-str", status: "quarantined" });
    expect(body.envelopes[0].reason).toContain("payload.price");
    expect(count("events")).toBe(1);
  });

  it("quarantines an unknown side but keeps an unknown log level", async () => {
    const { status, body } = await ingest([
      trade("t-short", { side: "SHORT" }),
      env({ id: "log-trace", type: "log", payload: { level: "TRACE", logger: "com.qkt.Engine", message: "tick" } }),
    ]);
    expect(status).toBe(200);
    expect(body.envelopes).toEqual([
      expect.objectContaining({ id: "t-short", status: "quarantined" }),
      { id: "log-trace", status: "accepted" },
    ]);
    expect(body.envelopes[0].reason).toContain("payload.side");
    expect(db.prepare("SELECT level FROM logs WHERE id='log-trace'").get()).toEqual({ level: "TRACE" });
  });

  it("keeps a payload field the contract does not know", async () => {
    const { body } = await ingest([trade("t-extra", { venueTag: "fresh-field" })]);
    expect(body.envelopes).toEqual([{ id: "t-extra", status: "accepted" }]);
    const row = db.prepare("SELECT payload FROM events WHERE id='t-extra'").get() as { payload: string };
    expect(JSON.parse(row.payload)).toMatchObject({ venueTag: "fresh-field" });
  });

  it("stores a redelivered quarantined envelope once and acknowledges it again", async () => {
    const unknown = env({ id: "future-1", type: "signal.future", payload: {} });
    const first = await ingest([unknown]);
    const again = await ingest([unknown, trade("t1"), trade("t1")]);
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.body.envelopes).toEqual([
      { id: "future-1", status: "quarantined", reason: 'unknown type "signal.future"' },
      { id: "t1", status: "accepted" },
      { id: "t1", status: "duplicate" },
    ]);
    expect(count("quarantined_events")).toBe(1);
    expect(count("events")).toBe(1);
  });

  it("keys an envelope with no id by its content so redelivery stays idempotent", async () => {
    const broken = { v: 1, instanceId: INSTANCE, ts: TS, type: "trade", payload: {} };
    const a = await ingest([broken]);
    const b = await ingest([broken]);
    expect(a.status).toBe(200);
    expect(a.body.envelopes[0].id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(b.body.envelopes[0].id).toBe(a.body.envelopes[0].id);
    expect(count("quarantined_events")).toBe(1);
  });

  it("still rejects a batch whose envelope names another instance, even a quarantined one", async () => {
    const { status, body } = await ingest([trade("t1"), env({ id: "x", instanceId: "qkt-demo", type: "signal.future", payload: {} })]);
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: "instance mismatch" });
    expect(count("events")).toBe(0);
    expect(count("quarantined_events")).toBe(0);
  });

  it("still rejects a body that is not a batch", async () => {
    const res = await app.inject({
      method: "POST", url: "/ingest",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(400);
    expect((await ingest({} as unknown as unknown[])).status).toBe(400);
  });

  it("counts quarantined envelopes per type and major on instance health", async () => {
    await ingest([
      trade("t1"),
      env({ id: "f1", type: "signal.future", payload: {} }),
      env({ id: "f2", type: "signal.future", payload: {} }),
      { ...trade("t2"), v: 2 },
    ]);
    const row = instanceHealth(db).find((h) => h.instanceId === INSTANCE)!;
    expect(row.quarantined).toEqual([
      expect.objectContaining({ type: "signal.future", v: 1, count: 2, reason: 'unknown type "signal.future"' }),
      expect.objectContaining({ type: "trade", v: 2, count: 1, reason: "unsupported major version 2" }),
    ]);
  });
});

// Payloads copied from what qkt origin/dev builds for each type (observe/insights/*.kt,
// trade/BotEnvelopes.kt, trade/BotTrail.kt, cli/bot/BotAdjustCommands.kt); nulls are omitted
// on the wire, as qkt's InsightsEnvelope.toJson does.
describe("POST /ingest accepts the types qkt emits", () => {
  const golden: Record<string, Record<string, unknown>> = {
    // RiskInsights.fromSignalSuppressed
    "signal.suppressed": env({ id: `event-signal.suppressed-gold_trend-${TS}-41`, seq: 41, strategyId: "gold_trend",
      type: "signal.suppressed", payload: { reason: "portfolio gate: book risk cap reached", symbol: "EXNESS:XAUUSD", kind: "Buy" } }),
    // SignalInsights.fromSignal for Signal.Suppressed
    "signal.suppressed (dsl)": env({ id: `event-signal.suppressed-gold_trend-${TS}-42`, seq: 42, strategyId: "gold_trend",
      type: "signal.suppressed", payload: { intent: "SUPPRESSED", symbol: "EXNESS:XAUUSD", reason: "SIZING for 'gold' is 0, not a positive quantity" } }),
    // SessionInsights.statePersistence
    "state.persistence": env({ id: `persistence-gold_trend-${TS}`, seq: 0, strategyId: "gold_trend", type: "state.persistence",
      payload: { enabled: true, totalWrites: 1200, slowWrites: 3, failedWrites: 2, consecutiveFailures: 2, failureEpisodes: 1, queueSize: 0, callerRunsTotal: 0 } }),
    // SignalInsights.fromSignal for Signal.SubmitGroup
    "signal.structure": env({ id: `event-signal.structure-straddle-${TS}-7`, seq: 7, strategyId: "straddle", type: "signal.structure",
      payload: { intent: "OPEN_STRUCTURE", structureId: "straddle-1", alias: "entry", legs: "BUY 1 DERIBIT:BTC-C;BUY 1 DERIBIT:BTC-P" } }),
    // BotEnvelopes.botCommandEnvelope
    "bot.command": env({ id: `bot-command-0123456789ab-${TS}`, seq: 0, strategyId: "manual", type: "bot.command",
      payload: { source: "BUY EXNESS:XAUUSD 0.01", sha256: "0123456789abcdef", qktVersion: "0.60.0", argv: ["bot", "buy", "EXNESS:XAUUSD", "0.01"], symbol: "EXNESS:XAUUSD" } }),
    // BotTrail.recordEvent from BotModifyCommand
    "bot.modify": env({ id: `bot-bot.modify-${TS}-0`, seq: 0, strategyId: "manual", type: "bot.modify",
      payload: { symbol: "EXNESS:XAUUSD", ticket: "1001", sl: "2300.5", tp: "2400", ok: "true" } }),
    // BotTrail.recordEvent from BotCancelCommand, with a bot session's run tag
    "bot.cancel": env({ id: `bot-bot.cancel-${TS}-0`, seq: 0, strategyId: "manual", type: "bot.cancel",
      payload: { symbol: "EXNESS:XAUUSD", ticket: "1002", ok: "false", run: "run-1" } }),
  };

  for (const [name, envelope] of Object.entries(golden)) {
    it(`accepts ${name} and stores it as an event`, async () => {
      const { status, body } = await ingest([envelope]);
      expect(status).toBe(200);
      expect(body.envelopes).toEqual([{ id: envelope.id, status: "accepted" }]);
      const row = db.prepare("SELECT type, payload FROM events WHERE id=?").get(envelope.id) as { type: string; payload: string };
      expect(row.type).toBe(envelope.type);
      expect(JSON.parse(row.payload)).toEqual(envelope.payload);
      expect(count("quarantined_events")).toBe(0);
    });
  }
});
