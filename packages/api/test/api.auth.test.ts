import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import argon2 from "argon2";
import { openDb, Sessions, type Db } from "@qkt-insights/store";
import { registerAuth, requireSession, type AuthEvent } from "../src/auth.js";
import { LoginGuard } from "../src/limits.js";
import { TotpVerifier, generateTotpSecret, totpAt } from "../src/totp.js";

const SECRET = generateTotpSecret();
let hash: string;
let app: FastifyInstance;
let db: Db;
let events: AuthEvent[];

async function build(opts: { totp?: boolean; guard?: LoginGuard; trustProxy?: boolean } = {}) {
  db = openDb(":memory:");
  events = [];
  app = Fastify({ trustProxy: opts.trustProxy ?? false });
  await app.register(cookie);
  registerAuth(app, {
    username: "admin",
    passwordHash: hash,
    sessions: new Sessions(db),
    totp: opts.totp ? new TotpVerifier(SECRET) : undefined,
    guard: opts.guard,
    onEvent: (e) => events.push(e),
  });
  app.get("/guarded", { preHandler: requireSession }, async () => ({ ok: true }));
  await app.ready();
}

function login(payload: Record<string, unknown>, headers: Record<string, string> = {}) {
  return app.inject({ method: "POST", url: "/auth/login", payload, headers });
}

function cookieOf(res: { headers: Record<string, unknown> }): string {
  return String(res.headers["set-cookie"]).split(";")[0]!;
}

beforeEach(async () => {
  hash ??= await argon2.hash("hunter2-long-password");
});
afterEach(async () => {
  await app?.close();
});

describe("login and sessions", () => {
  beforeEach(() => build());

  it("rejects guarded routes without a session", async () => {
    expect((await app.inject({ method: "GET", url: "/guarded" })).statusCode).toBe(401);
  });

  it("logs in and the cookie unlocks guarded routes", async () => {
    const res = await login({ username: "admin", password: "hunter2-long-password" });
    expect(res.statusCode).toBe(200);
    const guarded = await app.inject({ method: "GET", url: "/guarded", headers: { cookie: cookieOf(res) } });
    expect(guarded.statusCode).toBe(200);
    expect(events.map((e) => e.kind)).toEqual(["login"]);
  });

  it("issues a different random token on every login", async () => {
    const a = cookieOf(await login({ username: "admin", password: "hunter2-long-password" }));
    const b = cookieOf(await login({ username: "admin", password: "hunter2-long-password" }));
    expect(a).not.toBe(b);
  });

  it("sets an HttpOnly SameSite=Strict cookie with a max age, and no Secure flag over plain HTTP", async () => {
    const header = String((await login({ username: "admin", password: "hunter2-long-password" })).headers["set-cookie"]);
    expect(header).toMatch(/HttpOnly/);
    expect(header).toMatch(/SameSite=Strict/);
    expect(header).toMatch(/Max-Age=\d+/);
    expect(header).not.toMatch(/Secure/);
  });

  it("rejects the wrong password and the wrong username with the same response", async () => {
    const wrongPw = await login({ username: "admin", password: "wrong" });
    const wrongUser = await login({ username: "nobody", password: "hunter2-long-password" });
    expect(wrongPw.statusCode).toBe(401);
    expect(wrongUser.statusCode).toBe(401);
    expect(wrongPw.json()).toEqual(wrongUser.json());
    expect(events.filter((e) => e.kind === "failure")).toHaveLength(2);
  });

  it("rejects non-string and oversized credentials without crashing", async () => {
    expect((await login({ username: ["admin"], password: { a: 1 } })).statusCode).toBe(400);
    expect((await login({ username: "admin", password: "x".repeat(5000) })).statusCode).toBeGreaterThanOrEqual(400);
  });

  it("logout revokes the session on the server, not just the cookie", async () => {
    const session = cookieOf(await login({ username: "admin", password: "hunter2-long-password" }));
    await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie: session } });
    expect((await app.inject({ method: "GET", url: "/guarded", headers: { cookie: session } })).statusCode).toBe(401);
  });

  it("sign out everywhere revokes every session and needs a session itself", async () => {
    expect((await app.inject({ method: "POST", url: "/auth/logout-all" })).statusCode).toBe(401);
    const phone = cookieOf(await login({ username: "admin", password: "hunter2-long-password" }));
    const laptop = cookieOf(await login({ username: "admin", password: "hunter2-long-password" }));
    expect((await app.inject({ method: "POST", url: "/auth/logout-all", headers: { cookie: laptop } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/guarded", headers: { cookie: phone } })).statusCode).toBe(401);
    expect(events.map((e) => e.kind)).toContain("logout-all");
  });

  it("rejects a forged cookie", async () => {
    const res = await app.inject({ method: "GET", url: "/guarded", headers: { cookie: "qkt_insights_session=admin.deadbeef" } });
    expect(res.statusCode).toBe(401);
  });

  it("refuses a cross-origin login", async () => {
    const res = await login({ username: "admin", password: "hunter2-long-password" }, { origin: "https://evil.example", host: "forward.example" });
    expect(res.statusCode).toBe(403);
  });

  it("accepts a same-origin login", async () => {
    const res = await login({ username: "admin", password: "hunter2-long-password" }, { origin: "https://forward.example", host: "forward.example" });
    expect(res.statusCode).toBe(200);
  });

  it("reports whether a second factor is required", async () => {
    expect((await app.inject({ method: "GET", url: "/auth/methods" })).json()).toEqual({ totp: false });
  });
});

describe("secure cookie behind a TLS proxy", () => {
  it("marks the cookie Secure when the proxy says the request was HTTPS", async () => {
    await build({ trustProxy: true });
    const res = await login({ username: "admin", password: "hunter2-long-password" }, { "x-forwarded-proto": "https" });
    expect(String(res.headers["set-cookie"])).toMatch(/Secure/);
  });
});

describe("login throttling", () => {
  it("locks an IP after its failure budget, even for the right password, and says when to retry", async () => {
    await build({ guard: new LoginGuard({ perIpFailures: 3, globalFailures: 100, windowMs: 900_000, lockMs: 900_000 }) });
    for (let i = 0; i < 3; i++) expect((await login({ username: "admin", password: "nope" })).statusCode).toBe(401);
    const locked = await login({ username: "admin", password: "hunter2-long-password" });
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
    expect(events.map((e) => e.kind)).toContain("lockout");
  });
});

describe("global lock cannot shut the operator out", () => {
  it("an IP that already holds a session still signs in while strangers are globally locked", async () => {
    await build({ guard: new LoginGuard({ perIpFailures: 100, globalFailures: 3, windowMs: 900_000, lockMs: 900_000 }) });
    const home = { remoteAddress: "198.51.100.10" };
    const first = await app.inject({ method: "POST", url: "/auth/login", ...home, payload: { username: "admin", password: "hunter2-long-password" } });
    expect(first.statusCode).toBe(200);
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: "POST", url: "/auth/login", remoteAddress: `203.0.113.${i}`, payload: { username: "admin", password: "nope" } });
    }
    const stranger = await app.inject({ method: "POST", url: "/auth/login", remoteAddress: "203.0.113.200", payload: { username: "admin", password: "hunter2-long-password" } });
    expect(stranger.statusCode).toBe(429);
    const again = await app.inject({ method: "POST", url: "/auth/login", ...home, payload: { username: "admin", password: "hunter2-long-password" } });
    expect(again.statusCode).toBe(200);
  });
});

describe("second factor", () => {
  beforeEach(() => build({ totp: true }));

  it("advertises the second factor", async () => {
    expect((await app.inject({ method: "GET", url: "/auth/methods" })).json()).toEqual({ totp: true });
  });

  it("refuses the right password without a code or with a wrong code", async () => {
    expect((await login({ username: "admin", password: "hunter2-long-password" })).statusCode).toBe(401);
    expect((await login({ username: "admin", password: "hunter2-long-password", code: "000000" })).statusCode).toBe(401);
  });

  it("accepts the right password with the current code, once", async () => {
    const code = totpAt(SECRET, Date.now());
    expect((await login({ username: "admin", password: "hunter2-long-password", code })).statusCode).toBe(200);
    expect((await login({ username: "admin", password: "hunter2-long-password", code })).statusCode).toBe(401);
  });
});
