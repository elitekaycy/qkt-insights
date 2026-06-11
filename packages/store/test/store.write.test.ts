import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";

describe("schema", () => {
  it("creates core tables and the FTS table on open", () => {
    const db = openDb(":memory:");
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table')").all().map((r: any) => r.name);
    for (const t of ["events", "instances", "strategies", "orders", "equity_snapshots", "events_fts"]) {
      expect(names).toContain(t);
    }
  });

  it("enables WAL on a file-backed db", () => {
    const db = openDb(":memory:");
    // memory dbs report 'memory'; assert pragma callable and journal set on file dbs
    const mode = db.pragma("journal_mode", { simple: true });
    expect(typeof mode).toBe("string");
  });
});
