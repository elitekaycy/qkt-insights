import { describe, it, expect } from "vitest";
import { buildServer, parseMode } from "../src/server.js";

describe("parseMode", () => {
  it("defaults to run", () => expect(parseMode([])).toBe("run"));
  it("accepts collect/serve/run", () => {
    expect(parseMode(["collect"])).toBe("collect");
    expect(parseMode(["serve"])).toBe("serve");
    expect(parseMode(["run"])).toBe("run");
  });
  it("throws on an unknown mode", () => expect(() => parseMode(["bogus"])).toThrow());
});

describe("healthz", () => {
  it("serves an unauthenticated readiness response", async () => {
    process.env.INSIGHTS_DB = ":memory:";
    process.env.INGEST_TOKEN = "test-token";
    process.env.ADMIN_USERNAME = "admin";
    process.env.ADMIN_PASSWORD = "admin-pass";
    process.env.SESSION_SECRET = "test-session-secret-at-least-32-chars";

    const app = await buildServer("collect");
    const res = await app.inject({ method: "GET", url: "/healthz" });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, mode: "collect" });
  });
});
