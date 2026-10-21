import { describe, it, expect } from "vitest";
import {
  openDb, accountDrawdown, accountDrawdownScan, accountEquity, accountEquityScan, accountRisk, accountRiskScan,
  monthBases, monthBasesScan, rebuildProjection, refreshProjections, LiveStateStore, type Db,
} from "../src/index.js";
import type { Envelope } from "@qkt-insights/contract";

const M = 60_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 5, 28, 22);
const I = "i1";

/** Small deterministic PRNG, so a failing case replays. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

interface Row { broker: string; minute: number; equity: number; balance: number; account: string | null }

/**
 * Account minutes the way they arrive in production: a relabel that takes turns with the original
 * label (sharing a handover minute), a second account reporting in the same minutes, an identity
 * that appears part way, and equity wandering around a level in awkward cents.
 */
function scenario(seed: number, minutes: number): Row[] {
  const r = rng(seed);
  const rows: Row[] = [];
  let a = 10_000, b = 50_000, ts = T0;
  const handover = Math.ceil(minutes / 15) * 5;
  for (let i = 0; i < minutes; i++) {
    ts += M * (1 + Math.floor(r() * 3));
    a += Math.round((r() - 0.5) * 9000) / 100;
    b += Math.round((r() - 0.52) * 30000) / 100;
    const relabel = i > handover && i < (2 * minutes) / 3;
    rows.push({ broker: relabel ? "ACC_NEW" : "ACC", minute: ts, equity: a, balance: Math.round(a), account: i > minutes / 2 ? "1001@Demo" : null });
    // Both labels of the relabeled account report the handover minute (the other account does not).
    if (i === handover) rows.push({ broker: "ACC_NEW", minute: ts, equity: a + 1, balance: Math.round(a), account: null });
    if (i % 5 !== 0) rows.push({ broker: "OTHER", minute: ts, equity: b, balance: Math.round(b), account: "2002@Live" });
  }
  return rows;
}

function insert(db: Db, rows: Row[]): void {
  const ins = db.prepare(
    `INSERT INTO account_equity (instance_id, broker, minute_ts, balance, equity, open_profit, account) VALUES (?,?,?,?,?,0,?)
     ON CONFLICT(instance_id, broker, minute_ts) DO UPDATE SET balance=excluded.balance, equity=excluded.equity, account=COALESCE(excluded.account, account)`,
  );
  for (const x of rows) ins.run(I, x.broker, x.minute, x.balance, x.equity, x.account);
}

/** Every account read, projected and by full scan, at a set of cutoffs. */
function expectProjectedEqualsScan(db: Db, cutoffs: number[]): void {
  const limits = { "*": { maxDrawdownPct: 10, dailyLossPct: 5, dailyResetHour: 22, timezone: "UTC" } };
  for (const to of cutoffs) {
    expect(accountDrawdown(db, { instanceId: I, to })).toEqual(accountDrawdownScan(db, { instanceId: I, to }));
    expect(accountRisk(db, { instanceId: I, now: to, limits })).toEqual(accountRiskScan(db, { instanceId: I, now: to, limits }));
    const months = ["2026-06", "2026-07", "2026-08"];
    expect(monthBases(db, { instanceId: I, months, to })).toEqual(monthBasesScan(db, { instanceId: I, months, to }));
    for (const points of [2, 40, 333, 5000]) {
      expect(accountEquity(db, { instanceId: I, to, points })).toEqual(accountEquityScan(db, { instanceId: I, to, points }));
      expect(accountEquity(db, { instanceId: I, from: to - DAY, to, points })).toEqual(accountEquityScan(db, { instanceId: I, from: to - DAY, to, points }));
    }
  }
  expect(accountDrawdown(db, { instanceId: I })).toEqual(accountDrawdownScan(db, { instanceId: I }));
  expect(accountEquity(db, { instanceId: I })).toEqual(accountEquityScan(db, { instanceId: I }));
}

describe("account projections", () => {
  for (const seed of [1, 2, 3]) {
    it(`answer drawdown, risk, month bases and sampled equity as the full scan does (seed ${seed})`, () => {
      const db = openDb(":memory:");
      const rows = scenario(seed, 900);
      const r = rng(seed + 100);
      // Mostly in order, as the minute rollup writes, with stragglers and rewrites of a minute.
      const late = rows.filter(() => r() < 0.05);
      const onTime = rows.filter((x) => !late.includes(x));
      for (let i = 0; i < onTime.length; i += 37) {
        insert(db, onTime.slice(i, i + 37));
        refreshProjections(db);
      }
      insert(db, late);
      insert(db, rows.filter(() => r() < 0.02).map((x) => ({ ...x, equity: x.equity - 7.77 })));
      const span = rows[rows.length - 1]!.minute - T0;
      const cutoffs = [0.1, 0.34, 0.5, 0.77, 1.01].map((k) => T0 + Math.floor(span * k));
      // The projection, not its fallback, answers: the grouping is stored and no minute has three labels.
      refreshProjections(db);
      expect(db.prepare("SELECT chains FROM account_groups").get()).toEqual({ chains: JSON.stringify([["ACC", "ACC_NEW"], ["OTHER"]]) });
      expect(db.prepare("SELECT COUNT(*) n FROM account_minute_labels WHERE n >= 3").get()).toEqual({ n: 0 });
      expectProjectedEqualsScan(db, cutoffs);
      // The rebuilt projection answers the same.
      rebuildProjection(db, "account_drawdown", { force: true });
      expectProjectedEqualsScan(db, cutoffs);
    });
  }

  it("keeps the walks in step with the minute rollup, including a minute flushed twice", () => {
    const db = openDb(":memory:");
    const live = new LiveStateStore();
    const env = (ts: number, broker: string, equity: number): Envelope => ({
      v: 1, instanceId: I, id: `a-${ts}-${broker}`, seq: 0, ts, type: "state.account",
      payload: { broker, currency: "USD", balance: 1000, equity, login: "7", server: "S" },
    } as Envelope);
    for (let i = 0; i < 200; i++) {
      const ts = T0 + i * M;
      live.upsert(I, env(ts, "B", 1000 + Math.sin(i) * 40));
      live.flushRollup(db, ts);
      if (i % 9 === 0) { live.upsert(I, env(ts + 20_000, "B", 900)); live.flushRollup(db, ts + 20_000); }
    }
    expectProjectedEqualsScan(db, [T0 + 50 * M, T0 + 199 * M]);
  });

  it("falls back to the full scan for a minute without equity or one three labels share", () => {
    const db = openDb(":memory:");
    insert(db, scenario(7, 120));
    db.prepare("INSERT INTO account_equity (instance_id, broker, minute_ts, balance, equity, open_profit) VALUES (?, 'ACC', ?, 1, NULL, 0)").run(I, T0 + 10_000 * M);
    expectProjectedEqualsScan(db, [T0 + 60 * M, T0 + 20_000 * M]);
    db.prepare("DELETE FROM account_equity WHERE equity IS NULL").run();
    insert(db, [{ broker: "THIRD", minute: T0, equity: 5, balance: 5, account: null }, { broker: "ACC_NEW", minute: T0, equity: 6, balance: 6, account: null }]);
    expectProjectedEqualsScan(db, [T0 + 60 * M]);
  });
});
