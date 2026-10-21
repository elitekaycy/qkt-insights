import type { Database } from "better-sqlite3";
import { VIEW_RETENTION_DAYS } from "./views.js";
import { bumpEpoch } from "./versions.js";
import { refreshProjections } from "./projections.js";

/** Days of operational history kept before the weekly prune. Trade events (the analytics source of
 * truth) and marks for still-open positions are exempt regardless of age. */
export const RETENTION_DAYS = 30;

const DAY_MS = 86_400_000;

/**
 * Bounds on one prune step, so a step stays in the tens of milliseconds and ingest waits at most
 * that long: rows looked at, and rows deleted (a full-text row is the expensive one to delete).
 */
const EXAMINE_PER_STEP = 2000;
const DELETE_PER_STEP = 200;

export interface RetentionResult {
  /** logs rows removed (with their FTS mirror). */
  logs: number;
  /** non-`trade` events removed (with their FTS mirror). */
  events: number;
  /** position_valuations marks removed for positions no longer open. */
  valuations: number;
  /** monitor_minutes rollups and superseded monitor_events removed. */
  monitors: number;
  /** shared-link page views older than VIEW_RETENTION_DAYS removed. */
  views: number;
  /** quarantined envelopes received before the cutoff removed. */
  quarantined: number;
}

/** A prune runs as steps, each its own short transaction; it yields between steps and returns its counts. */
export type PruneSteps<T> = Generator<void, T, void>;

/** Runs every step at once: for tests and callers that do not need to yield. */
function runSteps<T>(steps: PruneSteps<T>): T {
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/** Distinct values of an indexed leading column, one seek each (instead of scanning the index). */
function distinctLeading(db: Database, table: string, column: string): string[] {
  return (db.prepare(
    `WITH RECURSIVE v(x) AS (SELECT MIN(${column}) FROM ${table}
       UNION ALL SELECT (SELECT MIN(${column}) FROM ${table} WHERE ${column} > v.x) FROM v WHERE v.x IS NOT NULL)
     SELECT x FROM v WHERE x IS NOT NULL`,
  ).all() as Array<{ x: string }>).map((r) => r.x);
}

/**
 * Deletes the rows of `table` matching `match` (SQL over alias t, named parameters from `params`)
 * together with their full-text mirror rows. Walks the mirror in rowid order, then the table for
 * matching rows without a mirror row. Returns the table rows removed.
 */
function* sweepWithFts(db: Database, o: { table: string; fts: string; link: string; match: string; params: Record<string, unknown> }): PruneSteps<number> {
  const examine = db.prepare(
    `SELECT f.rowid fr, t.rowid tr, CASE WHEN t.rowid IS NOT NULL AND (${o.match}) THEN 1 ELSE 0 END hit
     FROM ${o.fts} f LEFT JOIN ${o.table} t ON t.rowid = f.${o.link}
     WHERE f.rowid > @after ORDER BY f.rowid LIMIT @limit`,
  );
  const plain = db.prepare(`SELECT t.rowid tr, CASE WHEN ${o.match} THEN 1 ELSE 0 END hit FROM ${o.table} t WHERE t.rowid > @after ORDER BY t.rowid LIMIT @limit`);
  const delFts = db.prepare(`DELETE FROM ${o.fts} WHERE rowid=?`);
  const delRow = db.prepare(`DELETE FROM ${o.table} WHERE rowid=?`);
  let removed = 0;
  for (const stage of ["fts", "table"] as const) {
    let after = 0;
    for (;;) {
      const done = db.transaction(() => {
        const rows = (stage === "fts" ? examine : plain).all({ ...o.params, after, limit: EXAMINE_PER_STEP }) as Array<{ fr?: number; tr: number | null; hit: number }>;
        let deleted = 0;
        for (const r of rows) {
          if (r.hit === 1) {
            if (deleted === DELETE_PER_STEP) return false;
            if (stage === "fts") delFts.run(r.fr);
            removed += delRow.run(r.tr).changes;
            deleted++;
          }
          after = stage === "fts" ? r.fr! : r.tr!;
        }
        return rows.length < EXAMINE_PER_STEP;
      })();
      if (done) break;
      yield;
    }
  }
  return removed;
}

/** Deletes `select`'s rowids (it must take @limit) from `table` in short steps until none is left. */
function* deleteInSteps(db: Database, table: string, select: string, params: Record<string, unknown>): PruneSteps<number> {
  const pick = db.prepare(select);
  const del = db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT value FROM json_each(?))`);
  let removed = 0;
  for (;;) {
    const n = db.transaction(() => {
      const ids = (pick.all({ ...params, limit: DELETE_PER_STEP }) as Array<{ id: number }>).map((r) => r.id);
      if (ids.length > 0) removed += del.run(JSON.stringify(ids)).changes;
      return ids.length;
    })();
    if (n < DELETE_PER_STEP) return removed;
    yield;
  }
}

/**
 * Marks of closed positions matching `match` (SQL over alias v), per instance through the
 * (instance, ts) index from `fromTs` on, in short steps. The excursion projection follows in the
 * same step.
 */
function* sweepMarks(db: Database, match: string, params: Record<string, unknown>, beforeTs?: number): PruneSteps<number> {
  const examine = db.prepare(
    `SELECT v.rowid id, v.ts, CASE WHEN (${match}) AND (v.instance_id, v.broker, v.ticket) NOT IN (SELECT instance_id, broker, ticket FROM positions_current) THEN 1 ELSE 0 END hit
     FROM position_valuations v INDEXED BY idx_position_valuations_instance_ts
     WHERE v.instance_id=@instanceId AND v.ts < @beforeTs AND (v.ts > @ts OR (v.ts = @ts AND v.rowid > @rowid))
     ORDER BY v.ts, v.rowid LIMIT @limit`,
  );
  const del = db.prepare("DELETE FROM position_valuations WHERE rowid=?");
  let removed = 0;
  for (const instanceId of distinctLeading(db, "position_valuations", "instance_id")) {
    let ts = Number.MIN_SAFE_INTEGER, rowid = 0;
    for (;;) {
      const done = db.transaction(() => {
        const rows = examine.all({ ...params, instanceId, beforeTs: beforeTs ?? Number.MAX_SAFE_INTEGER, ts, rowid, limit: EXAMINE_PER_STEP }) as Array<{ id: number; ts: number; hit: number }>;
        let deleted = 0;
        for (const r of rows) {
          if (r.hit === 1) {
            if (deleted === DELETE_PER_STEP) return false;
            removed += del.run(r.id).changes;
            deleted++;
          }
          ts = r.ts; rowid = r.id;
        }
        refreshProjections(db as Parameters<typeof refreshProjections>[0]);
        return rows.length < EXAMINE_PER_STEP;
      })();
      if (done) break;
      yield;
    }
  }
  return removed;
}

/** Delete operational history older than `retentionDays`, preserving everything the dashboards
 * replay from. This is the entire retention policy — there is no other cleanup path.
 *
 * What is pruned:
 *  - `logs` (+ its `logs_fts` mirror): debug/operational log lines, fully disposable.
 *  - `events` (+ `events_fts`): every NON-`trade` type, including order lifecycle, signals and
 *    lifecycle events, so /search and order-event history reach back only this far.
 *    `type='trade'` events are the source of truth for win rate, expectancy, the calendar and cost
 *    decomposition, so they are never pruned.
 *  - `position_valuations`: per-tick marks whose (instance, broker, ticket) is not in
 *    `positions_current` — i.e. the position has closed. Open positions keep their full mark history.
 *  - `monitor_minutes`, and `monitor_events` except each monitor's latest transition, which is
 *    what a restart restores the current status from.
 *  - `quarantined_events` by receive time: a contract that learns the type replays from what is left.
 *
 * The deletes run as short steps (see pruneRetentionSteps) so ingest is never held up for long;
 * this runs them all at once. `now` is injectable so tests can pin the cutoff.
 * e.g. a health event at now-40d is removed; a trade event at now-40d and a mark for an
 * open ticket at now-40d both survive. */
export function pruneRetention(db: Database, now: number, retentionDays = RETENTION_DAYS): RetentionResult {
  return runSteps(pruneRetentionSteps(db, now, retentionDays));
}

/** pruneRetention as steps of a few hundred rows, each its own transaction, yielding between them. */
export function* pruneRetentionSteps(db: Database, now: number, retentionDays = RETENTION_DAYS): PruneSteps<RetentionResult> {
  const cutoff = now - retentionDays * DAY_MS;
  const logs = yield* sweepWithFts(db, { table: "logs", fts: "logs_fts", link: "log_rowid", match: "t.ts < @cutoff", params: { cutoff } });
  const events = yield* sweepWithFts(db, { table: "events", fts: "events_fts", link: "event_rowid", match: "t.ts < @cutoff AND t.type <> 'trade'", params: { cutoff } });
  const valuations = yield* sweepMarks(db, "1", {}, cutoff);

  let monitors = 0;
  for (const monitor of distinctLeading(db, "monitor_minutes", "monitor")) {
    monitors += yield* deleteInSteps(db, "monitor_minutes",
      "SELECT rowid id FROM monitor_minutes WHERE monitor=@monitor AND minute_ts < @cutoff LIMIT @limit", { monitor, cutoff });
  }
  for (const monitor of distinctLeading(db, "monitor_events", "monitor")) {
    const latest = (db.prepare("SELECT MAX(ts) ts FROM monitor_events WHERE monitor=?").get(monitor) as { ts: number }).ts;
    monitors += yield* deleteInSteps(db, "monitor_events",
      "SELECT rowid id FROM monitor_events WHERE monitor=@monitor AND ts < @cutoff AND ts < @latest LIMIT @limit", { monitor, cutoff, latest });
  }

  // Views keep their own, longer window: audience trends are read over months.
  let views = 0;
  for (const instanceId of distinctLeading(db, "share_views", "instance_id")) {
    views += yield* deleteInSteps(db, "share_views",
      "SELECT id FROM share_views WHERE instance_id=@instanceId AND ts < @before LIMIT @limit", { instanceId, before: now - VIEW_RETENTION_DAYS * DAY_MS });
  }

  const quarantined = yield* deleteInSteps(db, "quarantined_events",
    "SELECT rowid id FROM quarantined_events WHERE received_at < @cutoff LIMIT @limit", { cutoff });

  bumpEpoch(db as Parameters<typeof bumpEpoch>[0]);
  return { logs, events, valuations, monitors, views, quarantined };
}

export interface StaleStrategyResult {
  /** strategies that stopped reporting past the window (now off the active roster). */
  strategies: number;
  /** operational rows removed across those strategies. */
  rows: number;
}

/** Operational per-strategy tables a retired strategy no longer needs. Money history (deals,
 * trade_closes, equity_snapshots, risk_events, trade events, open positions) is never listed. */
const RETIRED_OPERATIONAL_TABLES = ["logs", "risk_snapshots"] as const;

function hasStrategyScope(db: Database, table: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  return names.has("instance_id") && names.has("strategy_id");
}

/** Clear the operational history of strategies that stopped reporting more than `retentionDays` ago.
 *
 * Swapping a book only changes what the daemon trades; the swapped-out children keep their
 * registration. The roster marks a strategy inactive once its `last_seen` falls a window behind
 * the instance's newest strategy (listStrategies), which hides it from the active roster. Its money
 * history stays: deals, closed trades, equity snapshots, risk events, trade fills and open
 * positions are what "all-time" and the account totals are summed from, and deleting them made
 * all-time disagree with the venue. Only logs, non-trade events, risk snapshots and marks of
 * closed positions are removed.
 *
 * e.g. a book swapped out 31 days ago: its logs go, its deals and the registration that names
 * them stay, and the account's all-time net still includes them. */
export function pruneStaleStrategies(db: Database, now: number, retentionDays = RETENTION_DAYS): StaleStrategyResult {
  return runSteps(pruneStaleStrategiesSteps(db, now, retentionDays));
}

/** pruneStaleStrategies as short steps, like pruneRetentionSteps. */
export function* pruneStaleStrategiesSteps(db: Database, now: number, retentionDays = RETENTION_DAYS): PruneSteps<StaleStrategyResult> {
  const cutoff = now - retentionDays * DAY_MS;
  const tables = RETIRED_OPERATIONAL_TABLES.filter((t) => hasStrategyScope(db, t));
  const stale = db
    .prepare("SELECT instance_id AS i, strategy_id AS s FROM strategies WHERE last_seen < ?")
    .all(cutoff) as { i: string; s: string }[];
  if (stale.length === 0) return { strategies: 0, rows: 0 };
  const keys = JSON.stringify(stale.map(({ i, s }) => `${i}\u0000${s}`));
  const isStale = (alias: string) => `(${alias}.instance_id || char(0) || ${alias}.strategy_id) IN (SELECT value FROM json_each(@keys))`;
  // A full-text sweep reads every mirror row, so it runs only while a stale strategy still has rows to remove.
  const has = (sql: string) => stale.some(({ i, s }) => db.prepare(sql).get(i, s) != null);
  let rows = 0;
  if (has("SELECT 1 FROM logs WHERE instance_id=? AND strategy_id=? LIMIT 1")) {
    rows += yield* sweepWithFts(db, { table: "logs", fts: "logs_fts", link: "log_rowid", match: isStale("t"), params: { keys } });
  }
  const operational = "t.type NOT IN ('trade','trade.closed')";
  if (has(`SELECT 1 FROM events t WHERE instance_id=? AND strategy_id=? AND ${operational} LIMIT 1`)) {
    rows += yield* sweepWithFts(db, { table: "events", fts: "events_fts", link: "event_rowid", match: `${isStale("t")} AND ${operational}`, params: { keys } });
  }
  for (const { i, s } of stale) {
    for (const t of tables) {
      rows += yield* deleteInSteps(db, t, `SELECT rowid id FROM ${t} WHERE instance_id=@i AND strategy_id=@s LIMIT @limit`, { i, s });
    }
  }
  rows += yield* sweepMarks(db, isStale("v"), { keys });
  if (rows > 0) bumpEpoch(db as Parameters<typeof bumpEpoch>[0]);
  return { strategies: stale.length, rows };
}
