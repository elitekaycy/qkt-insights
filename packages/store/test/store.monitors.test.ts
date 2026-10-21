import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import {
  COLLECTOR_MONITOR, DOWN_AFTER_FAILURES, Monitors, OUTAGE_AFTER_MS, STRIP_BUCKETS, STRIP_BUCKET_MS,
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
    // Minutes since the monitor's first record, unchecked ones not up: 24h holds 1441 minutes of
    // which one was checked (up); 30d starts 3 days back, 4321 minutes, 2.5 of them up.
    expect(gw).toMatchObject({ name: "gw", status: "up" });
    expect(gw!.uptime24h).toBeCloseTo(1 / 1441, 12);
    expect(gw!.unchecked24h).toBeCloseTo(1440 / 1441, 12);
    expect(gw!.uptime30d).toBeCloseTo(2.5 / 4321, 12);
    expect(gw!.unchecked30d).toBeCloseTo(4318 / 4321, 12);
    expect(gw!.strip).toHaveLength(STRIP_BUCKETS);
    expect(fresh).toMatchObject({ name: "fresh", status: "pending", uptime24h: 0, uptime30d: 0, unchecked24h: 0 });
    expect(monitorSummaries(db, new Monitors(db), NOW)).toEqual([]);
  });
});

describe("outages nothing checked", () => {
  const MIN = 60_000;
  const T0 = Math.floor(NOW / MIN) * MIN;
  const upEveryMinute = (m: Monitors, name: string, from: number, minutes: number) => {
    for (let i = 0; i < minutes; i++) m.record(name, "heartbeat", "collector heartbeat", { up: true }, from + i * MIN);
  };

  it("counts an outage's unchecked minutes as down, and other unchecked minutes as unchecked", () => {
    const db = openDb(":memory:");
    const m = new Monitors(db);
    upEveryMinute(m, "a", T0, 10);
    expect(m.recordOutage("a", T0 + 10 * MIN, T0 + 40 * MIN, "silent")).toBe(true);
    upEveryMinute(m, "a", T0 + 40 * MIN, 10);
    upEveryMinute(m, "b", T0, 10);
    upEveryMinute(m, "b", T0 + 40 * MIN, 10);
    const [a, b] = monitorSummaries(db, m, T0 + 49 * MIN);
    expect(a).toMatchObject({ name: "a", uptime24h: 20 / 50, unchecked24h: 0 });
    expect(b).toMatchObject({ name: "b", uptime24h: 20 / 50, unchecked24h: 30 / 50 });
    const strip = monitorStrip(db, "a", T0 + 49 * MIN);
    const strip30 = Math.floor((T0 + 20 * MIN - strip[0]!.ts) / STRIP_BUCKET_MS);
    expect(strip[strip30]).toMatchObject({ status: "down", checks: 0 });
    expect(monitorStrip(db, "b", T0 + 49 * MIN)[strip30]!.status).toBe(null);
  });

  it("writes an outage once, never over a stored transition or an outage already open", () => {
    const db = openDb(":memory:");
    const m = new Monitors(db);
    upEveryMinute(m, "a", T0, 2);
    expect(m.recordOutage("a", T0 + 5 * MIN, T0 + 5 * MIN + OUTAGE_AFTER_MS, "short")).toBe(false);
    expect(m.recordOutage("a", T0 + 5 * MIN, T0 + 30 * MIN, "silent")).toBe(true);
    expect(m.recordOutage("a", T0 + 5 * MIN, T0 + 30 * MIN, "silent")).toBe(false);
    expect(m.list()[0]).toMatchObject({ status: "up", since: T0 + 30 * MIN });
    expect(listMonitorEvents(db, 10).map((e) => [e.ts - T0, e.status])).toEqual([[30 * MIN, "up"], [5 * MIN, "down"], [0, "up"]]);
  });

  it("finds the collector's own outages at boot from the gaps in checking, to the minute it came back", () => {
    const db = openDb(":memory:");
    const before = new Monitors(db);
    expect(before.noteTick(T0)).toEqual([]);
    // checks every 30s, a one-minute restart (not an outage), more checks, then dark
    for (let t = T0; t <= T0 + 20 * MIN; t += 30_000) before.record("gw", "http", "u", { up: true }, t);
    for (let t = T0 + 21 * MIN; t <= T0 + 30 * MIN; t += 30_000) before.record("gw", "http", "u", { up: true }, t);
    const boot = T0 + 30 * MIN + 6.5 * 60 * MIN;
    const booted = new Monitors(db);
    const written = booted.noteTick(boot);
    expect(written).toEqual([{ monitor: COLLECTOR_MONITOR, from: T0 + 30 * MIN, to: boot, detail: expect.stringContaining("(6h30m)") }]);
    expect(booted.resumedAt()).toBe(boot);
    expect(booted.noteTick(boot + 30_000)).toEqual([]);
    expect(new Monitors(db).noteTick(boot + 60_000)).toEqual([]);
    // a stall inside one run is one too
    expect(booted.noteTick(boot + 30_000 + OUTAGE_AFTER_MS + 1)).toHaveLength(1);
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
