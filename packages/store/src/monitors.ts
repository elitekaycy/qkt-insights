import type { Db } from "./db.js";

export type MonitorKind = "heartbeat" | "http" | "marketdata";
export type MonitorStatus = "up" | "down" | "pending";

export interface MonitorCheck {
  up: boolean;
  latencyMs?: number;
  /** Why the check failed, e.g. "503" or "mt5_status=degraded". */
  detail?: string;
  /** When a failure began, if known (a heartbeat's last-heard time): a down transition is stamped then. */
  since?: number;
  /** The failure is already an outage (silent past OUTAGE_AFTER_MS): down now, without waiting for more failures. */
  outage?: boolean;
  /** When a success began, if known (first heard after a silence): an up transition is stamped then. */
  upSince?: number;
  /** Not judged yet (a heartbeat the collector may only now be hearing again): neither a failure nor a success. */
  hold?: boolean;
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

/** One time bucket of the uptime strip; null = no checks recorded (collector was not running) and no outage known. */
export interface StripBucket {
  ts: number;
  status: "up" | "down" | null;
  checks: number;
  downs: number;
}

export interface MonitorSummary extends MonitorState {
  strip: StripBucket[];
  /**
   * Fraction of the window's minutes (from the monitor's first record) the monitor was up. A minute
   * inside an outage counts as down whether or not anything checked it; a minute nothing checked
   * outside an outage counts as unchecked, which is not up. null with no record in the window.
   */
  uptime24h: number | null;
  uptime30d: number | null;
  /** Fraction of the same minutes nothing checked and no outage covers: unknown, counted against uptime. */
  unchecked24h: number | null;
  unchecked30d: number | null;
}

/** A single missed pulse is a hiccup; three in a row is an outage. Mirrors the guardian's healthcheck. */
export const DOWN_AFTER_FAILURES = 3;

/**
 * Silence longer than this is an outage: the 90s heartbeat staleness plus the two further 30s ticks
 * DOWN_AFTER_FAILURES needs, so a gap is judged on the same floor as a live failure.
 */
export const OUTAGE_AFTER_MS = 150_000;

/** The collector's own incidents: the times nothing was checking because it was not running. */
export const COLLECTOR_MONITOR = "insights collector";

/** An outage written after the fact, from what was stored around it. */
export interface BackfilledOutage { monitor: string; from: number; to: number; detail: string }

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
export const STRIP_BUCKETS = 48;
export const STRIP_BUCKET_MS = 30 * MINUTE_MS;

const UP_MINUTE_SQL = `INSERT INTO monitor_minutes (monitor, minute_ts, checks, downs, latency_ms, last_ts)
  VALUES (@monitor, @minute, 1, @down, @latency, @now)
  ON CONFLICT(monitor, minute_ts) DO UPDATE SET
    checks = checks + 1, downs = downs + @down,
    latency_ms = coalesce(excluded.latency_ms, latency_ms),
    last_ts = max(coalesce(last_ts, 0), @now)`;

function minuteText(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

function spanText(ms: number): string {
  const m = Math.round(ms / MINUTE_MS);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/**
 * Current status of every monitor, in memory, with transitions written through to
 * monitor_events and every check rolled into monitor_minutes. The last stored
 * transition is restored on first sight of a monitor so a collector restart neither
 * forgets an outage nor re-announces "up" for everything.
 */
export class Monitors {
  private states = new Map<string, MonitorState>();
  /** The collector's previous tick; null before its first. */
  private lastTick: number | null = null;
  /** When the collector came back from an outage of its own (boot or stall); null when it has had none. */
  private resumed: number | null = null;

  constructor(private db: Db) {}

  /**
   * Called at the start of every tick. The first call (boot) finds every stretch of the retention
   * window in which nothing was checked for longer than an outage, the collector being down, up
   * to now; a later call finds a stall since the previous tick. Each becomes an incident of
   * COLLECTOR_MONITOR, once. Returns the incidents written.
   */
  noteTick(now: number): BackfilledOutage[] {
    const prev = this.lastTick;
    this.lastTick = now;
    const gaps = prev == null ? checkingGaps(this.db, now) : now - prev > OUTAGE_AFTER_MS ? [{ from: prev, to: now }] : [];
    const written: BackfilledOutage[] = [];
    for (const g of gaps) {
      const detail = `collector not running: nothing checked from ${minuteText(g.from)} to ${minuteText(g.to)} UTC (${spanText(g.to - g.from)})`;
      if (this.recordOutage(COLLECTOR_MONITOR, g.from, g.to, detail)) written.push({ monitor: COLLECTOR_MONITOR, ...g, detail });
    }
    const last = gaps[gaps.length - 1];
    if (last && last.to === now) this.resumed = now;
    return written;
  }

  /** When the collector came back from its own outage, if it did: a heartbeat last heard before then is not judged until replay had time to arrive. */
  resumedAt(): number | null {
    return this.resumed;
  }

  /**
   * Writes an outage of `name` from `from` to `to` that no live check saw, unless one already
   * covers it: a transition stored inside it, or the monitor already down when it began. Keeps the
   * in-memory status's start in step. Returns whether it wrote one.
   */
  recordOutage(name: string, from: number, to: number, detail: string): boolean {
    if (!(to - from > OUTAGE_AFTER_MS)) return false;
    const inside = this.db.prepare("SELECT 1 FROM monitor_events WHERE monitor=? AND ts BETWEEN ? AND ? LIMIT 1").get(name, from, to);
    if (inside) return false;
    const before = this.db.prepare("SELECT status FROM monitor_events WHERE monitor=? AND ts < ? ORDER BY ts DESC LIMIT 1").get(name, from) as { status: string } | undefined;
    if (before?.status === "down") return false;
    const insert = this.db.prepare("INSERT OR IGNORE INTO monitor_events (monitor, ts, status, detail) VALUES (?,?,?,?)");
    insert.run(name, from, "down", detail);
    insert.run(name, to, "up", null);
    const s = this.states.get(name);
    if (s && s.status === "up" && (s.since == null || s.since < to)) s.since = to;
    return true;
  }

  record(name: string, kind: MonitorKind, target: string, check: MonitorCheck, now: number): MonitorTransition | null {
    const s = this.states.get(name) ?? this.restore(name, kind, target);
    s.kind = kind;
    s.target = target;
    s.lastCheck = now;
    s.latencyMs = check.latencyMs ?? null;
    s.detail = check.up ? null : (check.detail ?? "check failed");
    if (check.hold) return null;
    s.failures = check.up ? 0 : s.failures + 1;
    this.db.prepare(UP_MINUTE_SQL).run({
      monitor: name, minute: Math.floor(now / MINUTE_MS) * MINUTE_MS,
      down: check.up ? 0 : 1, latency: check.latencyMs ?? null, now,
    });

    let next: MonitorStatus = s.status;
    if (check.up) next = "up";
    else if (check.outage || s.failures >= DOWN_AFTER_FAILURES) next = "down";
    if (next === s.status || next === "pending") return null;

    // A transition is stamped when it began when the check knows (never before the previous one).
    const began = next === "up" ? check.upSince : check.since;
    const ts = began != null && began <= now && (s.since == null || began > s.since) ? began : now;
    s.status = next;
    s.since = ts;
    this.db.prepare("INSERT OR REPLACE INTO monitor_events (monitor, ts, status, detail) VALUES (?,?,?,?)")
      .run(name, ts, next, s.detail);
    return { name, kind, target, status: next, ts, detail: s.detail };
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

/**
 * Every stretch since `now - RETENTION` in which no monitor was checked for longer than an
 * outage, the last one ending `now` when nothing has been checked since: the collector was not
 * running. Starts at the last check before (its exact time when stored, else the end of its
 * minute) and ends at the first minute checked after.
 */
function checkingGaps(db: Db, now: number): Array<{ from: number; to: number }> {
  const rows = db.prepare(
    `SELECT minute_ts m, MAX(coalesce(last_ts, minute_ts + ${MINUTE_MS - 1})) last FROM monitor_minutes
     WHERE minute_ts >= ? GROUP BY minute_ts ORDER BY minute_ts`,
  ).all(now - GAP_LOOKBACK_MS) as Array<{ m: number; last: number }>;
  const gaps: Array<{ from: number; to: number }> = [];
  for (let i = 1; i <= rows.length; i++) {
    const from = rows[i - 1]!.last;
    const to = i < rows.length ? rows[i]!.m : now;
    if (to - from > OUTAGE_AFTER_MS) gaps.push({ from, to });
  }
  return gaps;
}

/** How far back the boot scan looks for the collector's own outages: the retention window. */
const GAP_LOOKBACK_MS = 30 * DAY_MS;

/** The monitor's outages overlapping [from, to): each down transition to the next up, or to `to` while still down. */
function outages(db: Db, monitor: string, from: number, to: number): Array<[number, number]> {
  const before = db.prepare("SELECT ts, status FROM monitor_events WHERE monitor=? AND ts < ? ORDER BY ts DESC LIMIT 1").get(monitor, from) as { ts: number; status: string } | undefined;
  const events = db.prepare("SELECT ts, status FROM monitor_events WHERE monitor=? AND ts >= ? AND ts < ? ORDER BY ts").all(monitor, from, to) as Array<{ ts: number; status: string }>;
  const spans: Array<[number, number]> = [];
  let down: number | null = before?.status === "down" ? from : null;
  for (const e of events) {
    if (e.status === "down" && down == null) down = e.ts;
    else if (e.status === "up" && down != null) { spans.push([down, e.ts]); down = null; }
  }
  if (down != null) spans.push([down, to]);
  return spans;
}

/** Whole minutes [first, last] a span [a, b) touches. */
function minutesOf(a: number, b: number): [number, number] {
  return [Math.floor(a / MINUTE_MS) * MINUTE_MS, Math.floor((b - 1) / MINUTE_MS) * MINUTE_MS];
}

function availability(db: Db, monitor: string, from: number, now: number): { uptime: number | null; unchecked: number | null } {
  const first = db.prepare(
    "SELECT min((SELECT MIN(minute_ts) FROM monitor_minutes WHERE monitor=@m), coalesce((SELECT MIN(ts) FROM monitor_events WHERE monitor=@m), 9e15)) f",
  ).get({ m: monitor }) as { f: number | null };
  if (first.f == null || first.f >= 9e15) return { uptime: null, unchecked: null };
  const start = Math.floor(Math.max(from, first.f) / MINUTE_MS) * MINUTE_MS;
  const end = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  if (end < start) return { uptime: null, unchecked: null };
  const total = (end - start) / MINUTE_MS + 1;
  const checked = db.prepare(
    `SELECT COUNT(*) n, coalesce(SUM((checks - downs) * 1.0 / checks), 0) up FROM monitor_minutes
     WHERE monitor=? AND minute_ts >= ? AND minute_ts <= ? AND checks > 0`,
  ).get(monitor, start, end) as { n: number; up: number };
  const inside = db.prepare("SELECT COUNT(*) n FROM monitor_minutes WHERE monitor=? AND minute_ts >= ? AND minute_ts <= ? AND checks > 0");
  let uncheckedDown = 0;
  for (const [a, b] of outages(db, monitor, start, now)) {
    const [m0, m1] = minutesOf(Math.max(a, start), Math.max(b, a + 1));
    const span = (Math.min(m1, end) - m0) / MINUTE_MS + 1;
    if (span <= 0) continue;
    uncheckedDown += Math.max(0, span - (inside.get(monitor, m0, Math.min(m1, end)) as { n: number }).n);
  }
  const unchecked = Math.max(0, total - checked.n - uncheckedDown);
  return { uptime: Math.min(1, checked.up / total), unchecked: unchecked / total };
}

/**
 * The last 24h as STRIP_BUCKETS half-hour buckets, oldest first. Any down check paints the whole
 * bucket, as does a stored outage overlapping it, checked or not (the collector may have been down
 * with it); a bucket nothing checked and no outage covers is unknown.
 */
export function monitorStrip(db: Db, monitor: string, now: number): StripBucket[] {
  const end = Math.ceil(now / STRIP_BUCKET_MS) * STRIP_BUCKET_MS;
  const start = end - STRIP_BUCKETS * STRIP_BUCKET_MS;
  const rows = db.prepare(
    `SELECT (minute_ts - @start) / @bucket AS i, SUM(checks) checks, SUM(downs) downs
     FROM monitor_minutes WHERE monitor=@monitor AND minute_ts >= @start AND minute_ts < @end
     GROUP BY i`,
  ).all({ monitor, start, end, bucket: STRIP_BUCKET_MS }) as { i: number; checks: number; downs: number }[];
  const byIndex = new Map(rows.map((r) => [r.i, r]));
  const spans = outages(db, monitor, start, Math.min(now, end));
  return Array.from({ length: STRIP_BUCKETS }, (_, i) => {
    const r = byIndex.get(i);
    const ts = start + i * STRIP_BUCKET_MS;
    const inOutage = spans.some(([a, b]) => a < ts + STRIP_BUCKET_MS && b > ts);
    return {
      ts,
      status: r != null && r.downs > 0 ? "down" : inOutage ? "down" : r == null ? null : "up",
      checks: r?.checks ?? 0,
      downs: r?.downs ?? 0,
    };
  });
}

export function monitorSummaries(db: Db, monitors: Monitors, now: number): MonitorSummary[] {
  return monitors.list().map((s) => {
    const day = availability(db, s.name, now - 24 * HOUR_MS, now);
    const month = availability(db, s.name, now - 30 * DAY_MS, now);
    return {
      ...s,
      strip: monitorStrip(db, s.name, now),
      uptime24h: day.uptime,
      uptime30d: month.uptime,
      unchecked24h: day.unchecked,
      unchecked30d: month.unchecked,
    };
  });
}

export function listMonitorEvents(db: Db, limit: number): MonitorEventRow[] {
  return db.prepare("SELECT monitor, ts, status, detail FROM monitor_events ORDER BY ts DESC LIMIT ?")
    .all(limit) as MonitorEventRow[];
}
