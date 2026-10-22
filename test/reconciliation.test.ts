import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { openDb, ingestEvents, LiveStateStore, reconciliation } from "@qkt-insights/store";
import type { Envelope } from "@qkt-insights/contract";
import { nextNightlyRun, reconcileAll, venuePositions } from "../src/reconciliation.js";

const I = "qkt-live";
const ACCOUNT = "mt5:00000000000000bb";
const OCT = (day: number, hour = 0, minute = 0, second = 0) => Date.UTC(2026, 9, day, hour, minute, second);

let seq = 0;
function env(type: string, ts: number, payload: Record<string, unknown>): Envelope {
  seq++;
  return { v: 1, instanceId: I, id: `e${seq}`, seq, ts, type, payload } as Envelope;
}

describe("nextNightlyRun", () => {
  it("is the next 02:00 UTC strictly after now", () => {
    expect(nextNightlyRun(OCT(21, 1, 59))).toBe(OCT(21, 2));
    expect(nextNightlyRun(OCT(21, 2))).toBe(OCT(22, 2));
    expect(nextNightlyRun(OCT(21, 13, 30))).toBe(OCT(22, 2));
    expect(nextNightlyRun(Date.UTC(2026, 11, 31, 23))).toBe(Date.UTC(2027, 0, 1, 2));
  });
});

describe("reconcileAll", () => {
  it("reconciles what ingest and the live state stored, with the venue's positions from the live state", async () => {
    const db = openDb(":memory:");
    const live = new LiveStateStore();
    const net = 75 - 1.5;
    for (let ts = OCT(1, 6); ts <= OCT(3, 1, 50); ts += 10 * 60_000) {
      const balance = 20_000 + (ts >= OCT(2, 10, 10) ? net : 0);
      live.upsert(I, env("state.account", ts, { broker: "ICM_S01", currency: "USD", balance, equity: balance, accountId: ACCOUNT }));
      live.flushRollup(db, ts);
    }
    ingestEvents(db, I, [
      env("broker.deal", OCT(2, 9), { broker: "ICM_S01", dealTicket: "1", positionTicket: "7", symbol: "ICM:XAUUSD", side: "BUY", entry: "IN", qty: 0.1, price: 2400, profit: 0, ts: OCT(2, 9), accountId: ACCOUNT }),
      env("broker.deal", OCT(2, 10, 0, 30), { broker: "ICM_S01", dealTicket: "2", positionTicket: "7", symbol: "ICM:XAUUSD", side: "SELL", entry: "OUT", qty: 0.1, price: 2407.5, profit: 75, commission: -1.5, ts: OCT(2, 10, 0, 30), accountId: ACCOUNT }),
      env("broker.deal", OCT(2, 20), { broker: "ICM_S01", dealTicket: "3", positionTicket: "8", symbol: "ICM:XAUUSD", side: "SELL", entry: "IN", qty: 0.2, price: 2410, profit: 0, ts: OCT(2, 20), accountId: ACCOUNT }),
    ]);
    const now = OCT(3, 2);
    live.upsert(I, env("state.positions", now - 10_000, { broker: "ICM_S01", accountId: ACCOUNT,
      positions: [{ ticket: "8", symbol: "ICM:XAUUSD", side: "SELL", qty: 0.2, entryPrice: 2410, openedAt: OCT(2, 20) }] }));
    expect(venuePositions(live, I, now)).toEqual([expect.objectContaining({ broker: "ICM", at: now - 10_000 })]);

    await reconcileAll({ db, liveState: live, log: Fastify({ logger: false }).log }, now);
    const r = reconciliation(db, I);
    expect(r.checkedAt).toBe(now);
    expect(r.accounts).toEqual([expect.objectContaining({
      account: ACCOUNT, label: "ICM", daysOk: 1, daysDiff: 0, daysIncomplete: 1, throughDay: "2026-10-02",
      positions: expect.objectContaining({ status: "ok", venueCount: 1, insightsCount: 1 }),
      ledger: expect.objectContaining({ status: "ok", trips: 1, tripsNet: 73.5 }),
    })]);
  });
});
