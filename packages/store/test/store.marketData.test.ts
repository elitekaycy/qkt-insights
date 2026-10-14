import { describe, it, expect } from "vitest";
import type { Envelope } from "@qkt-insights/contract";
import { openDb, type Db } from "../src/db.js";
import { ingestEvents } from "../src/write.js";
import { MARKETDATA_EPISODE_SQL, MarketDataEpisodes } from "../src/marketData.js";

const T = 1_700_000_000_000;
const MIN = 60_000;
let seq = 0;

type Md = "stale" | "recovered" | "connected" | "reconnected";

function md(db: Db, type: Md, ts: number, payload: Record<string, unknown>, instanceId = "live"): void {
  seq += 1;
  const e = { v: 1, instanceId, id: `md-${seq}`, seq, ts, type: `marketdata.${type}`, payload: { source: "Composite", ...payload } } as Envelope;
  expect(ingestEvents(db, instanceId, [e], ts)).toBe(1);
}

const stale = (db: Db, symbol: string, ts: number, extra: Record<string, unknown> = {}, instanceId?: string) =>
  md(db, "stale", ts, { symbols: [symbol], state: "stale", reason: "quote age 60553ms exceeds 60000ms threshold", ts, ...extra }, instanceId);

describe("MarketDataEpisodes", () => {
  it("has no episodes without marketdata events", () => {
    const db = openDb(":memory:");
    expect(new MarketDataEpisodes(db).open("live")).toEqual([]);
  });

  it("opens an episode on marketdata.stale, from engines with and without kind", () => {
    const db = openDb(":memory:");
    const eps = new MarketDataEpisodes(db);
    stale(db, "PROP_S01:EURUSD", T);
    stale(db, "PROP_S01:XAUUSD", T + MIN, { kind: "clock_skew", reason: "broker tick clock skew -61441ms exceeds 60000ms" });
    expect(eps.open("live")).toEqual([
      { symbol: "PROP_S01:EURUSD", source: "Composite", since: T, kind: null, reason: "quote age 60553ms exceeds 60000ms threshold" },
      { symbol: "PROP_S01:XAUUSD", source: "Composite", since: T + MIN, kind: "clock_skew", reason: "broker tick clock skew -61441ms exceeds 60000ms" },
    ]);
    expect(eps.open("other")).toEqual([]);
  });

  it("closes on a later marketdata.recovered for the symbol only", () => {
    const db = openDb(":memory:");
    const eps = new MarketDataEpisodes(db);
    stale(db, "EURUSD", T);
    stale(db, "XAUUSD", T);
    expect(eps.open("live").map((e) => e.symbol)).toEqual(["EURUSD", "XAUUSD"]);
    md(db, "recovered", T + 5 * MIN, { symbols: ["EURUSD"], state: "recovered", unhealthyForMs: 5 * MIN });
    expect(eps.open("live").map((e) => e.symbol)).toEqual(["XAUUSD"]);
    stale(db, "EURUSD", T + 9 * MIN);
    expect(eps.open("live").map((e) => [e.symbol, e.since])).toEqual([["XAUUSD", T], ["EURUSD", T + 9 * MIN]]);
  });

  it("dates an episode from its first report and describes it by its newest", () => {
    const db = openDb(":memory:");
    const eps = new MarketDataEpisodes(db);
    stale(db, "XAUUSD", T, { kind: "stale" });
    expect(eps.open("live")).toMatchObject([{ since: T, kind: "stale" }]);
    stale(db, "XAUUSD", T + 2 * MIN, { kind: "outlier", reason: "4 consecutive outlier tick(s) rejected" });
    expect(eps.open("live")).toEqual([{ symbol: "XAUUSD", source: "Composite", since: T, kind: "outlier", reason: "4 consecutive outlier tick(s) rejected" }]);
  });

  it("closes on a later marketdata.connected from the same source (a session start), not on reconnected", () => {
    const db = openDb(":memory:");
    const eps = new MarketDataEpisodes(db);
    stale(db, "EURUSD", T);
    stale(db, "XAUUSD", T);
    stale(db, "BTCUSD", T, { source: "crypto" });
    md(db, "reconnected", T + MIN, { symbols: ["EURUSD", "XAUUSD"], state: "reconnected" });
    expect(eps.open("live").map((e) => e.symbol)).toEqual(["BTCUSD", "EURUSD", "XAUUSD"]);
    md(db, "connected", T + 2 * MIN, { symbols: ["EURUSD", "BTCUSD"], state: "connected", reason: "session-start" });
    expect(eps.open("live").map((e) => e.symbol)).toEqual(["BTCUSD", "XAUUSD"]);
    md(db, "connected", T + 3 * MIN, { state: "connected", reason: "session-start" });
    expect(eps.open("live").map((e) => e.symbol)).toEqual(["BTCUSD"]);
  });

  it("does not depend on arrival order: an old report replayed after the close stays closed", () => {
    const db = openDb(":memory:");
    const eps = new MarketDataEpisodes(db);
    md(db, "recovered", T + 5 * MIN, { symbols: ["EURUSD"], state: "recovered" });
    md(db, "connected", T + 5 * MIN, { symbols: ["XAUUSD"], state: "connected" });
    expect(eps.open("live")).toEqual([]);
    stale(db, "EURUSD", T);
    stale(db, "XAUUSD", T + 5 * MIN);
    expect(eps.open("live")).toEqual([]);
    // the same stream folded from scratch, e.g. after a collector restart
    expect(new MarketDataEpisodes(db).open("live")).toEqual([]);
    stale(db, "EURUSD", T + 6 * MIN);
    expect(eps.open("live").map((e) => e.symbol)).toEqual(["EURUSD"]);
    expect(new MarketDataEpisodes(db).open("live").map((e) => e.symbol)).toEqual(["EURUSD"]);
  });

  it("keeps instances apart and forgets retired ones", () => {
    const db = openDb(":memory:");
    const eps = new MarketDataEpisodes(db);
    stale(db, "EURUSD", T, {}, "a");
    stale(db, "XAUUSD", T, {}, "b");
    md(db, "recovered", T + MIN, { symbols: ["EURUSD"] }, "b");
    expect(eps.open("a").map((e) => e.symbol)).toEqual(["EURUSD"]);
    expect(eps.open("b").map((e) => e.symbol)).toEqual(["XAUUSD"]);
    eps.retain(new Set(["a"]));
    expect(eps.open("b").map((e) => e.symbol)).toEqual(["XAUUSD"]);
  });

  it("reads through the events index, never scanning the table", () => {
    const db = openDb(":memory:");
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${MARKETDATA_EPISODE_SQL}`).all("live", 0) as { detail: string }[];
    expect(plan.map((r) => r.detail).join("\n")).not.toMatch(/SCAN events\b/u);
  });
});
