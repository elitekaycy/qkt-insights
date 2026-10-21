import type { Statement } from "better-sqlite3";
import type { Db } from "./db.js";

const caches = new WeakMap<Db, Map<string, Statement>>();

/**
 * The prepared statement for `sql` on this database, compiled once. Ingest runs the same few
 * dozen statements for every envelope; compiling each one per envelope cost about as much as
 * executing it. Only for fixed SQL text: a statement built from varying input would grow the cache.
 */
export function statement(db: Db, sql: string): Statement {
  let cache = caches.get(db);
  if (!cache) {
    cache = new Map();
    caches.set(db, cache);
  }
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt;
}
