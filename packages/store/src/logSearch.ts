import type { Db } from "./db.js";
import type { LogRow } from "./queries.js";

export interface LogSearch {
  instanceId: string;
  strategyId?: string;
  level?: string;
  /** Part of the logger name, any case: `MT5Broker` finds `com.qkt.connector.mt5.MT5Broker`. */
  logger?: string;
  /**
   * Words to find, each matched literally through the FTS index (see ftsWords): `mt5-gateway`,
   * `ICMARKETS:XAUUSD` and `0.1004` are words, never query syntax. A word ending in `*` is a prefix.
   */
  q?: string;
  /** Written at or after (ms). */
  from?: number;
  /** Written before (ms). */
  to?: number;
  limit: number;
}

export interface LogPage {
  /** Newest first: by time, then by arrival within one millisecond. */
  rows: LogRow[];
  /** Pass back as `cursor` for the next older page; null on the last page. */
  nextCursor: string | null;
  /** How many lines the whole query matches; on the first page only (null on a later page). */
  total: number | null;
}

/**
 * `foo "bar baz" mt5-gateway XAU*` as an FTS5 query that matches those words literally: every
 * token quoted (inner quotes doubled), so nothing in it is read as syntax; a trailing `*` stays a
 * prefix outside the quotes. Empty when there is no word.
 */
export function ftsWords(text: string): string {
  return (text.match(/"[^"]*"|\S+/g) ?? [])
    .map((w) => w.replace(/^"|"$/g, ""))
    .map((w) => {
      const prefix = w.length > 1 && w.endsWith("*");
      const word = (prefix ? w.slice(0, -1) : w).replace(/\*+$/, "");
      return word.length === 0 ? "" : `"${word.replace(/"/g, '""')}"${prefix ? "*" : ""}`;
    })
    .filter((w) => w.length > 0)
    .join(" ");
}

type Cursor = [ts: number, rowid: number];

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

/** The line a cursor names; null when it is not one this code wrote. */
function decodeCursor(cursor: string): Cursor | null {
  try {
    const c = JSON.parse(Buffer.from(cursor, "base64url").toString()) as unknown;
    return Array.isArray(c) && c.length === 2 && c.every((v) => Number.isInteger(v)) ? (c as Cursor) : null;
  } catch {
    return null;
  }
}

/** The filters as SQL over `logs l` (joined to logs_fts `ft` when there are words), with their parameters. */
function where(f: LogSearch): { from: string; clauses: string[]; params: Record<string, unknown> } | null {
  const cl: string[] = ["l.instance_id=@instanceId"];
  if (f.strategyId) cl.push("l.strategy_id=@strategyId");
  if (f.level) cl.push("l.level=@level");
  if (f.logger) cl.push("lower(l.logger) LIKE @logger ESCAPE '\\'");
  if (f.from != null) cl.push("l.ts>=@from");
  if (f.to != null) cl.push("l.ts<@to");
  const params: Record<string, unknown> = {
    instanceId: f.instanceId, strategyId: f.strategyId, level: f.level, from: f.from, to: f.to,
    logger: f.logger ? `%${f.logger.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : undefined,
  };
  if (!f.q?.trim()) return { from: "logs l", clauses: cl, params };
  const words = ftsWords(f.q);
  if (!words) return null;
  return { from: "logs_fts ft JOIN logs l ON l.rowid = ft.log_rowid", clauses: ["logs_fts MATCH @q", ...cl], params: { ...params, q: words } };
}

const COLUMNS = "l.id, l.strategy_id strategyId, l.level, l.logger, l.message, l.ts";

/**
 * One page of log lines, newest first, filtered by strategy, level, logger, words and time, and
 * the number of lines the whole query matches (first page). Pages by (ts, rowid), so a page is
 * stable while new lines arrive and every matching line in the range is reachable. Text goes
 * through the FTS index; everything else narrows the instance's lines by an (instance_id, ...) index.
 */
export function logPage(db: Db, f: LogSearch & { cursor?: string }): LogPage {
  const w = where(f);
  if (!w) return { rows: [], nextCursor: null, total: 0 };
  const at = f.cursor ? decodeCursor(f.cursor) : null;
  const clauses = at ? [...w.clauses, "(l.ts < @cts OR (l.ts = @cts AND l.rowid < @crow))"] : w.clauses;
  const limit = Math.max(1, Math.min(f.limit, 1000));
  const rows = db.prepare(
    `SELECT ${COLUMNS}, l.rowid r FROM ${w.from} WHERE ${clauses.join(" AND ")} ORDER BY l.ts DESC, l.rowid DESC LIMIT ${limit + 1}`,
  ).all({ ...w.params, cts: at?.[0], crow: at?.[1] }) as Array<LogRow & { r: number }>;
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const total = at ? null
    : (db.prepare(`SELECT COUNT(*) n FROM ${w.from} WHERE ${w.clauses.join(" AND ")}`).get(w.params) as { n: number }).n;
  return {
    rows: page.map(({ r: _r, ...row }) => row),
    nextCursor: more && last ? encodeCursor([last.ts, last.r]) : null,
    total,
  };
}

/** The newest `limit` lines of a query (logPage's first page, without its count). */
export function searchLogs(db: Db, f: LogSearch): LogRow[] {
  const w = where(f);
  if (!w) return [];
  return db.prepare(
    `SELECT ${COLUMNS} FROM ${w.from} WHERE ${w.clauses.join(" AND ")} ORDER BY l.ts DESC, l.rowid DESC LIMIT @limit`,
  ).all({ ...w.params, limit: f.limit }) as LogRow[];
}
