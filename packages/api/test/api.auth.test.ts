import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import argon2 from "argon2";
import { registerAuth, requireSession } from "../src/auth.js";

let app: FastifyInstance;
let hash: string;
beforeEach(async () => {
  hash = await argon2.hash("hunter2");
  app = Fastify();
  await app.register(cookie);
  registerAuth(app, { username: "admin", passwordHash: hash, sessionSecret: "s3cret-session-key-at-least-32chars!" });
  app.get("/guarded", { preHandler: requireSession }, async () => ({ ok: true }));
  await app.ready();
});
afterEach(async () => { await app.close(); });

describe("auth", () => {
  it("rejects guarded routes without a session", async () => {
    const res = await app.inject({ method: "GET", url: "/guarded" });
    expect(res.statusCode).toBe(401);
  });

  it("logs in with the correct password and sets a cookie that unlocks guarded routes", async () => {
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "admin", password: "hunter2" } });
    expect(login.statusCode).toBe(200);
    const setCookie = login.headers["set-cookie"];
    expect(setCookie).toBeTruthy();
    const res = await app.inject({ method: "GET", url: "/guarded", headers: { cookie: String(setCookie).split(";")[0] } });
    expect(res.statusCode).toBe(200);
  });

  it("rejects login with the wrong password", async () => {
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "admin", password: "wrong" } });
    expect(login.statusCode).toBe(401);
  });

  it("rejects login with the wrong username", async () => {
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "nobody", password: "hunter2" } });
    expect(login.statusCode).toBe(401);
  });
});
