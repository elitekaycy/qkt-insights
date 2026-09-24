import type { Db } from "./db.js";

/**
 * A symbol whose quotes qkt reported unhealthy (marketdata.stale) and that has not been
 * reported healthy since. qkt suppresses stale reports for out-of-session gaps, so an
 * open episode is a real in-session problem.
 */
export interface MarketDataEpisode {
  symbol: string;
  source: string;
  /** The first stale report of the episode, on the instance's clock. */
  since: number;
  /** From the newest stale report: "stale" | "clock_skew" | "outlier", null from engines that predate it. */
  kind: string | null;
  reason: string | null;
}

interface StaleReport {
  symbol: string;
  source: string;
  ts: number;
  kind: string | null;
  reason: string | null;
}

interface InstanceFold {
  /** Highest events.rowid already folded; rowids only grow (the store never vacuums). */
  cursor: number;
  /** symbol -> newest marketdata.recovered ts. */
  recoveredAt: Map<string, number>;
  /** source -> symbol -> newest marketdata.connected ts naming that symbol. */
  connectedAt: Map<string, Map<string, number>>;
  /** source -> newest marketdata.connected ts that named no symbols (the whole source). */
  connectedAllAt: Map<string, number>;
  /** Stale reports no close has superseded yet, by `rowid:symbol`. */
  open: Map<string, StaleReport>;
}

/*
 * A stale report closes when a later marketdata.recovered names its symbol, or a later
 * marketdata.connected from the same source names it (or names no symbols). qkt sends
 * connected once per session start with its whole feed; a fresh session re-reports any
 * symbol still unhealthy, so connected is a clean slate even for an engine that never
 * sends recovered, or one that restarted mid-episode. marketdata.reconnected does NOT
 * close: qkt's quote-health gate keeps its per-symbol state across a feed reconnect and
 * would not report a symbol that is still stale again.
 */
export const MARKETDATA_EPISODE_SQL = `SELECT rowid, type, ts, payload FROM events
  WHERE instance_id = ? AND type IN ('marketdata.stale', 'marketdata.recovered', 'marketdata.connected') AND rowid > ?
  ORDER BY rowid`;

function text(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function symbolsOf(p: Record<string, unknown>): string[] | null {
  return Array.isArray(p.symbols) ? p.symbols.filter((s): s is string => typeof s === "string") : null;
}

function bump(m: Map<string, number>, key: string, ts: number): void {
  if (ts > (m.get(key) ?? -Infinity)) m.set(key, ts);
}

/**
 * Open market-data episodes per instance, folded incrementally from the events table:
 * each call reads only the marketdata rows stored since the previous call, through the
 * (instance_id, type, ts) index. Closes are kept as newest-ts watermarks, so the result
 * does not depend on the order rows arrive in (a replayed journal may deliver an old
 * report late).
 */
export class MarketDataEpisodes {
  private folds = new Map<string, InstanceFold>();

  constructor(private db: Db) {}

  open(instanceId: string): MarketDataEpisode[] {
    const f = this.fold(instanceId);
    const bySymbol = new Map<string, { first: StaleReport; last: StaleReport }>();
    for (const r of f.open.values()) {
      const e = bySymbol.get(r.symbol);
      if (!e) bySymbol.set(r.symbol, { first: r, last: r });
      else {
        if (r.ts < e.first.ts) e.first = r;
        if (r.ts >= e.last.ts) e.last = r;
      }
    }
    return [...bySymbol.values()]
      .map(({ first, last }) => ({ symbol: last.symbol, source: last.source, since: first.ts, kind: last.kind, reason: last.reason }))
      .sort((a, b) => a.since - b.since || a.symbol.localeCompare(b.symbol));
  }

  /** Forget instances no longer monitored. */
  retain(instanceIds: Set<string>): void {
    for (const id of this.folds.keys()) if (!instanceIds.has(id)) this.folds.delete(id);
  }

  private fold(instanceId: string): InstanceFold {
    let f = this.folds.get(instanceId);
    if (!f) {
      f = { cursor: 0, recoveredAt: new Map(), connectedAt: new Map(), connectedAllAt: new Map(), open: new Map() };
      this.folds.set(instanceId, f);
    }
    const rows = this.db.prepare(MARKETDATA_EPISODE_SQL).all(instanceId, f.cursor) as { rowid: number; type: string; ts: number; payload: string }[];
    if (rows.length === 0) return f;
    for (const row of rows) {
      f.cursor = Math.max(f.cursor, row.rowid);
      let p: Record<string, unknown>;
      try {
        p = JSON.parse(row.payload) as Record<string, unknown>;
      } catch {
        continue;
      }
      const source = text(p.source) ?? "";
      const symbols = symbolsOf(p);
      if (row.type === "marketdata.stale") {
        // One row per symbol is what qkt sends; a multi-symbol row opens one report each.
        for (const symbol of symbols ?? []) {
          f.open.set(`${row.rowid}:${symbol}`, { symbol, source, ts: row.ts, kind: text(p.kind), reason: text(p.reason) });
        }
      } else if (row.type === "marketdata.recovered") {
        for (const symbol of symbols ?? []) bump(f.recoveredAt, symbol, row.ts);
      } else if (symbols == null || symbols.length === 0) {
        bump(f.connectedAllAt, source, row.ts);
      } else {
        const bySymbol = f.connectedAt.get(source) ?? new Map<string, number>();
        f.connectedAt.set(source, bySymbol);
        for (const symbol of symbols) bump(bySymbol, symbol, row.ts);
      }
    }
    for (const [key, r] of f.open) {
      const closedAt = Math.max(
        f.recoveredAt.get(r.symbol) ?? -Infinity,
        f.connectedAt.get(r.source)?.get(r.symbol) ?? -Infinity,
        f.connectedAllAt.get(r.source) ?? -Infinity,
      );
      if (r.ts <= closedAt) f.open.delete(key);
    }
    return f;
  }
}
