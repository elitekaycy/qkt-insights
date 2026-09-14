import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import { Sessions, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, SESSION_TOUCH_MS } from "../src/sessions.js";

const NOW = 1_700_000_000_000;

describe("Sessions", () => {
  it("creates a session whose token resolves until it is revoked", () => {
    const s = new Sessions(openDb(":memory:"));
    const token = s.create({ ip: "1.2.3.4", userAgent: "ua" }, NOW);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.validate(token, NOW + 1000)).toBe(true);
    s.revoke(token);
    expect(s.validate(token, NOW + 2000)).toBe(false);
  });

  it("never stores the raw token", () => {
    const db = openDb(":memory:");
    const token = new Sessions(db).create({}, NOW);
    const rows = db.prepare("SELECT * FROM sessions").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("rejects unknown, empty and malformed tokens", () => {
    const s = new Sessions(openDb(":memory:"));
    s.create({}, NOW);
    expect(s.validate(undefined, NOW)).toBe(false);
    expect(s.validate("", NOW)).toBe(false);
    expect(s.validate("not-a-real-token", NOW)).toBe(false);
  });

  it("expires after the idle window without activity", () => {
    const s = new Sessions(openDb(":memory:"));
    const token = s.create({}, NOW);
    expect(s.validate(token, NOW + SESSION_IDLE_MS + 1)).toBe(false);
  });

  it("activity extends the idle window but never past the absolute lifetime", () => {
    const s = new Sessions(openDb(":memory:"));
    const token = s.create({}, NOW);
    let t = NOW;
    while (t + SESSION_IDLE_MS / 2 < NOW + SESSION_ABSOLUTE_MS) {
      t += SESSION_IDLE_MS / 2;
      expect(s.validate(token, t)).toBe(true);
    }
    expect(s.validate(token, NOW + SESSION_ABSOLUTE_MS + 1)).toBe(false);
  });

  it("writes last_seen at most once per touch interval", () => {
    const db = openDb(":memory:");
    const s = new Sessions(db);
    const token = s.create({}, NOW);
    s.validate(token, NOW + SESSION_TOUCH_MS - 1);
    const lastSeen = () => (db.prepare("SELECT last_seen FROM sessions").get() as { last_seen: number }).last_seen;
    expect(lastSeen()).toBe(NOW);
    s.validate(token, NOW + SESSION_TOUCH_MS + 1);
    expect(lastSeen()).toBe(NOW + SESSION_TOUCH_MS + 1);
  });

  it("revokeAll ends every session and prune drops only expired rows", () => {
    const db = openDb(":memory:");
    const s = new Sessions(db);
    const a = s.create({}, NOW);
    const b = s.create({}, NOW);
    expect(s.revokeAll()).toBe(2);
    expect(s.validate(a, NOW)).toBe(false);
    expect(s.validate(b, NOW)).toBe(false);

    s.create({}, NOW);
    const fresh = s.create({}, NOW + SESSION_IDLE_MS);
    expect(s.prune(NOW + SESSION_IDLE_MS + 1)).toBe(1);
    expect(s.validate(fresh, NOW + SESSION_IDLE_MS + 2)).toBe(true);
  });

  it("knows which IPs hold a live session", () => {
    const s = new Sessions(openDb(":memory:"));
    const token = s.create({ ip: "198.51.100.10" }, NOW);
    expect(s.hasLiveSessionFrom("198.51.100.10", NOW + 1000)).toBe(true);
    expect(s.hasLiveSessionFrom("203.0.113.1", NOW + 1000)).toBe(false);
    expect(s.hasLiveSessionFrom("198.51.100.10", NOW + SESSION_IDLE_MS + 1)).toBe(false);
    s.revoke(token);
    expect(s.hasLiveSessionFrom("198.51.100.10", NOW + 1000)).toBe(false);
  });
});
