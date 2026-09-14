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
    process.env.INGEST_TOKEN = "test-ingest-token-at-least-24-chars";
    process.env.ADMIN_USERNAME = "admin";
    process.env.ADMIN_PASSWORD = "admin-pass-long-enough";

    const app = await buildServer("collect");
    const res = await app.inject({ method: "GET", url: "/healthz" });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, mode: "collect" });
  });
});

describe("STRATEGY_CAPITAL", () => {
  it("refuses to start on a malformed capital map", async () => {
    process.env.INSIGHTS_DB = ":memory:";
    process.env.INGEST_TOKEN = "test-ingest-token-at-least-24-chars";
    process.env.STRATEGY_CAPITAL = '{"gold":-1}';
    try {
      await expect(buildServer("collect")).rejects.toThrow("STRATEGY_CAPITAL.gold must be a positive number");
    } finally {
      delete process.env.STRATEGY_CAPITAL;
    }
  });
});

describe("internet-facing defaults", () => {
  function serveEnv() {
    process.env.INSIGHTS_DB = ":memory:";
    process.env.INGEST_TOKEN = "test-ingest-token-at-least-24-chars";
    process.env.ADMIN_USERNAME = "admin";
    process.env.ADMIN_PASSWORD = "admin-pass-long-enough";
    delete process.env.ADMIN_TOTP_SECRET;
    delete process.env.TRUST_PROXY;
  }

  it("refuses to start with a short ingest token", async () => {
    serveEnv();
    process.env.INGEST_TOKEN = "short-token";
    await expect(buildServer("collect")).rejects.toThrow("INGEST_TOKEN must be at least 24 characters");
  });

  it("refuses to serve the dashboard with a short admin password", async () => {
    serveEnv();
    process.env.ADMIN_PASSWORD = "password";
    await expect(buildServer("serve")).rejects.toThrow("ADMIN_PASSWORD must be at least 12 characters");
  });

  it("refuses a second-factor secret that is not base32", async () => {
    serveEnv();
    process.env.ADMIN_TOTP_SECRET = "not-base32!";
    try {
      await expect(buildServer("serve")).rejects.toThrow("ADMIN_TOTP_SECRET");
    } finally {
      delete process.env.ADMIN_TOTP_SECRET;
    }
  });

  it("sends security headers and trusts a loopback proxy for the Secure cookie", async () => {
    serveEnv();
    const app = await buildServer("serve");
    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.headers["x-frame-options"]).toBe("DENY");
    const login = await app.inject({
      method: "POST", url: "/auth/login", remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.9" },
      payload: { username: "admin", password: "admin-pass-long-enough" },
    });
    await app.close();
    expect(login.statusCode).toBe(200);
    expect(String(login.headers["set-cookie"])).toMatch(/Secure/);
  });

  it("does not trust forwarding headers from a Tailscale IPv6 or LAN address", async () => {
    serveEnv();
    const app = await buildServer("serve");
    for (const remoteAddress of ["fd7a:115c:a1e0::1", "192.168.1.20", "100.101.102.103"]) {
      const login = await app.inject({
        method: "POST", url: "/auth/login", remoteAddress,
        headers: { "x-forwarded-proto": "https" },
        payload: { username: "admin", password: "admin-pass-long-enough" },
      });
      expect(String(login.headers["set-cookie"])).not.toMatch(/Secure/);
    }
    await app.close();
  });

  it("trusts a proxy container on a docker bridge network", async () => {
    serveEnv();
    const app = await buildServer("serve");
    const login = await app.inject({
      method: "POST", url: "/auth/login", remoteAddress: "172.19.0.5",
      headers: { "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.9" },
      payload: { username: "admin", password: "admin-pass-long-enough" },
    });
    await app.close();
    expect(String(login.headers["set-cookie"])).toMatch(/Secure/);
  });

  it("does not trust forwarding headers from a public address", async () => {
    serveEnv();
    const app = await buildServer("serve");
    const login = await app.inject({
      method: "POST", url: "/auth/login", remoteAddress: "198.51.100.7",
      headers: { "x-forwarded-proto": "https" },
      payload: { username: "admin", password: "admin-pass-long-enough" },
    });
    await app.close();
    expect(String(login.headers["set-cookie"])).not.toMatch(/Secure/);
  });
});

describe("totp-setup", () => {
  it("prints a fresh secret and its authenticator URI", async () => {
    const { totpSetupText } = await import("../src/server.js");
    const text = totpSetupText("forward");
    const secret = /ADMIN_TOTP_SECRET=([A-Z2-7]{32})/.exec(text)?.[1];
    expect(secret).toBeTruthy();
    expect(text).toContain(`otpauth://totp/qkt-insights:forward?secret=${secret}`);
  });
});
