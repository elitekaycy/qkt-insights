import { describe, it, expect } from "vitest";
import type { Envelope } from "@qkt-insights/contract";
import { openDb, ingestEvents, listStrategies, searchEvents, strategySources, strategySourceText, type Db } from "../src/index.js";

const I = "fwd";
const T0 = Date.UTC(2026, 9, 28, 9);
const H = 3_600_000;
const V1 = "STRATEGY gold VERSION 1\nSYMBOLS\n    g = EXNESS:XAUUSD EVERY 1h\n";
const V2 = `${V1}-- tighter stop\n`;

function started(ts: number, sha: string, extra: Record<string, unknown>, strategyId = "gold"): Envelope {
  return {
    v: 1, instanceId: I, id: `strategy-started-${strategyId}-${ts}`, seq: ts, ts, strategyId, type: "strategy.started",
    payload: { strategyId, ts, deployName: strategyId, sourcePath: "/srv/qkt/gold.qkt", sourceSha256: sha, dslVersion: 1, ...extra },
  } as Envelope;
}

function rows(db: Db) {
  return strategySources(db, I, "gold");
}

describe("strategy sources", () => {
  it("stores each version once, with first and last seen, and keeps the text out of events and metadata", () => {
    const db = openDb(":memory:");
    ingestEvents(db, I, [
      started(T0, "aa", { sourceText: V1, sourceTruncated: false }),
      started(T0 + H, "aa", { sourceTextOmitted: true }),
      started(T0 + 2 * H, "aa", { sourceText: V1, sourceTruncated: false }),
    ]);
    const view = rows(db);
    expect(view.running).toBe("aa");
    expect(view.versions).toEqual([
      { sha256: "aa", path: "/srv/qkt/gold.qkt", dslVersion: 1, firstSeen: T0, lastSeen: T0 + 2 * H, starts: 3, truncated: false, bytes: V1.length, text: "stored" },
    ]);
    expect(strategySourceText(db, I, "gold", "aa")).toEqual({ sha256: "aa", text: V1, truncated: false });

    const raw = JSON.stringify([
      db.prepare("SELECT payload FROM events").all(),
      db.prepare("SELECT metadata FROM strategies").all(),
      listStrategies(db, I),
      searchEvents(db, { q: "gold", instanceId: I, limit: 100 }),
    ]);
    expect(raw).not.toContain("SYMBOLS");
    expect(listStrategies(db, I)[0]!.metadata).toMatchObject({ sourceSha256: "aa", sourcePath: "/srv/qkt/gold.qkt" });
  });

  it("lists versions newest first and names the running one from the latest start", () => {
    const db = openDb(":memory:");
    ingestEvents(db, I, [
      started(T0, "aa", { sourceText: V1, sourceTruncated: false }),
      started(T0 + H, "bb", { sourceText: V2, sourceTruncated: true }),
    ]);
    const view = rows(db);
    expect(view.running).toBe("bb");
    expect(view.versions.map((v) => [v.sha256, v.truncated, v.text])).toEqual([["bb", true, "stored"], ["aa", false, "stored"]]);
    expect(strategySourceText(db, I, "gold", "bb")!.text).toBe(V2);
  });

  it("says why a version has no text: omitted after an earlier send it never received, or not sent at all", () => {
    const db = openDb(":memory:");
    ingestEvents(db, I, [
      started(T0, "old", {}),
      started(T0 + H, "aa", { sourceTextOmitted: true }),
    ]);
    expect(rows(db).versions.map((v) => [v.sha256, v.text])).toEqual([["aa", "not-received"], ["old", "not-sent"]]);
    expect(strategySourceText(db, I, "gold", "aa")).toBeNull();

    // the text arriving later (a new qkt process) fills the version in
    ingestEvents(db, I, [started(T0 + 2 * H, "aa", { sourceText: V1, sourceTruncated: false })]);
    expect(rows(db).versions[0]).toMatchObject({ sha256: "aa", text: "stored", firstSeen: T0 + H, lastSeen: T0 + 2 * H });
  });

  it("does not count a redelivered start twice, and keeps strategies apart", () => {
    const db = openDb(":memory:");
    const first = started(T0, "aa", { sourceText: V1, sourceTruncated: false });
    ingestEvents(db, I, [first, first, started(T0, "aa", { sourceText: V1 }, "book:a")]);
    expect(rows(db).versions[0]!.starts).toBe(1);
    expect(strategySources(db, I, "book:a").versions).toHaveLength(1);
    expect(strategySourceText(db, I, "book:a", "zz")).toBeNull();
  });

  it("has nothing for a strategy whose qkt sends no sha", () => {
    const db = openDb(":memory:");
    ingestEvents(db, I, [started(T0, undefined as unknown as string, {})]);
    expect(rows(db)).toEqual({ running: null, versions: [] });
  });
});
