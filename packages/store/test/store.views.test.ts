import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import { parseUserAgent, Views, VIEW_DEDUPE_MS, VIEW_RETENTION_DAYS } from "../src/views.js";
import { pruneRetention } from "../src/retention.js";

const NOW = Date.UTC(2026, 8, 15, 12, 0);
const DAY = 86_400_000;
const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const SAFARI_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1";
const EDGE_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0";
const FIREFOX_ANDROID_TABLET = "Mozilla/5.0 (Android 14; Tablet; rv:130.0) Gecko/130.0 Firefox/130.0";
const SAMSUNG = "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36";
const BOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

const base = { instanceId: "i1", kind: "strategy" as const, subject: "gold", page: "strategy", strategyId: "gold", ip: "203.0.113.9", userAgent: CHROME_MAC, country: "GH", referrer: "t.co", language: "en-GB" };

describe("parseUserAgent", () => {
  it("names common browsers, systems and device classes", () => {
    expect(parseUserAgent(CHROME_MAC)).toEqual({ browser: "Chrome", os: "macOS", device: "desktop", bot: false });
    expect(parseUserAgent(SAFARI_IPHONE)).toEqual({ browser: "Safari", os: "iOS", device: "mobile", bot: false });
    expect(parseUserAgent(EDGE_WIN)).toEqual({ browser: "Edge", os: "Windows", device: "desktop", bot: false });
    expect(parseUserAgent(FIREFOX_ANDROID_TABLET)).toEqual({ browser: "Firefox", os: "Android", device: "tablet", bot: false });
    expect(parseUserAgent(SAMSUNG)).toEqual({ browser: "Samsung Internet", os: "Android", device: "mobile", bot: false });
  });

  it("flags crawlers and empty agents", () => {
    expect(parseUserAgent(BOT).bot).toBe(true);
    expect(parseUserAgent("curl/8.5.0").bot).toBe(true);
    expect(parseUserAgent("").bot).toBe(true);
  });
});

describe("Views", () => {
  it("records a view without storing the IP or the raw user agent", () => {
    const db = openDb(":memory:");
    expect(new Views(db).record(base, NOW)).toBe(true);
    const raw = JSON.stringify(db.prepare("SELECT * FROM share_views").all());
    expect(raw).not.toContain("203.0.113.9");
    expect(raw).not.toContain("Macintosh");
    expect(raw).toContain("Chrome");
  });

  it("ignores bots", () => {
    const db = openDb(":memory:");
    expect(new Views(db).record({ ...base, userAgent: BOT }, NOW)).toBe(false);
    expect(db.prepare("SELECT COUNT(*) n FROM share_views").get()).toEqual({ n: 0 });
  });

  it("counts a repeat of the same page by the same visitor once within the dedupe window", () => {
    const v = new Views(openDb(":memory:"));
    expect(v.record(base, NOW)).toBe(true);
    expect(v.record(base, NOW + 60_000)).toBe(false);
    expect(v.record({ ...base, page: "performance" }, NOW + 60_000)).toBe(true);
    expect(v.record(base, NOW + VIEW_DEDUPE_MS + 1)).toBe(true);
  });

  it("gives the same visitor the same id within a day and an unlinkable one the next day", () => {
    const db = openDb(":memory:");
    const v = new Views(db);
    v.record(base, NOW);
    v.record({ ...base, page: "calendar" }, NOW + 3600_000);
    v.record(base, NOW + DAY);
    const ids = (db.prepare("SELECT visitor FROM share_views ORDER BY ts").all() as Array<{ visitor: string }>).map((r) => r.visitor);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
    expect((db.prepare("SELECT day FROM view_salts").all() as Array<{ day: string }>).map((r) => r.day)).toEqual(["2026-09-16"]);
  });

  it("summarises views, unique visitors and every breakdown for a range", () => {
    const v = new Views(openDb(":memory:"));
    v.record(base, NOW - 2 * DAY);
    v.record({ ...base, ip: "198.51.100.4", userAgent: SAFARI_IPHONE, country: "US", referrer: null, language: "en-US" }, NOW);
    v.record({ ...base, ip: "198.51.100.5", userAgent: EDGE_WIN, kind: "overview", subject: "", page: "overview", strategyId: null, country: null, referrer: "google.com" }, NOW);
    const s = v.summary({ instanceId: "i1", from: NOW - 7 * DAY, to: NOW + 1 });
    expect(s.views).toBe(3);
    expect(s.visitors).toBe(3);
    expect(s.links).toEqual([
      { kind: "strategy", subject: "gold", views: 2, visitors: 2 },
      { kind: "overview", subject: "", views: 1, visitors: 1 },
    ]);
    expect(s.browsers).toEqual([{ key: "Chrome", views: 1 }, { key: "Edge", views: 1 }, { key: "Safari", views: 1 }]);
    expect(s.devices).toEqual([{ key: "desktop", views: 2 }, { key: "mobile", views: 1 }]);
    expect(s.countries).toEqual([{ key: "GH", views: 1 }, { key: "US", views: 1 }, { key: null, views: 1 }]);
    expect(s.referrers).toEqual([{ key: "google.com", views: 1 }, { key: "t.co", views: 1 }, { key: null, views: 1 }]);
    expect(s.daily).toEqual([{ day: "2026-09-13", views: 1, visitors: 1 }, { day: "2026-09-15", views: 2, visitors: 2 }]);
    expect(v.summary({ instanceId: "i1", from: NOW - DAY, to: NOW + 1 }).views).toBe(2);
    expect(v.summary({ instanceId: "i1", from: 0, to: NOW + 1, kind: "overview", subject: "" }).views).toBe(1);
  });

  it("lists recent views newest first, searchable across every text field", () => {
    const v = new Views(openDb(":memory:"));
    v.record(base, NOW - 1000);
    v.record({ ...base, ip: "198.51.100.4", userAgent: SAFARI_IPHONE, country: "US" }, NOW);
    expect(v.list({ instanceId: "i1", limit: 10 }).map((r) => r.browser)).toEqual(["Safari", "Chrome"]);
    expect(v.list({ instanceId: "i1", limit: 10, q: "ios" }).map((r) => r.os)).toEqual(["iOS"]);
    expect(v.list({ instanceId: "i1", limit: 10, q: "gh" }).map((r) => r.country)).toEqual(["GH"]);
    expect(v.list({ instanceId: "i1", limit: 10, q: "%" })).toEqual([]);
    expect(v.list({ instanceId: "i1", limit: 1, before: NOW }).map((r) => r.browser)).toEqual(["Chrome"]);
  });

  it("counts views per shared subject for the share controls", () => {
    const v = new Views(openDb(":memory:"));
    v.record(base, NOW);
    v.record({ ...base, ip: "198.51.100.4" }, NOW);
    expect(v.countsBySubject("i1")).toEqual(new Map([["strategy:gold", 2]]));
  });

  it("is pruned after its own retention window", () => {
    const db = openDb(":memory:");
    const v = new Views(db);
    v.record(base, NOW - (VIEW_RETENTION_DAYS + 1) * DAY);
    v.record({ ...base, page: "calendar" }, NOW);
    const r = pruneRetention(db, NOW);
    expect(r.views).toBe(1);
    expect(v.list({ instanceId: "i1", limit: 10 })).toHaveLength(1);
  });
});
