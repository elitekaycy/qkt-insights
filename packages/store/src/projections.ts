import type { Db } from "./db.js";
import { statement } from "./statements.js";
import { clearClosedTrades, positionKeysAfter, recomputePosition, recomputeTicket, takeNewDeals, type ClosedTradeKey } from "./closedTrades.js";
import { accountRebuildStep, clearAccountProjection, recomputeAccountKeys } from "./accountProjection.js";
import { recomputeRoundTrip } from "./roundTrips.js";
import { clearExcursions, excursionsAfter, recomputeExcursions, recomputeTicketExcursions } from "./excursions.js";
import { clearDaily, dailyKey, dailyUnitsAfter, recomputeDaily, recomputeDailyKeys, utcDay, type CloseSource } from "./strategyDaily.js";

/**
 * Write-time projections: tables kept up to date as their sources change, so a read is an index
 * range scan instead of a rebuild from the source tables. Triggers on the sources record which
 * keys changed (projection_dirty); refreshProjections folds those keys in. Ingest calls it inside
 * its own transaction, and every reader calls it first, so a write from any path (another
 * process, plain SQL) is visible to the next read.
 *
 * Each projection has a reducer version. When the code's version differs from the stored one the
 * projection is rebuilt from its source tables at open, in batches that each commit with their
 * progress (`cursor`), so an interrupted rebuild resumes.
 */
export interface Projection {
  /** Bump when the reducer changes what it stores: the projection is then rebuilt from its sources. */
  version: number;
  /** Empties the projection and anything queued for it. */
  clear: (db: Db) => void;
  /** Rebuilds the next batch after `cursor` (null: the start); returns the new cursor, or null when done. */
  step: (db: Db, cursor: string | null, batch: number) => string | null;
}

export const PROJECTIONS: Record<string, Projection> = {
  closed_trades: {
    version: 2,
    clear: clearClosedTrades,
    step: (db, cursor, batch) => {
      const after = cursor == null ? null : (JSON.parse(cursor) as { instanceId: string; key: string });
      const keys = positionKeysAfter(db, after, batch);
      for (const k of keys) positionChanged(db, k.instanceId, k.key);
      const last = keys[keys.length - 1];
      return keys.length < batch || last == null ? null : JSON.stringify(last);
    },
  },
  strategy_daily: {
    version: 1,
    clear: clearDaily,
    step: (db, cursor, batch) => {
      const after = cursor == null ? null : (JSON.parse(cursor) as { source: CloseSource; instanceId: string; strategyId: string });
      const units = dailyUnitsAfter(db, after, batch);
      for (const u of units) recomputeDaily(db, u.instanceId, u.source, u.strategyId, "0000-00-00");
      const last = units[units.length - 1];
      return units.length < batch || last == null ? null : JSON.stringify(last);
    },
  },
  position_excursions: {
    version: 1,
    clear: clearExcursions,
    step: (db, cursor, batch) => {
      const rowids = excursionsAfter(db, cursor == null ? 0 : Number(cursor), batch);
      recomputeExcursions(db, rowids);
      const last = rowids[rowids.length - 1];
      return rowids.length < batch || last == null ? null : String(last);
    },
  },
};

PROJECTIONS.account_drawdown = {
  version: 1,
  clear: clearAccountProjection,
  step: (db, cursor) => accountRebuildStep(db, cursor),
};

/** Recomputes one position's closes and round trip, then what is derived per close: its excursion and its strategy's days. */
function positionChanged(db: Db, instanceId: string, key: string): void {
  const change = recomputePosition(db, instanceId, key);
  if (key.startsWith("p:")) recomputeRoundTrip(db, instanceId, key.slice(2));
  recomputeExcursions(db, [...new Set([...change.before, ...change.after].map((r) => r.dealRowid))]);
  changedCloses(db, instanceId, change);
}

/**
 * Queues the strategy days whose closes one position recompute changed: for each close added,
 * removed or altered, its owner's day before and after.
 */
function changedCloses(db: Db, instanceId: string, change: { before: ClosedTradeKey[]; after: ClosedTradeKey[] }): void {
  const queue = statement(db, "INSERT OR IGNORE INTO projection_dirty (kind, instance_id, key) VALUES ('daily', ?, ?)");
  const mark = (r: ClosedTradeKey) => { if (r.strategyId != null) queue.run(instanceId, dailyKey("deal", r.strategyId, utcDay(r.ts))); };
  const after = new Map(change.after.map((r) => [r.dealRowid, r]));
  for (const b of change.before) {
    const a = after.get(b.dealRowid);
    if (a && a.strategyId === b.strategyId && a.ts === b.ts && Object.is(a.realized, b.realized)) { after.delete(b.dealRowid); continue; }
    mark(b);
  }
  for (const a of after.values()) mark(a);
}

/** Rows drained per pass; a pass may queue more keys (a ticket marks its positions). */
const DRAIN_BATCH = 500;

/** Kinds drained in this order: a ticket marks positions, a position marks strategy days; marks are per ticket. */
const DRAIN_ORDER = ["ticket", "position", "excursion", "daily", "account"] as const;

/** Brings every projection up to date with the writes recorded since the last call. Cheap when nothing changed. */
export function refreshProjections(db: Db): void {
  const newDeals = (statement(db, "SELECT MAX(rowid) m FROM deals").get() as { m: number | null }).m
    !== (statement(db, "SELECT last_rowid r FROM projection_watermarks WHERE source='deals'").get() as { r: number } | undefined)?.r;
  if (!newDeals && statement(db, "SELECT 1 FROM projection_dirty LIMIT 1").get() == null) return;
  db.transaction(() => {
    takeNewDeals(db);
    const take = statement(db, "SELECT instance_id instanceId, key FROM projection_dirty WHERE kind=? LIMIT ?");
    const done = statement(db, "DELETE FROM projection_dirty WHERE kind=? AND instance_id=? AND key=?");
    for (const kind of DRAIN_ORDER) {
      for (;;) {
        // A strategy's days and an account's walks are rewritten from the earliest changed minute, so take them all at once.
        const rows = take.all(kind, kind === "daily" || kind === "account" ? -1 : DRAIN_BATCH) as Array<{ instanceId: string; key: string }>;
        if (rows.length === 0) break;
        for (const r of rows) done.run(kind, r.instanceId, r.key);
        if (kind === "ticket") for (const r of rows) recomputeTicket(db, r.instanceId, r.key);
        else if (kind === "position") for (const r of rows) positionChanged(db, r.instanceId, r.key);
        else if (kind === "excursion") for (const r of rows) recomputeTicketExcursions(db, r.instanceId, r.key);
        else if (kind === "daily") recomputeDailyKeys(db, rows);
        else recomputeAccountKeys(db, rows);
      }
    }
  })();
}

interface ProjectionState { version: number; cursor: string | null; rebuiltAt: number | null }

function stateOf(db: Db, name: string): ProjectionState | undefined {
  return db.prepare("SELECT version, cursor, rebuilt_at rebuiltAt FROM projections WHERE name=?").get(name) as ProjectionState | undefined;
}

export interface RebuildProgress { name: string; batches: number; ms: number }

/**
 * Rebuilds one projection from its source tables, `batch` keys per transaction. Resumes a rebuild
 * of the current version that stopped part way; any other state starts from empty.
 */
export function rebuildProjection(db: Db, name: string, opts: { batch?: number; force?: boolean; onBatch?: (cursor: string) => void } = {}): RebuildProgress {
  const p = PROJECTIONS[name];
  if (!p) throw new Error(`unknown projection: ${name} (known: ${Object.keys(PROJECTIONS).join(", ")})`);
  const started = performance.now();
  const batch = Math.max(1, opts.batch ?? 500);
  const state = stateOf(db, name);
  let cursor: string | null = null;
  const resume = !opts.force && state != null && state.version === p.version && state.rebuiltAt == null && state.cursor != null;
  if (resume) cursor = state.cursor;
  else {
    db.transaction(() => {
      p.clear(db);
      db.prepare("INSERT INTO projections (name, version, cursor, rebuilt_at) VALUES (?, ?, NULL, NULL) ON CONFLICT(name) DO UPDATE SET version=excluded.version, cursor=NULL, rebuilt_at=NULL")
        .run(name, p.version);
    })();
  }
  let batches = 0;
  for (;;) {
    const next = db.transaction(() => {
      const c = p.step(db, cursor, batch);
      db.prepare("UPDATE projections SET cursor=?, rebuilt_at=? WHERE name=?").run(c, c == null ? Date.now() : null, name);
      return c;
    })();
    batches++;
    if (next == null) break;
    cursor = next;
    opts.onBatch?.(next);
  }
  return { name, batches, ms: performance.now() - started };
}

/** Rebuilds every projection whose stored version is not the code's, or whose rebuild did not finish. */
export function ensureProjections(db: Db, onRebuilt?: (p: RebuildProgress) => void): void {
  for (const [name, p] of Object.entries(PROJECTIONS)) {
    const state = stateOf(db, name);
    if (state && state.version === p.version && state.rebuiltAt != null) continue;
    const progress = rebuildProjection(db, name);
    onRebuilt?.(progress);
  }
}
