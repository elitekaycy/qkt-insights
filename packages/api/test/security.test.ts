import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerSecurity } from "../src/security.js";

let app: FastifyInstance;
afterEach(async () => { await app?.close(); });

async function build(opts: { requestsPerMinute?: number; trustProxy?: boolean } = {}) {
  app = Fastify({ trustProxy: opts.trustProxy ?? false });
  registerSecurity(app, { requestsPerMinute: opts.requestsPerMinute ?? 1000 });
  app.get("/data", async () => ({ secret: 1 }));
  app.get("/boom", async () => { throw new Error("SQLITE_ERROR near SELECT * FROM sessions"); });
  app.get("/bad", async (_req, reply) => reply.code(400).send({ error: "bad filter" }));
  app.post("/ingest", async () => ({ ok: true }));
  app.get("/healthz", async () => ({ ok: true }));
  await app.ready();
}

describe("security headers", () => {
  it("sends a strict CSP and the anti-framing, sniffing and referrer headers", async () => {
    await build();
    const res = await app.inject({ method: "GET", url: "/data", headers: { host: "forward.example" } });
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com wss://forward.example");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["cross-origin-opener-policy"]).toBe("same-origin");
  });

  it("marks API JSON as not cacheable", async () => {
    await build();
    expect((await app.inject({ method: "GET", url: "/data" })).headers["cache-control"]).toBe("no-store");
  });

  it("adds HSTS only when the request arrived over HTTPS", async () => {
    await build({ trustProxy: true });
    expect((await app.inject({ method: "GET", url: "/data" })).headers["strict-transport-security"]).toBeUndefined();
    const https = await app.inject({ method: "GET", url: "/data", headers: { "x-forwarded-proto": "https" } });
    expect(https.headers["strict-transport-security"]).toMatch(/max-age=\d+/);
  });

  it("does not let a hostile Host header inject into the CSP", async () => {
    await build();
    const res = await app.inject({ method: "GET", url: "/data", headers: { host: "a.example; script-src *" } });
    expect(String(res.headers["content-security-policy"])).not.toContain("script-src *");
  });
});

describe("shared link indexing", () => {
  it("asks search engines not to index shared pages", async () => {
    app = Fastify();
    registerSecurity(app, { requestsPerMinute: 1000 });
    app.get("/p/:token", async () => "page");
    app.get("/data", async () => ({}));
    await app.ready();
    expect((await app.inject({ method: "GET", url: "/p/abc" })).headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect((await app.inject({ method: "GET", url: "/data" })).headers["x-robots-tag"]).toBeUndefined();
  });
});

describe("error bodies", () => {
  it("hides internal error detail on 5xx", async () => {
    await build();
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("SQLITE");
    expect(res.json()).toEqual({ error: "internal error" });
  });

  it("keeps deliberate 4xx messages", async () => {
    await build();
    expect((await app.inject({ method: "GET", url: "/bad" })).json()).toEqual({ error: "bad filter" });
  });
});

describe("request budget", () => {
  it("answers 429 with Retry-After once an IP spends its budget", async () => {
    await build({ requestsPerMinute: 3 });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await app.inject({ method: "GET", url: "/data" })).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
    const res = await app.inject({ method: "GET", url: "/data" });
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("keys the budget on the forwarded client IP behind a trusted proxy", async () => {
    await build({ requestsPerMinute: 1, trustProxy: true });
    expect((await app.inject({ method: "GET", url: "/data", headers: { "x-forwarded-for": "1.1.1.1" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/data", headers: { "x-forwarded-for": "2.2.2.2" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/data", headers: { "x-forwarded-for": "1.1.1.1" } })).statusCode).toBe(429);
  });

  it("never throttles ingest or the health probe", async () => {
    await build({ requestsPerMinute: 1 });
    for (let i = 0; i < 5; i++) {
      expect((await app.inject({ method: "POST", url: "/ingest", payload: {} })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    }
  });
});
