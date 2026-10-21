import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const SOURCE = "packages/store/src/migrations";

describe("build: copy-migrations", () => {
  it("makes dist's migrations exactly the source's, dropping a stale one that would break boot", () => {
    const dir = mkdtempSync(join(tmpdir(), "insights-migrations-"));
    try {
      const to = join(dir, "migrations");
      mkdirSync(to);
      // A migration a previous build copied and the source has since dropped or renamed.
      writeFileSync(join(to, "999_stale.sql"), "ALTER TABLE no_such_table ADD COLUMN x INTEGER;");
      writeFileSync(join(to, "notes.txt"), "kept: not a migration");
      execFileSync(process.execPath, ["scripts/copy-migrations.mjs", SOURCE, to]);

      const sources = readdirSync(SOURCE).filter((f) => f.endsWith(".sql")).sort();
      expect(readdirSync(to).filter((f) => f.endsWith(".sql")).sort()).toEqual(sources);
      expect(readdirSync(to)).toContain("notes.txt");
      for (const f of sources) expect(readFileSync(join(to, f), "utf8")).toBe(readFileSync(join(SOURCE, f), "utf8"));

      // The copied set applies in order on a fresh database.
      const db = new Database(":memory:");
      for (const f of sources) db.exec(readFileSync(join(to, f), "utf8"));
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='round_trips'").get()).toEqual({ name: "round_trips" });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
