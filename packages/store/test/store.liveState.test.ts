import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import { LiveStateStore } from "../src/index.js";
import type { Envelope } from "@qkt-insights/contract";

const T0 = 1718000000000;

function accountEnv(ts: number, payload: Record<string, unknown> = {}): Envelope {
  return { v: 1, instanceId: "qkt-prod", id: `acct-EXNESS-${ts}`, seq: 1, ts, type: "state.account",
    payload: { broker: "EXNESS", currency: "USD", balance: 7824.05, equity: 7676.54, openProfit: -147.51, ...payload } } as Envelope;
}

function positionsEnv(ts: number, positions: unknown[]): Envelope {
  return { v: 1, instanceId: "qkt-prod", id: `posn-EXNESS-${ts}`, seq: 1, ts, type: "state.positions",
    payload: { broker: "EXNESS", positions } } as Envelope;
}

const pos = { ticket: "123", symbol: "EXNESS:XAUUSD", side: "BUY", qty: 0.01,
  entryPrice: 2300.5, currentPrice: 2310.2, profit: 9.7, strategyId: "hedge_straddle" };

describe("LiveStateStore", () => {
  it("upserts account state keyed by instance:broker and reports staleness", () => {
    const store = new LiveStateStore();
    expect(store.upsert("qkt-prod", accountEnv(T0))).toBe(true);
    const fresh = store.snapshot(T0 + 1000);
    expect(fresh.accounts).toHaveLength(1);
    expect(fresh.accounts[0]).toMatchObject({
      instanceId: "qkt-prod", broker: "EXNESS", currency: "USD",
      balance: 7824.05, equity: 7676.54, openProfit: -147.51, stale: false,
    });
    const stale = store.snapshot(T0 + 60_000);
    expect(stale.accounts[0]!.stale).toBe(true);
  });

  it("replaces the full position list per state.positions envelope", () => {
    const store = new LiveStateStore();
    store.upsert("qkt-prod", positionsEnv(T0, [pos, { ...pos, ticket: "124" }]));
    store.upsert("qkt-prod", positionsEnv(T0 + 10_000, [pos]));
    const snap = store.snapshot(T0 + 11_000);
    expect(snap.positions).toHaveLength(1);
    expect(snap.positions[0]!.list).toHaveLength(1);
    expect(snap.positions[0]!.list[0]).toMatchObject({ ticket: "123", strategyId: "hedge_straddle" });
    expect(snap.positions[0]!.stale).toBe(false);
  });

  it("upsert returns false when nothing changed", () => {
    const store = new LiveStateStore();
    expect(store.upsert("qkt-prod", accountEnv(T0))).toBe(true);
    expect(store.upsert("qkt-prod", accountEnv(T0 + 10_000))).toBe(false);
    expect(store.upsert("qkt-prod", accountEnv(T0 + 20_000, { equity: 7700 }))).toBe(true);
    expect(store.upsert("qkt-prod", positionsEnv(T0, [pos]))).toBe(true);
    expect(store.upsert("qkt-prod", positionsEnv(T0 + 10_000, [pos]))).toBe(false);
    expect(store.upsert("qkt-prod", positionsEnv(T0 + 20_000, []))).toBe(true);
  });

  it("keeps the freshest payload even when unchanged so staleness tracks lastSeen", () => {
    const store = new LiveStateStore();
    store.upsert("qkt-prod", accountEnv(T0));
    store.upsert("qkt-prod", accountEnv(T0 + 40_000));
    expect(store.snapshot(T0 + 45_000).accounts[0]!.stale).toBe(false);
  });

  it("flushRollup writes one account_equity row per instance:broker minute", () => {
    const db = openDb(":memory:");
    const store = new LiveStateStore();
    store.upsert("qkt-prod", accountEnv(T0));
    store.upsert("other", accountEnv(T0));
    const now = 1718000065000;
    store.flushRollup(db, now);
    const rows: any[] = db.prepare("SELECT * FROM account_equity ORDER BY instance_id").all();
    expect(rows).toHaveLength(2);
    const minute = Math.floor(now / 60_000) * 60_000;
    expect(rows[1]).toMatchObject({ instance_id: "qkt-prod", broker: "EXNESS", minute_ts: minute,
      balance: 7824.05, equity: 7676.54, open_profit: -147.51 });
    store.upsert("qkt-prod", accountEnv(T0 + 10_000, { equity: 7700 }));
    store.flushRollup(db, now + 1000);
    const updated: any = db.prepare("SELECT equity FROM account_equity WHERE instance_id='qkt-prod' AND minute_ts=?").get(minute);
    expect(updated.equity).toBe(7700);
    expect(db.prepare("SELECT COUNT(*) c FROM account_equity").get()).toMatchObject({ c: 2 });
  });
});
