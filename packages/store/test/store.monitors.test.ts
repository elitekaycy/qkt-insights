import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import {
  DOWN_AFTER_FAILURES, Monitors, STRIP_BUCKETS, STRIP_BUCKET_MS,
  listMonitorEvents, monitorStrip, monitorSummaries,
} from "../src/monitors.js";
import { pruneRetention } from "../src/retention.js";

const NOW = 1_700_000_000_000;
const TICK = 30_000;
const DAY = 86_400_000;

function ticks(m: Monitors, name: string, results: boolean[], from = NOW) {
  return results.map((up, i) => m.record(name, "http", "http://gw/health", { up, latencyMs: up ? 12 : undefined, detail: up ? undefined : "HTTP 503" }, from + i * TICK));
}

describe("Monitors", () => {
  it("goes up on the first success and announces it once", () => {
    const db = openDb(":memory:");
    const m = new Monitors(db);
    const [first, second] = ticks(m, "gw", [true, true]);
    expect(first).toMatchObject({ name: "gw", status: "up", ts: NOW, detail: null });
    expect(second).toBeNull();
    expect(m.list()[0]).toMatchObject({ status: "up", since: NOW, latencyMs: 12, failures: 0 });
  });

  it("needs DOWN_AFTER_FAILURES straight failures before it is down, and one success to recover", () => {
    const db = openDb(":memory:");
    const m = new Monitors(db);
    const results = ticks(m, "gw", [true, false, false, false, false, true]);
    expect(results.map((t) => t?.status ?? null)).toEqual(["up", null, null, "down", null, "up"]);
    const down = results[DOWN_AFTER_FAILURES]!;
    expect(down.detail).toBe("HTTP 503");
    expect(listMonitorEvents(db, 10).map((e) => e.status)).toEqual(["up", "down", "up"]);
  });

  it("a single failure between successes never leaves the up state", () => {
    const db = openDb(":memory:");
    const m = new Monitors(db);
    const results = ticks(m, "gw", [true, false, true, false, true]);
    expect(results.slice(1).every((t) => t == null)).toBe(true);
    expect(m.list()[0]!.failures).toBe(0);
  });

  it("stays pending until it has either succeeded or failed enough", () => {
    const db = openDb(":memory:");
    const m = new Monitors(db);
    expect(ticks(m, "gw", [false, false])).toEqual([null, null]);
    expect(m.list()[0]!.status).toBe("pending");
    expect(ticks(m, "gw", [false], NOW + 2 * TICK)[0]).toMatchObject({ status: "down" });
  });

  it("restores the last transition so a restart keeps an outage and does not re-announce up", () => {
    const db = openDb(":memory:");
    ticks(new Monitors(db), "gw", [true, false, false, false]);

    const restarted = new Monitors(db);
    expect(restarted.record("gw", "http", "http://gw/health", { up: false, detail: "HTTP 503" }, NOW + 4 * TICK)).toBeNull();
    expect(restarted.list()[0]).toMatchObject({ status: "down", since: NOW + 3 * TICK, detail: "HTTP 503" });
    expect(restarted.record("gw", "http", "http://gw/health", { up: true }, NOW + 5 * TICK)).toMatchObject({ status: "up" });

    const again = new Monitors(db);
    expect(again.record("gw", "http", "http://gw/health", { up: true }, NOW + 6 * TICK)).toBeNull();
    expect(again.list()[0]!.since).toBe(NOW + 5 * TICK);
  });

  it("rolls every check into its minute and drops monitors no longer declared", () => {
    const db = openDb(":memory:");
    const m = new Monitors(db);
    ticks(m, "gw", [true, false, true]);
    m.record("qkt-prod", "heartbeat", "collector heartbeat", { up: true }, NOW);
    const minutes = db.prepare("SELECT monitor, minute_ts, checks, downs, latency_ms FROM monitor_minutes ORDER BY monitor, minute_ts").all();
    const minute = Math.floor(NOW / 60_000) * 60_000;
    expect(minutes).toEqual([
      { monitor: "gw", minute_ts: minute, checks: 2, downs: 1, latency_ms: 12 },
      { monitor: "gw", minute_ts: minute + 60_000, checks: 1, downs: 0, latency_ms: 12 },
      { monitor: "qkt-prod", minute_ts: minute, checks: 1, downs: 0, latency_ms: null },
    ]);
    expect(m.list().map((s) => s.name)).toEqual(["qkt-prod", "gw"]);
    m.retain(new Set(["gw"]));
    expect(m.list().map((s) => s.name)).toEqual(["gw"]);
  });
});

describe("monitorStrip and summaries", () => {
  it("buckets the last 24h, painting any failure red and unchecked time as unknown", () => {
    const db = openDb(":memory:");
    const m = new Monitors(db);
    const end = Math.ceil(NOW / STRIP_BUCKET_MS) * STRIP_BUCKET_MS;
    const start = end - STRIP_BUCKETS * STRIP_BUCKET_MS;
    m.record("gw", "http", "http://gw/health", { up: true }, start + 5 * STRIP_BUCKET_MS);
    m.record("gw", "http", "http://gw/health", { up: false }, start + 5 * STRIP_BUCKET_MS + TICK);
    m.record("gw", "http", "http://gw/health", { up: true }, start + 6 * STRIP_BUCKET_MS);
    m.record("gw", "http", "http://gw/health", { up: true }, start - TICK);

    const strip = monitorStrip(db, "gw", NOW);
    expect(strip).toHaveLength(STRIP_BUCKETS);
    expect(strip[0]!.ts).toBe(start);
    expect(strip[5]).toMatchObject({ status: "down", checks: 2, downs: 1 });
    expect(strip[6]).toMatchObject({ status: "up", checks: 1, downs: 0 });
    expect(strip[7]).toMatchObject({ status: null, checks: 0, downs: 0 });
    expect(strip.filter((b) => b.status == null)).toHaveLength(STRIP_BUCKETS - 2);
  });

  it("computes uptime over 24h and 30d from the rollups, null with no checks", () => {
    const db = openDb(":memory:");
    const m = new Monitors(db);
    ticks(m, "gw", [true, true, false, true], NOW - 3 * DAY);
    ticks(m, "gw", [true, true], NOW - 60_000);
    m.record("fresh", "http", "http://x/health", { up: false }, NOW);

    const [fresh, gw] = monitorSummaries(db, m, NOW);
    expect(gw).toMatchObject({ name: "gw", status: "up", uptime24h: 1, uptime30d: 5 / 6 });
    expect(gw!.strip).toHaveLength(STRIP_BUCKETS);
    expect(fresh).toMatchObject({ name: "fresh", status: "pending", uptime24h: 0, uptime30d: 0 });
    expect(monitorSummaries(db, new Monitors(db), NOW)).toEqual([]);
  });
});

describe("retention", () => {
  it("prunes old rollups and superseded transitions, keeping each monitor's latest", () => {
    const db = openDb(":memory:");
    const m = new Monitors(db);
    ticks(m, "gw", [true, false, false, false], NOW - 40 * DAY);
    ticks(m, "quiet", [true], NOW - 40 * DAY);
    ticks(m, "gw", [true], NOW - 5 * DAY);

    const r = pruneRetention(db, NOW);
    expect(r.monitors).toBe(5);
    expect(listMonitorEvents(db, 10)).toMatchObject([
      { monitor: "gw", status: "up", ts: NOW - 5 * DAY },
      { monitor: "quiet", status: "up", ts: NOW - 40 * DAY },
    ]);
    expect(new Monitors(db).record("quiet", "http", "http://q", { up: true }, NOW)).toBeNull();
  });
});
