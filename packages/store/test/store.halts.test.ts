import { describe, it, expect } from "vitest";
import { openDb, ingestEvents, listStrategies, currentHalts, strategyHalt, type Db } from "../src/index.js";
import type { Envelope } from "@qkt-insights/contract";

// 2024-06-10T06:13:20Z: the same UTC day for the whole sequence unless a test moves [now].
const T0 = 1718000000000;
const NOW = T0 + 3_600_000;
const DAY = 86_400_000;

function env(p: Partial<Envelope> & { type: Envelope["type"]; payload: any }): Envelope {
  return { v: 1, instanceId: "qkt-prod", id: Math.random().toString(36).slice(2), seq: 1, ts: T0, ...p } as Envelope;
}

const started = (strategyId: string) =>
  env({ type: "strategy.started", strategyId, payload: { strategyId, ts: T0, deployName: strategyId, dslVersion: 1, runtimeMode: "live" } });

// The payloads qkt sends (RiskInsights.fromRiskHalted / fromRiskResumed): strategyId is on both
// the envelope and the payload, null for a session-level halt; from qkt#1244 on a null-strategy
// halt or resume also names the emitting session's strategies in sessionStrategies.
function halted(strategyId: string | null, reason: string, ts: number, seq: number, scope?: string, sessionStrategies?: string[]): Envelope {
  const payload: Record<string, unknown> = { strategyId, reason };
  if (scope !== undefined) { payload.scope = scope; payload.persistent = scope === "PERSISTENT"; }
  if (sessionStrategies) payload.sessionStrategies = sessionStrategies;
  return env({ id: `halt-${strategyId ?? ""}-${ts}-${seq}`, type: "risk.halted", strategyId: strategyId ?? undefined, ts, seq, payload });
}
function resumed(strategyId: string | null, ts: number, seq: number, sessionStrategies?: string[]): Envelope {
  const payload: Record<string, unknown> = { strategyId };
  if (sessionStrategies) payload.sessionStrategies = sessionStrategies;
  return env({ id: `resume-${strategyId ?? ""}-${ts}-${seq}`, type: "risk.resumed", strategyId: strategyId ?? undefined, ts, seq, payload });
}

function book(...events: Envelope[]): Db {
  const db = openDb(":memory:");
  ingestEvents(db, "qkt-prod", [started("gold"), started("silver"), ...events]);
  return db;
}

const haltOf = (db: Db, id: string, now = NOW) => {
  const row = listStrategies(db, "qkt-prod", now).find((r) => r.strategyId === id)!;
  return { halted: row.halted, haltReason: row.haltReason, haltScope: row.haltScope, haltPersistent: row.haltPersistent, haltedAt: row.haltedAt };
};

const CLEAR = { halted: false, haltReason: null, haltScope: null, haltPersistent: null, haltedAt: null };

describe("current strategy halts", () => {
  it("reports no halt for a strategy with no risk events", () => {
    expect(haltOf(book(), "gold")).toEqual(CLEAR);
  });

  it("shows a strategy halt with its reason, scope and time, and clears it on that strategy's resume", () => {
    const halt = halted("gold", "loss streak 3", T0 + 1000, 10, "PERSISTENT");
    expect(haltOf(book(halt), "gold")).toEqual({
      halted: true, haltReason: "loss streak 3", haltScope: "PERSISTENT", haltPersistent: true, haltedAt: T0 + 1000,
    });
    expect(haltOf(book(halt), "silver")).toEqual(CLEAR);
    expect(haltOf(book(halt, resumed("gold", T0 + 5000, 11)), "gold")).toEqual(CLEAR);
  });

  it("does not let a resume that came before the halt clear it", () => {
    const db = book(resumed("gold", T0 + 500, 9), halted("gold", "max drawdown", T0 + 1000, 10, "PERSISTENT"));
    expect(haltOf(db, "gold").halted).toBe(true);
  });

  it("orders a halt and resume in the same millisecond by seq", () => {
    expect(haltOf(book(halted("gold", "operator", T0 + 1000, 10, "PERSISTENT"), resumed("gold", T0 + 1000, 11)), "gold").halted).toBe(false);
    expect(haltOf(book(resumed("gold", T0 + 1000, 10), halted("gold", "operator", T0 + 1000, 11, "PERSISTENT")), "gold").halted).toBe(true);
  });

  it("applies an instance-wide halt (null strategyId) to every strategy until a null resume", () => {
    const halt = halted(null, "account drawdown 8%", T0 + 1000, 10, "DAILY");
    const db = book(halt);
    for (const id of ["gold", "silver"])
      expect(haltOf(db, id)).toEqual({ halted: true, haltReason: "account drawdown 8%", haltScope: "DAILY", haltPersistent: false, haltedAt: T0 + 1000 });
    expect(db.prepare("SELECT strategy_id FROM risk_events").pluck().all()).toEqual([null]);

    const cleared = book(halt, resumed(null, T0 + 2000, 11));
    expect(haltOf(cleared, "gold")).toEqual(CLEAR);
    expect(haltOf(cleared, "silver")).toEqual(CLEAR);
  });

  it("keeps a strategy halt standing through another strategy's resume and through an instance-wide resume", () => {
    const db = book(
      halted("gold", "loss streak 3", T0 + 1000, 10, "PERSISTENT"),
      halted("silver", "loss streak 4", T0 + 1500, 20, "PERSISTENT"),
      resumed("silver", T0 + 2000, 21),
      resumed(null, T0 + 3000, 22),
    );
    expect(haltOf(db, "gold")).toMatchObject({ halted: true, haltReason: "loss streak 3" });
    expect(haltOf(db, "silver")).toEqual(CLEAR);
  });

  it("keeps an instance-wide halt standing through a strategy resume", () => {
    const db = book(halted(null, "operator", T0 + 1000, 10, "PERSISTENT"), halted("gold", "loss streak 3", T0 + 1100, 11, "DAILY"), resumed("gold", T0 + 2000, 12));
    expect(haltOf(db, "gold")).toMatchObject({ halted: true, haltReason: "operator", haltPersistent: true });
  });

  it("prefers the persistent halt when a strategy and its instance are both halted, else the later one", () => {
    const persistentFirst = book(
      halted("gold", "max drawdown", T0 + 1000, 10, "PERSISTENT"),
      halted(null, "daily loss", T0 + 2000, 11, "DAILY"),
    );
    expect(haltOf(persistentFirst, "gold")).toMatchObject({ haltReason: "max drawdown", haltPersistent: true });
    expect(haltOf(persistentFirst, "silver")).toMatchObject({ haltReason: "daily loss", haltPersistent: false });

    const bothDaily = book(halted("gold", "loss streak 3", T0 + 1000, 10, "DAILY"), halted(null, "daily loss", T0 + 2000, 11, "DAILY"));
    expect(haltOf(bothDaily, "gold")).toMatchObject({ haltReason: "daily loss", haltedAt: T0 + 2000 });
  });

  it("takes the later halt on the same latch when the engine re-sends an escalation", () => {
    const db = book(halted(null, "daily loss", T0 + 1000, 10, "DAILY"), halted(null, "max drawdown", T0 + 2000, 11, "PERSISTENT"));
    expect(haltOf(db, "gold")).toMatchObject({ haltReason: "max drawdown", haltScope: "PERSISTENT", haltPersistent: true, haltedAt: T0 + 2000 });
  });

  it("reports an old-engine halt without scope as halted with scope and persistence unknown", () => {
    const db = book(halted("gold", "max drawdown", T0 + 1000, 10));
    expect(haltOf(db, "gold")).toEqual({ halted: true, haltReason: "max drawdown", haltScope: null, haltPersistent: null, haltedAt: T0 + 1000 });
    expect(haltOf(db, "gold", T0 + 30 * DAY).halted).toBe(true);
  });

  it("drops a DAILY halt once its UTC day has passed, and keeps a PERSISTENT one", () => {
    const db = book(halted("gold", "daily loss", T0 + 1000, 10, "DAILY"), halted("silver", "max drawdown", T0 + 1000, 11, "PERSISTENT"));
    const nextDay = (Math.floor(T0 / DAY) + 1) * DAY;
    expect(haltOf(db, "gold", nextDay - 1).halted).toBe(true);
    expect(haltOf(db, "gold", nextDay)).toEqual(CLEAR);
    expect(haltOf(db, "silver", nextDay + 30 * DAY).halted).toBe(true);
  });

  it("ignores the TRANSIENT resync halt the engine sends before replacing a session, with or without a scope", () => {
    const db = book(halted(null, "operator resync", T0 + 1000, 10, "TRANSIENT"), halted(null, "operator resync", T0 + 2000, 5));
    expect(haltOf(db, "gold")).toEqual(CLEAR);
    expect(currentHalts(db, "qkt-prod", NOW)).toEqual({ instance: null, session: new Map(), snapshot: new Map(), byStrategy: new Map() });
  });

  it("keeps a standing halt when a later TRANSIENT halt arrives", () => {
    const db = book(halted("gold", "max drawdown", T0 + 1000, 10, "PERSISTENT"), halted("gold", "operator resync", T0 + 2000, 11, "TRANSIENT"));
    expect(haltOf(db, "gold")).toMatchObject({ halted: true, haltReason: "max drawdown" });
  });

  it("applies a session halt that names its strategies only to those, until a resume naming them", () => {
    const halt = halted(null, "operator", T0 + 1000, 10, "PERSISTENT", ["gold"]);
    const db = book(halt);
    expect(haltOf(db, "gold")).toEqual({ halted: true, haltReason: "operator", haltScope: "PERSISTENT", haltPersistent: true, haltedAt: T0 + 1000 });
    expect(haltOf(db, "silver")).toEqual(CLEAR);

    expect(haltOf(book(halt, resumed(null, T0 + 2000, 11, ["silver"])), "gold").halted).toBe(true);
    const cleared = book(halt, resumed(null, T0 + 2000, 11, ["gold"]));
    expect(haltOf(cleared, "gold")).toEqual(CLEAR);
    expect(haltOf(cleared, "silver")).toEqual(CLEAR);
  });

  it("keeps two sessions' halts apart on one instance", () => {
    const db = book(
      halted(null, "account drawdown", T0 + 1000, 10, "DAILY", ["gold"]),
      halted(null, "operator", T0 + 1500, 3, "PERSISTENT", ["silver"]),
      resumed(null, T0 + 2000, 11, ["gold"]),
    );
    expect(haltOf(db, "gold")).toEqual(CLEAR);
    expect(haltOf(db, "silver")).toMatchObject({ halted: true, haltReason: "operator", haltPersistent: true });
  });

  it("still applies an old-engine null halt without sessionStrategies to every strategy", () => {
    const db = book(halted(null, "max drawdown", T0 + 1000, 10));
    expect(haltOf(db, "gold")).toMatchObject({ halted: true, haltReason: "max drawdown", haltScope: null });
    expect(haltOf(db, "silver")).toMatchObject({ halted: true, haltReason: "max drawdown", haltScope: null });
  });

  it("orders old instance-wide and new session events on one timeline", () => {
    const oldHalt = halted(null, "max drawdown", T0 + 1000, 10);
    // An upgraded session resumes its own strategy: the old halt stops covering gold only.
    const partlyResumed = book(oldHalt, resumed(null, T0 + 2000, 11, ["gold"]));
    expect(haltOf(partlyResumed, "gold")).toEqual(CLEAR);
    expect(haltOf(partlyResumed, "silver")).toMatchObject({ halted: true, haltReason: "max drawdown" });

    // A later instance-wide halt covers every strategy again, overriding the earlier session state.
    const rehalted = book(halted(null, "operator", T0 + 500, 9, "PERSISTENT", ["gold"]), resumed(null, T0 + 800, 10, ["gold"]), halted(null, "engine fault", T0 + 1000, 11));
    expect(haltOf(rehalted, "gold")).toMatchObject({ halted: true, haltReason: "engine fault" });
    expect(haltOf(rehalted, "silver")).toMatchObject({ halted: true, haltReason: "engine fault" });

    // An old-engine resume without the field clears every session halt, named or not.
    const allResumed = book(halted(null, "operator", T0 + 1000, 10, "PERSISTENT", ["gold"]), resumed(null, T0 + 2000, 11));
    expect(haltOf(allResumed, "gold")).toEqual(CLEAR);

    // A new session halt after an old instance-wide one: gold sees the later, silver keeps the old.
    const layered = book(oldHalt, halted(null, "daily loss", T0 + 2000, 11, "DAILY", ["gold"]));
    expect(haltOf(layered, "gold")).toMatchObject({ haltReason: "daily loss", haltScope: "DAILY" });
    expect(haltOf(layered, "silver")).toMatchObject({ haltReason: "max drawdown", haltScope: null });
  });

  it("keeps precedence between a strategy's own halt and its session halt", () => {
    const db = book(
      halted("gold", "max drawdown", T0 + 1000, 10, "PERSISTENT"),
      halted(null, "daily loss", T0 + 2000, 11, "DAILY", ["gold", "silver"]),
    );
    expect(haltOf(db, "gold")).toMatchObject({ haltReason: "max drawdown", haltPersistent: true });
    expect(haltOf(db, "silver")).toMatchObject({ haltReason: "daily loss", haltPersistent: false });
    expect(haltOf(db, "gold", (Math.floor(T0 / DAY) + 1) * DAY)).toMatchObject({ haltReason: "max drawdown" });
    expect(haltOf(db, "silver", (Math.floor(T0 / DAY) + 1) * DAY)).toEqual(CLEAR);
  });

  it("scopes halts to their instance", () => {
    const db = book(halted(null, "operator", T0 + 1000, 10, "PERSISTENT"));
    ingestEvents(db, "qkt-other", [{ ...started("gold"), instanceId: "qkt-other" }]);
    expect(listStrategies(db, "qkt-other", NOW).find((r) => r.strategyId === "gold")!.halted).toBe(false);
    expect(strategyHalt(currentHalts(db, "qkt-other", NOW), "gold")).toEqual(CLEAR);
  });
});

// qkt#1244 (v0.52.4): every session sends one risk.snapshot per strategy when it starts, with
// the strategy's effective halt (RiskStateSnapshot.riskSnapshotOf). seq is always 0.
function snapshot(strategyId: string, ts: number, halt: { reason: string; scope: string; haltedAt: number | null } | null): Envelope {
  return env({
    id: `risk-snapshot-${strategyId}-${ts}`, type: "risk.snapshot", strategyId, ts, seq: 0,
    payload: {
      strategyId, ts, halted: halt != null, haltReason: halt?.reason ?? null, haltScope: halt?.scope ?? null,
      haltPersistent: halt ? halt.scope === "PERSISTENT" : null, haltedAt: halt?.haltedAt ?? null,
    },
  });
}

describe("halt state from risk snapshots", () => {
  // The quant-live shape: a pre-#1244 engine's global drawdown halt reached insights as a
  // null-strategy halt with no sessionStrategies, but only one session was halted.
  const QUANT_LIVE = ["eurusd_rsi_fade", "silver_ema_cross", "gold_breakout", "gbpusd_trend", "btc_momentum"];
  const T1 = T0 + 600_000;
  const drawdown = "global drawdown 0.1004 exceeds max 0.1";

  function quantLive(...events: Envelope[]): Db {
    const db = openDb(":memory:");
    ingestEvents(db, "qkt-prod", [...QUANT_LIVE.map(started), halted(null, drawdown, T0, 40), ...events]);
    return db;
  }
  const restartSnapshots = () => QUANT_LIVE.map((id) =>
    id === "eurusd_rsi_fade" ? snapshot(id, T1, { reason: drawdown, scope: "PERSISTENT", haltedAt: T0 })
    : id === "silver_ema_cross" ? snapshot(id, T1, { reason: "daily loss 2.1% exceeds max 2%", scope: "DAILY", haltedAt: T1 - 60_000 })
    : snapshot(id, T1, null));

  it("before any snapshot, the old instance-wide halt still marks every strategy", () => {
    const db = quantLive();
    for (const id of QUANT_LIVE) expect(haltOf(db, id).halted).toBe(true);
  });

  it("start snapshots mark only the strategies the engine reports halted", () => {
    const db = quantLive(...restartSnapshots());
    expect(haltOf(db, "eurusd_rsi_fade")).toEqual({ halted: true, haltReason: drawdown, haltScope: "PERSISTENT", haltPersistent: true, haltedAt: T0 });
    expect(haltOf(db, "silver_ema_cross")).toEqual({
      halted: true, haltReason: "daily loss 2.1% exceeds max 2%", haltScope: "DAILY", haltPersistent: false, haltedAt: T1 - 60_000,
    });
    for (const id of ["gold_breakout", "gbpusd_trend", "btc_momentum"]) expect(haltOf(db, id)).toEqual(CLEAR);
  });

  it("a later strategy-scoped resume clears a snapshot halt, and leaves the others", () => {
    const db = quantLive(...restartSnapshots(), resumed("silver_ema_cross", T1 + 5000, 3));
    expect(haltOf(db, "silver_ema_cross")).toEqual(CLEAR);
    expect(haltOf(db, "eurusd_rsi_fade").halted).toBe(true);
    expect(haltOf(db, "gold_breakout")).toEqual(CLEAR);
  });

  it("a session resume naming the strategy, or an instance-wide resume, clears a snapshot halt", () => {
    expect(haltOf(quantLive(...restartSnapshots(), resumed(null, T1 + 5000, 3, ["eurusd_rsi_fade"])), "eurusd_rsi_fade")).toEqual(CLEAR);
    expect(haltOf(quantLive(...restartSnapshots(), resumed(null, T1 + 5000, 3, ["gold_breakout"])), "eurusd_rsi_fade").halted).toBe(true);
    const all = quantLive(...restartSnapshots(), resumed(null, T1 + 5000, 3));
    for (const id of QUANT_LIVE) expect(haltOf(all, id)).toEqual(CLEAR);
  });

  it("a halted:false snapshot after an old instance-wide halt clears that strategy only", () => {
    const db = quantLive(snapshot("gold_breakout", T1, null));
    expect(haltOf(db, "gold_breakout")).toEqual(CLEAR);
    for (const id of QUANT_LIVE.filter((i) => i !== "gold_breakout")) expect(haltOf(db, id)).toMatchObject({ halted: true, haltReason: drawdown });
  });

  it("a halted:false snapshot also clears the strategy's own and session halts", () => {
    const db = book(
      halted("gold", "loss streak 3", T0 + 1000, 10, "PERSISTENT"),
      halted(null, "operator", T0 + 1100, 11, "PERSISTENT", ["gold", "silver"]),
      snapshot("gold", T0 + 2000, null),
    );
    expect(haltOf(db, "gold")).toEqual(CLEAR);
    expect(haltOf(db, "silver")).toMatchObject({ halted: true, haltReason: "operator" });
  });

  it("applies events after a snapshot on top of it", () => {
    const db = quantLive(...restartSnapshots(), halted("gold_breakout", "loss streak 3", T1 + 1000, 5, "PERSISTENT"), halted(null, "engine fault", T1 + 2000, 6));
    expect(haltOf(db, "gold_breakout")).toMatchObject({ haltReason: "loss streak 3", haltPersistent: true });
    // A later instance-wide halt from an older engine covers everyone again; a persistent snapshot halt still wins for eurusd.
    expect(haltOf(db, "btc_momentum")).toMatchObject({ halted: true, haltReason: "engine fault" });
    expect(haltOf(db, "eurusd_rsi_fade")).toMatchObject({ haltReason: drawdown, haltPersistent: true });
  });

  it("times a snapshot halt by haltedAt, else by the snapshot, for DAILY expiry", () => {
    const nextDay = (Math.floor(T0 / DAY) + 1) * DAY;
    const tripped = book(snapshot("gold", nextDay + 1000, { reason: "daily loss", scope: "DAILY", haltedAt: nextDay - 1000 }));
    expect(haltOf(tripped, "gold", nextDay + 2000)).toEqual(CLEAR);
    const untimed = book(snapshot("gold", nextDay + 1000, { reason: "daily loss", scope: "DAILY", haltedAt: null }));
    expect(haltOf(untimed, "gold", nextDay + 2000)).toMatchObject({ halted: true, haltedAt: nextDay + 1000 });
  });

  it("ignores a risk snapshot without a halted field (older engines' risk snapshots)", () => {
    const db = book(halted(null, "max drawdown", T0 + 1000, 10),
      env({ id: "snap-old", type: "risk.snapshot", strategyId: "gold", ts: T0 + 2000, payload: { strategyId: "gold", equity: 980, dailyLoss: 20 } }));
    expect(haltOf(db, "gold")).toMatchObject({ halted: true, haltReason: "max drawdown" });
  });
});
