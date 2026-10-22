import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { openDb, LiveBus, LiveStateStore } from "@qkt-insights/store";
import { CONTRACT_VERSION, SUPPORTED_MAJORS, eventTypeMeta, payloadByType } from "@qkt-insights/contract";
import { INGEST_AUTH_FAILURES_PER_MINUTE, registerCollector, type IngestCapabilities } from "../src/index.js";

const AUTH = { authorization: "Bearer secret" };
let app: FastifyInstance;

async function collector(options: { bodyLimit?: number } = {}): Promise<FastifyInstance> {
  app = Fastify(options);
  registerCollector(app, { db: openDb(":memory:"), bus: new LiveBus(), liveState: new LiveStateStore(), ingestToken: "secret" });
  await app.ready();
  return app;
}

afterEach(async () => { await app.close(); });

/** A batch whose JSON body is exactly `bytes` long: one log envelope with a padded message. */
function batchOfSize(bytes: number): string {
  const body = (message: string) => JSON.stringify({ instanceId: "i", events: [
    { v: 1, instanceId: "i", id: "e1", seq: 1, ts: 1, type: "log", payload: { level: "INFO", logger: "x", message } },
  ] });
  return body("m".repeat(bytes - body("").length));
}

describe("GET /ingest/capabilities", () => {
  it("refuses a request without the ingest token, like /ingest", async () => {
    await collector();
    for (const headers of [{}, { authorization: "Bearer wrong" }]) {
      const res = await app.inject({ method: "GET", url: "/ingest/capabilities", headers });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "unauthorized" });
    }
  });

  it("shares the bad-token budget with /ingest", async () => {
    await collector();
    for (let i = 0; i < INGEST_AUTH_FAILURES_PER_MINUTE; i++) {
      await app.inject({ method: "POST", url: "/ingest", headers: { authorization: "Bearer wrong" }, payload: { instanceId: "i", events: [] } });
    }
    const res = await app.inject({ method: "GET", url: "/ingest/capabilities", headers: AUTH });
    expect(res.statusCode).toBe(429);
  });

  it("answers the contract version, majors and every type with its metadata", async () => {
    await collector();
    const res = await app.inject({ method: "GET", url: "/ingest/capabilities", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json<IngestCapabilities>();
    expect(Object.keys(body).sort()).toEqual(["contractVersion", "majors", "maxBatch", "maxBodyBytes", "types"]);
    expect(body.contractVersion).toBe(CONTRACT_VERSION);
    expect(body.majors).toEqual([...SUPPORTED_MAJORS]);
    expect(body.types.map((t) => t.type)).toEqual(Object.keys(payloadByType).sort());
    for (const t of body.types) expect(t).toEqual({ type: t.type, ...eventTypeMeta[t.type] });
    expect(body.maxBatch).toBeNull();
  });

  it("reports the body limit /ingest enforces", async () => {
    await collector();
    const { maxBodyBytes } = (await app.inject({ method: "GET", url: "/ingest/capabilities", headers: AUTH })).json<IngestCapabilities>();
    expect(maxBodyBytes).toBe(Fastify().initialConfig.bodyLimit);
  });

  it("follows a server-wide body limit: a body at it is ingested, one byte over is refused", async () => {
    await collector({ bodyLimit: 4096 });
    const { maxBodyBytes } = (await app.inject({ method: "GET", url: "/ingest/capabilities", headers: AUTH })).json<IngestCapabilities>();
    expect(maxBodyBytes).toBe(4096);
    const post = (payload: string) =>
      app.inject({ method: "POST", url: "/ingest", headers: { ...AUTH, "content-type": "application/json" }, payload });
    const at = await post(batchOfSize(maxBodyBytes));
    expect(at.statusCode).toBe(200);
    expect(at.json()).toMatchObject({ accepted: 1 });
    expect((await post(batchOfSize(maxBodyBytes + 1))).statusCode).toBe(413);
  });

  it("revalidates with an ETag and stays private to the token holder", async () => {
    await collector();
    const first = await app.inject({ method: "GET", url: "/ingest/capabilities", headers: AUTH });
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^"[\w-]+"$/);
    expect(first.headers["cache-control"]).toBe("private, no-cache");
    const again = await app.inject({ method: "GET", url: "/ingest/capabilities", headers: { ...AUTH, "if-none-match": etag } });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe("");
    const unauthorized = await app.inject({ method: "GET", url: "/ingest/capabilities", headers: { "if-none-match": etag } });
    expect(unauthorized.statusCode).toBe(401);
  });
});
