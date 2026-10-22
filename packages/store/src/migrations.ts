import type { Database } from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { opaqueAccountIdentity } from "./accountIdentityMigration.js";
import { attributeRetiredStrategies } from "./retiredStrategies.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/**
 * Migrations SQL cannot express, run in name order with the .sql files. Each manages its own
 * transactions (a rewrite of a multi-GB table is batched) and must be safe to run again after an
 * interruption: it is recorded as applied only once it returns.
 */
const CODE_MIGRATIONS: Record<string, (db: Database) => void> = {
  "039_opaque_account_identity": opaqueAccountIdentity,
  // History stored before retired strategies were read from their order comments.
  "041_retired_strategy_attribution": (db) => { attributeRetiredStrategies(db); },
};

export function runMigrations(db: Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_ts INTEGER NOT NULL)");
  const applied = new Set(db.prepare("SELECT name FROM _migrations").all().map((r: any) => r.name));
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
  const names = [...files, ...Object.keys(CODE_MIGRATIONS)].sort();
  const record = db.prepare("INSERT INTO _migrations (name, applied_ts) VALUES (?, ?)");
  for (const name of names) {
    if (applied.has(name)) continue;
    const code = CODE_MIGRATIONS[name];
    if (code) {
      code(db);
      record.run(name, 0);
      continue;
    }
    const sql = readFileSync(join(dir, name), "utf8");
    db.transaction(() => {
      db.exec(sql);
      record.run(name, 0);
    })();
  }
}
