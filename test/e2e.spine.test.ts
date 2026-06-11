import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance; let base: string;
const token = "ingest-secret";

beforeAll(async () => {
  process.env.INSIGHTS_DB = join(mkdtempSync(join(tmpdir(), "qkti-")), "e2e.db");
  process.env.INGEST_TOKEN = token;
  process.env.ADMIN_USERNAME = "admin-user";
  process.env.ADMIN_PASSWORD = "admin-pw";
  process.env.SESSION_SECRET = "session-secret-key-at-least-32-chars!!";
  const { buildServer } = await import("../src/server.js");
  app = await buildServer("serve");
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(async () => { await app.close(); });

describe("spine e2e", () => {
  it("ingests a batch and serves it back through the authed API", async () => {
    const ingest = await fetch(`${base}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ instanceId: "qkt-prod", events: [
        { v: 1, instanceId: "qkt-prod", id: "t1", seq: 1, ts: 1718000000000, strategyId: "latch", type: "trade",
          payload: { orderId: "o1", symbol: "XAUUSD", side: "BUY", price: 2350, qty: 0.1, ts: 1718000000000 } },
      ] }),
    });
    expect(ingest.status).toBe(200);
    expect(await ingest.json()).toMatchObject({ accepted: 1 });

    const login = await fetch(`${base}/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin-user", password: "admin-pw" }),
    });
    expect(login.status).toBe(200);
    const session = String(login.headers.get("set-cookie")).split(";")[0]!;

    const trades = await fetch(`${base}/trades?instance=qkt-prod&symbol=XAUUSD`, { headers: { cookie: session } });
    expect(trades.status).toBe(200);
    const rows = await trades.json();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.symbol).toBe("XAUUSD");

    const search = await fetch(`${base}/search?q=XAUUSD&instance=qkt-prod`, { headers: { cookie: session } });
    expect((await search.json()).length).toBeGreaterThanOrEqual(1);
  });

  it("rejects API access without a session", async () => {
    const res = await fetch(`${base}/instances`);
    expect(res.status).toBe(401);
  });

  it("rejects login with a wrong username even when the password is right", async () => {
    const res = await fetch(`${base}/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "intruder", password: "admin-pw" }),
    });
    expect(res.status).toBe(401);
  });
});
