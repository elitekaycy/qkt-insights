import type { Db } from "./db.js";

export type MonitorKind = "heartbeat" | "http";
export type MonitorStatus = "up" | "down" | "pending";

export interface MonitorCheck {
  up: boolean;
  latencyMs?: number;
  /** Why the check failed, e.g. "503" or "mt5_status=degraded". */
  detail?: string;
}

export interface MonitorState {
  name: string;
  kind: MonitorKind;
  target: string;
  status: MonitorStatus;
  /** When the current status began; null while pending. */
  since: number | null;
  lastCheck: number | null;
  latencyMs: number | null;
  detail: string | null;
  /** Consecutive failed checks; a monitor goes down at DOWN_AFTER_FAILURES. */
  failures: number;
}

export interface MonitorTransition {
  name: string;
  kind: MonitorKind;
  target: string;
  status: "up" | "down";
  ts: number;
  detail: string | null;
}

export interface MonitorEventRow {
  monitor: string;
  ts: number;
  status: "up" | "down";
  detail: string | null;
}

/** One time bucket of the uptime strip; null = no checks recorded (collector was not running). */
export interface StripBucket {
  ts: number;
  status: "up" | "down" | null;
  checks: number;
  downs: number;
}

export interface MonitorSummary extends MonitorState {
  strip: StripBucket[];
  /** Fraction of checks that passed over the window; null with no checks. */
  uptime24h: number | null;
  uptime30d: number | null;
}

/** A single missed pulse is a hiccup; three in a row is an outage. Mirrors the guardian's healthcheck. */
export const DOWN_AFTER_FAILURES = 3;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
export const STRIP_BUCKETS = 48;
export const STRIP_BUCKET_MS = 30 * MINUTE_MS;

const UP_MINUTE_SQL = `INSERT INTO monitor_minutes (monitor, minute_ts, checks, downs, latency_ms)
  VALUES (@monitor, @minute, 1, @down, @latency)
  ON CONFLICT(monitor, minute_ts) DO UPDATE SET
    checks = checks + 1, downs = downs + @down,
    latency_ms = coalesce(excluded.latency_ms, latency_ms)`;

/**
 * Current status of every monitor, in memory, with transitions written through to
 * monitor_events and every check rolled into monitor_minutes. The last stored
 * transition is restored on first sight of a monitor so a collector restart neither
 * forgets an outage nor re-announces "up" for everything.
 */
export class Monitors {
  private states = new Map<string, MonitorState>();

  constructor(private db: Db) {}

  record(name: string, kind: MonitorKind, target: string, check: MonitorCheck, now: number): MonitorTransition | null {
    const s = this.states.get(name) ?? this.restore(name, kind, target);
    s.kind = kind;
    s.target = target;
    s.lastCheck = now;
    s.latencyMs = check.latencyMs ?? null;
    s.detail = check.up ? null : (check.detail ?? "check failed");
    s.failures = check.up ? 0 : s.failures + 1;
    this.db.prepare(UP_MINUTE_SQL).run({
      monitor: name, minute: Math.floor(now / MINUTE_MS) * MINUTE_MS,
      down: check.up ? 0 : 1, latency: check.latencyMs ?? null,
    });

    let next: MonitorStatus = s.status;
    if (check.up) next = "up";
    else if (s.failures >= DOWN_AFTER_FAILURES) next = "down";
    if (next === s.status || next === "pending") return null;

    s.status = next;
    s.since = now;
    this.db.prepare("INSERT OR REPLACE INTO monitor_events (monitor, ts, status, detail) VALUES (?,?,?,?)")
      .run(name, now, next, s.detail);
    return { name, kind, target, status: next, ts: now, detail: s.detail };
  }

  /** Drop monitors no longer declared, e.g. an instance retired from the roster. */
  retain(names: Set<string>): void {
    for (const name of this.states.keys()) if (!names.has(name)) this.states.delete(name);
  }

  list(): MonitorState[] {
    return [...this.states.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  }

  private restore(name: string, kind: MonitorKind, target: string): MonitorState {
    const last = this.db.prepare(
      "SELECT ts, status, detail FROM monitor_events WHERE monitor=? ORDER BY ts DESC LIMIT 1",
    ).get(name) as { ts: number; status: "up" | "down"; detail: string | null } | undefined;
    const s: MonitorState = {
      name, kind, target,
      status: last?.status ?? "pending",
      since: last?.ts ?? null,
      lastCheck: null, latencyMs: null,
      detail: last?.status === "down" ? last.detail : null,
      failures: 0,
    };
    this.states.set(name, s);
    return s;
  }
}

function uptime(db: Db, monitor: string, from: number): number | null {
  const r = db.prepare(
    "SELECT SUM(checks) checks, SUM(downs) downs FROM monitor_minutes WHERE monitor=? AND minute_ts >= ?",
  ).get(monitor, from) as { checks: number | null; downs: number | null };
  if (!r.checks) return null;
  return (r.checks - (r.downs ?? 0)) / r.checks;
}

/** The last 24h as STRIP_BUCKETS half-hour buckets, oldest first. Any down check paints the whole bucket. */
export function monitorStrip(db: Db, monitor: string, now: number): StripBucket[] {
  const end = Math.ceil(now / STRIP_BUCKET_MS) * STRIP_BUCKET_MS;
  const start = end - STRIP_BUCKETS * STRIP_BUCKET_MS;
  const rows = db.prepare(
    `SELECT (minute_ts - @start) / @bucket AS i, SUM(checks) checks, SUM(downs) downs
     FROM monitor_minutes WHERE monitor=@monitor AND minute_ts >= @start AND minute_ts < @end
     GROUP BY i`,
  ).all({ monitor, start, end, bucket: STRIP_BUCKET_MS }) as { i: number; checks: number; downs: number }[];
  const byIndex = new Map(rows.map((r) => [r.i, r]));
  return Array.from({ length: STRIP_BUCKETS }, (_, i) => {
    const r = byIndex.get(i);
    return {
      ts: start + i * STRIP_BUCKET_MS,
      status: r == null ? null : r.downs > 0 ? "down" : "up",
      checks: r?.checks ?? 0,
      downs: r?.downs ?? 0,
    };
  });
}

export function monitorSummaries(db: Db, monitors: Monitors, now: number): MonitorSummary[] {
  return monitors.list().map((s) => ({
    ...s,
    strip: monitorStrip(db, s.name, now),
    uptime24h: uptime(db, s.name, now - 24 * HOUR_MS),
    uptime30d: uptime(db, s.name, now - 30 * DAY_MS),
  }));
}

export function listMonitorEvents(db: Db, limit: number): MonitorEventRow[] {
  return db.prepare("SELECT monitor, ts, status, detail FROM monitor_events ORDER BY ts DESC LIMIT ?")
    .all(limit) as MonitorEventRow[];
}
