import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import argon2 from "argon2";
import { openDb, LiveStateStore, Sessions } from "@qkt-insights/store";
import { registerAuth } from "../src/auth.js";
import { registerRest } from "../src/rest.js";
import { prefersHtml } from "../src/browser.js";

// What Chrome and Firefox send for a typed URL, and what fetch, curl and the web app send.
const CHROME = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7";
const FIREFOX = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

let app: FastifyInstance; let base: string; let session: string;
beforeAll(async () => {
  const db = openDb(":memory:");
  app = Fastify();
  await app.register(cookie);
  registerAuth(app, { username: "admin", passwordHash: await argon2.hash("pw"), sessions: new Sessions(db) });
  registerRest(app, { db, liveState: new LiveStateStore(), monitors: undefined as never });
  base = await app.listen({ port: 0, host: "127.0.0.1" });
  const login = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "pw" }) });
  session = String(login.headers.get("set-cookie")).split(";")[0]!;
});
afterAll(async () => { await app.close(); });

const open = (path: string, accept?: string, signedIn = true) =>
  fetch(`${base}${path}`, { redirect: "manual", headers: { ...(accept ? { accept } : {}), ...(signedIn ? { cookie: session } : {}) } });

describe("a browser on an API path", () => {
  it("is sent to the page the path names, signed in or not", async () => {
    for (const [path, page] of [["/trades", "/t"], ["/strategies", "/s"], ["/health", "/status"], ["/logs", "/log"], ["/search", "/log"], ["/trades/", "/t"], ["/trades?instance=x", "/t"]] as const) {
      const res = await open(path, CHROME);
      expect(res.status, path).toBe(302);
      expect(res.headers.get("location"), path).toBe(page);
    }
    const signedOut = await open("/strategies", FIREFOX, false);
    expect(signedOut.status).toBe(302);
    expect(signedOut.headers.get("location")).toBe("/s");
  });

  it("leaves API clients as they were: JSON, the any-type range, no Accept, and other methods", async () => {
    const json = await open("/trades", "application/json");
    expect(json.status).toBe(400);
    expect(await json.json()).toEqual({ error: "instance required" });
    expect((await open("/trades")).status).toBe(400);
    expect((await open("/trades", "*/*")).status).toBe(400);
    expect((await open("/strategies", "application/json, text/plain, */*", false)).status).toBe(401);
    expect((await open("/instances", CHROME)).status).toBe(200);
    const post = await fetch(`${base}/trades`, { method: "POST", redirect: "manual", headers: { accept: CHROME, cookie: session } });
    expect(post.status).not.toBe(302);
  });
});

describe("prefersHtml", () => {
  it("reads a navigation's Accept as HTML and an API client's as not", () => {
    expect(prefersHtml(CHROME)).toBe(true);
    expect(prefersHtml(FIREFOX)).toBe(true);
    expect(prefersHtml("text/html")).toBe(true);
    expect(prefersHtml(undefined)).toBe(false);
    expect(prefersHtml("*/*")).toBe(false);
    expect(prefersHtml("application/json")).toBe(false);
    expect(prefersHtml("application/json, text/html;q=0.5")).toBe(false);
    expect(prefersHtml("text/html;q=0, */*")).toBe(false);
    expect(prefersHtml("text/*")).toBe(false);
  });
});
