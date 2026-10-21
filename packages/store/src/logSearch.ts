import type { Db } from "./db.js";
import type { LogRow } from "./queries.js";

export interface LogSearch {
  instanceId: string;
  strategyId?: string;
  level?: string;
  /** Part of the logger name, any case: `MT5Broker` finds `com.qkt.connector.mt5.MT5Broker`. */
  logger?: string;
  /** Full-text query (FTS5 syntax). A query FTS cannot read is searched as plain words instead. */
  q?: string;
  /** Written at or after (ms). */
  from?: number;
  /** Written before (ms). */
  to?: number;
  limit: number;
}

/** `foo "bar baz"` as an FTS5 query that matches those words literally: every token quoted. */
export function ftsWords(text: string): string {
  return (text.match(/"[^"]*"|\S+/g) ?? [])
    .map((w) => w.replace(/^"|"$/g, ""))
    .filter((w) => w.length > 0)
    .map((w) => `"${w.replace(/"/g, '""')}"`)
    .join(" ");
}

/**
 * Log lines newest first, filtered by strategy, level, logger, text and time. Text goes through
 * the FTS index; everything else narrows the instance's lines by (instance_id, ts) or
 * (instance_id, level, ts).
 */
export function searchLogs(db: Db, f: LogSearch): LogRow[] {
  const cl: string[] = ["l.instance_id=@instanceId"];
  if (f.strategyId) cl.push("l.strategy_id=@strategyId");
  if (f.level) cl.push("l.level=@level");
  if (f.logger) cl.push("lower(l.logger) LIKE @logger ESCAPE '\\'");
  if (f.from != null) cl.push("l.ts>=@from");
  if (f.to != null) cl.push("l.ts<@to");
  const params = {
    instanceId: f.instanceId, strategyId: f.strategyId, level: f.level, from: f.from, to: f.to,
    logger: f.logger ? `%${f.logger.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : undefined,
    limit: f.limit,
  };
  if (f.q) {
    const run = (q: string) => db.prepare(
      `SELECT l.id, l.strategy_id strategyId, l.level, l.logger, l.message, l.ts
       FROM logs_fts ft JOIN logs l ON l.rowid = ft.log_rowid
       WHERE logs_fts MATCH @q AND ${cl.join(" AND ")}
       ORDER BY l.ts DESC LIMIT @limit`,
    ).all({ ...params, q }) as LogRow[];
    try {
      return run(f.q);
    } catch {
      // "rejected:" or an unbalanced quote is FTS syntax, not a search; read it as words
      const words = ftsWords(f.q);
      return words ? run(words) : [];
    }
  }
  const order = f.strategyId || f.level ? "l.ts DESC" : "l.ts DESC, l.rowid ASC";
  return db.prepare(
    `SELECT l.id, l.strategy_id strategyId, l.level, l.logger, l.message, l.ts FROM logs l
     WHERE ${cl.join(" AND ")} ORDER BY ${order} LIMIT @limit`,
  ).all(params) as LogRow[];
}
