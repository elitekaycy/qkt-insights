import type { Database } from "better-sqlite3";
import { opaqueAccountId, redactAccountIdentity, redactAccountText } from "@qkt-insights/contract/accountIdentity";

/*
 * Rewrites every account identity stored before the collector made them opaque: account ids
 * (`mt5:<login>@<server>`, a bare `<login>@<server>`, `vgp:<adapter>:<login>`) become the opaque id
 * (contract accountIdentity.ts), and stored JSON loses its raw `login` / `server` (the login masked).
 * Log text loses `login=` / `server=` values. Batched by rowid, each batch its own transaction, so a
 * multi-GB database stays responsive and an interrupted run resumes from the start harmlessly: every
 * rewrite is a no-op on a value already rewritten. secure_delete zeroes the bytes a rewrite frees.
 */

const BATCH = 5_000;

/** JSON columns that hold envelope payloads as sent. */
const PAYLOAD_COLUMNS: Array<[table: string, column: string]> = [
  ["events", "payload"],
  ["quarantined_events", "envelope"],
  ["instance_health", "payload"],
  ["strategies", "metadata"],
  ["risk_events", "payload"],
  ["risk_snapshots", "payload"],
  ["portfolio_allocations", "payload"],
  ["portfolio_equity", "payload"],
  ["portfolio_exposure", "payload"],
];

/** The SQL filter for a value that may hold an identity: cheap, so only those rows are parsed. */
const MAY_HOLD_JSON = (c: string) => `(instr(${c}, '"login"') > 0 OR instr(${c}, '"server"') > 0 OR instr(${c}, '"accountId"') > 0)`;
const MAY_HOLD_ID = (c: string) => `(${c} LIKE '%@%' OR ${c} LIKE 'vgp:%:%')`;
const MAY_HOLD_TEXT = (c: string) => `(${c} LIKE '%login%' OR ${c} LIKE '%server%')`;

function hasColumn(db: Database, table: string, column: string): boolean {
  const cols = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

function json(value: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  const redacted = redactAccountIdentity(parsed);
  return redacted === parsed ? value : JSON.stringify(redacted);
}

/**
 * Rewrites `column` of every `table` row matching `filter` with `rewrite`, `BATCH` rows per
 * transaction; `around` wraps each batch's writes (inside its transaction). Returns rows changed.
 */
function rewrite(db: Database, table: string, column: string, filter: string, change: (v: string) => string, around: (write: () => void) => void = (w) => w()): number {
  if (!hasColumn(db, table, column)) return 0;
  const pick = db.prepare(`SELECT rowid r, ${column} v FROM ${table} WHERE rowid > ? AND ${column} IS NOT NULL AND ${filter} ORDER BY rowid LIMIT ?`);
  const put = db.prepare(`UPDATE ${table} SET ${column}=? WHERE rowid=?`);
  let after = 0;
  let changed = 0;
  for (;;) {
    const rows = pick.all(after, BATCH) as Array<{ r: number; v: string }>;
    if (rows.length === 0) break;
    const edits = rows.flatMap((row) => {
      const next = change(row.v);
      return next === row.v ? [] : [{ r: row.r, v: next }];
    });
    if (edits.length > 0) {
      db.transaction(() => around(() => {
        for (const e of edits) put.run(e.v, e.r);
      }))();
      changed += edits.length;
    }
    after = rows[rows.length - 1]!.r;
  }
  return changed;
}

/** Runs `write` with the account_equity change trigger off: an identity rewrite moves no equity, so the projections stay valid. */
function withoutAccountTrigger(db: Database): (write: () => void) => void {
  const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='account_equity_projection_update'").get() as { sql: string } | undefined;
  return (write) => {
    if (trigger) db.exec("DROP TRIGGER account_equity_projection_update");
    write();
    if (trigger) db.exec(trigger.sql);
  };
}

export function opaqueAccountIdentity(db: Database): void {
  const secureDelete = db.pragma("secure_delete", { simple: true });
  db.pragma("secure_delete = ON");
  try {
    let changed = 0;
    changed += rewrite(db, "account_equity", "account", MAY_HOLD_ID("account"), opaqueAccountId, withoutAccountTrigger(db));
    changed += rewrite(db, "deals", "account_id", MAY_HOLD_ID("account_id"), opaqueAccountId);
    if (hasColumn(db, "account_labels", "identity")) {
      db.function("qkt_opaque_account_id", { deterministic: true }, (v: unknown) => (typeof v === "string" ? opaqueAccountId(v) : v) as string);
      changed += db.prepare(`UPDATE account_labels SET identity = qkt_opaque_account_id(identity) WHERE identity IS NOT NULL AND ${MAY_HOLD_ID("identity")}`).run().changes;
    }
    for (const [table, column] of PAYLOAD_COLUMNS) changed += rewrite(db, table, column, MAY_HOLD_JSON(column), json);
    changed += rewrite(db, "logs", "message", MAY_HOLD_TEXT("message"), redactAccountText);
    const fts = rewrite(db, "logs_fts", "text", MAY_HOLD_TEXT("text"), redactAccountText);
    // A rewritten FTS row leaves its old terms in the index segments until they merge.
    if (fts > 0) db.exec("INSERT INTO logs_fts(logs_fts) VALUES('optimize')");
    if (changed + fts > 0 && db.pragma("journal_mode", { simple: true }) === "wal") db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.pragma(`secure_delete = ${Number(secureDelete)}`);
  }
}
