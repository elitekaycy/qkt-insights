import { describe, it, expect } from "vitest";
import { openDb, ingestEvents, persistStateEvent, pathBuckets, positionPath, roundTripDetail, PATH_FLAT_MS, PATH_GAP_MS, type Db } from "../src/index.js";
import type { Envelope } from "@qkt-insights/contract";

const M = 60_000;
const H = 60 * M;
const T0 = Date.UTC(2026, 2, 2, 8); // Mon 08:00 UTC
const I = "i1";
const S = "alpha";

let seq = 0;
function deal(ticket: string, entry: "IN" | "OUT", ts: number, price: number, profit = 0, side: "BUY" | "SELL" = entry === "IN" ? "SELL" : "BUY"): Envelope {
  return {
    v: 1, instanceId: I, id: `deal-${ticket}`, seq: seq++, ts, type: "broker.deal",
    payload: { broker: "B", dealTicket: ticket, positionTicket: "P1", symbol: "B:EURUSD", side, entry, qty: 1, price, profit, strategyId: S, ts },
  } as Envelope;
}

/** A broker poll of the short P1 (entry 1.1000, 1 lot = 100,000 units): profit follows the price exactly. */
function mark(db: Db, ts: number, price: number, swap = 0): void {
  persistStateEvent(db, I, {
    v: 1, instanceId: I, id: `m-${seq}`, seq: seq++, ts, type: "state.positions",
    payload: { broker: "B", positions: [{ ticket: "P1", symbol: "B:EURUSD", side: "SELL", qty: 1, entryPrice: 1.1, currentPrice: price, profit: Math.round((1.1 - price) * 100_000 * 100) / 100, swap, strategyId: S }] },
  } as Envelope);
}

function shortWithMarks(prices: Array<[number, number]>): Db {
  seq = 0;
  const db = openDb(":memory:");
  ingestEvents(db, I, [deal("1", "IN", T0, 1.1)]);
  for (const [ts, p] of prices) mark(db, ts, p);
  return db;
}

describe("positionPath", () => {
  it("builds UTC candles from the marks, and the best, worst and latest marks by P&L", () => {
    const db = shortWithMarks([
      [T0 + 1 * M, 1.1002], // -20
      [T0 + 3 * M, 1.0990], // +100
      [T0 + 7 * M, 1.1010], // -100, the worst
      [T0 + 16 * M, 1.0975], // +250, the best
      [T0 + 18 * M, 1.0985], // +150, the latest
    ]);
    const p = positionPath(db, I, "P1", 5 * M, T0 + 20 * M)!;
    expect(p.status).toBe("open");
    expect(p.side).toBe("short");
    expect(p.entry).toEqual({ ts: T0, price: 1.1 });
    expect(p.exit).toBeNull();
    expect(p.bucketMs).toBe(5 * M);
    expect(p.candles).toEqual([
      { t: T0, o: 1.1002, h: 1.1002, l: 1.099, c: 1.099, marks: 2 },
      { t: T0 + 5 * M, o: 1.101, h: 1.101, l: 1.101, c: 1.101, marks: 1 },
      { t: T0 + 15 * M, o: 1.0975, h: 1.0985, l: 1.0975, c: 1.0985, marks: 2 },
    ]);
    expect(p.best).toEqual({ ts: T0 + 16 * M, price: 1.0975, pnl: 250 });
    expect(p.worst).toEqual({ ts: T0 + 7 * M, price: 1.101, pnl: -100 });
    expect(p.last).toEqual({ ts: T0 + 18 * M, price: 1.0985, pnl: 150, swap: 0 });
    expect(p.marks).toBe(5);
    expect(p.firstMarkTs).toBe(T0 + M);
  });

  it("leaves a stretch without marks empty and reports it as a gap, never bridging it", () => {
    const db = shortWithMarks([[T0 + M, 1.1], [T0 + 2 * M, 1.1001], [T0 + 2 * M + 3 * H, 1.0999]]);
    const p = positionPath(db, I, "P1", 15 * M, T0 + 4 * H)!;
    expect(p.candles.map((c) => c.t)).toEqual([T0, T0 + 3 * H]);
    expect(p.gaps).toBe(1);
    expect(p.longestGap).toEqual({ from: T0 + 2 * M, to: T0 + 2 * M + 3 * H });
    expect(p.gapSpans).toEqual([{ from: T0 + 2 * M, to: T0 + 2 * M + 3 * H }]);
    // the poll heartbeat (5 minutes) is not a gap
    const steady = shortWithMarks([[T0 + M, 1.1], [T0 + 6 * M, 1.1], [T0 + 11 * M, 1.1]]);
    expect(positionPath(steady, I, "P1", undefined, T0 + 12 * M)!.gaps).toBe(0);
    expect(PATH_GAP_MS).toBe(15 * M);
  });

  it("keeps both edges of a gap on the P&L line, inside a bucket too", () => {
    const marks: Array<[number, number]> = [];
    for (let i = 1; i <= 10; i++) marks.push([T0 + i * M, 1.1 - i * 0.00001]); // rising P&L, the 10th is the bucket's best
    for (let i = 0; i < 10; i++) marks.push([T0 + 40 * M + i * M, 1.1 + i * 0.00001]);
    marks.push([T0 + 5 * H, 1.1]);
    // 1.0999 at 08:12 is not an extreme of its hour, but it is the last mark before the 28-minute gap
    marks.splice(10, 0, [T0 + 12 * M, 1.09995]);
    const db = shortWithMarks(marks);
    const p = positionPath(db, I, "P1", H, T0 + 6 * H)!;
    expect(p.gapSpans).toEqual([{ from: T0 + 12 * M, to: T0 + 40 * M }, { from: T0 + 49 * M, to: T0 + 5 * H }]);
    const ts = p.pnl.map((x) => x.ts);
    expect(ts).toContain(T0 + 12 * M);
    expect(ts).toContain(T0 + 40 * M);
    expect(ts).toContain(T0 + 49 * M);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });

  it("marks a stretch at one unchanged price for an hour or more as flat, a gap ends it", () => {
    const marks: Array<[number, number]> = [[T0 + M, 1.1], [T0 + 2 * M, 1.0999]];
    // a weekend's heartbeats: one price every 5 minutes for 3 hours
    for (let i = 0; i <= 36; i++) marks.push([T0 + 3 * M + i * 5 * M, 1.0998]);
    // 50 minutes flat is not enough
    for (let i = 0; i <= 10; i++) marks.push([T0 + 4 * H + i * 5 * M, 1.0997]);
    marks.push([T0 + 5 * H, 1.0995]);
    const db = shortWithMarks(marks);
    const p = positionPath(db, I, "P1", undefined, T0 + 6 * H)!;
    expect(p.flatSpans).toEqual([{ from: T0 + 3 * M, to: T0 + 3 * M + 180 * M }]);
    expect(PATH_FLAT_MS).toBe(H);
    // a gap inside a flat run splits it: neither side reaches an hour here
    const split = shortWithMarks([[T0, 1.1], [T0 + 40 * M, 1.1], [T0 + 70 * M, 1.1], [T0 + 100 * M, 1.1]]);
    expect(positionPath(split, I, "P1", undefined, T0 + 2 * H)!.flatSpans).toEqual([]);
  });

  it("keeps every extreme on the P&L line: first, lowest, highest and last of each bucket", () => {
    const marks: Array<[number, number]> = [];
    // 30 marks in one hour bucket zig-zagging, the extremes in the middle
    for (let i = 0; i < 30; i++) marks.push([T0 + i * M + 1000, 1.1 + (i === 11 ? 0.003 : i === 19 ? -0.004 : (i % 2) * 0.0001)]);
    marks.push([T0 + 3 * H, 1.1]); // a later mark, so the window offers hour candles
    const db = shortWithMarks(marks);
    const p = positionPath(db, I, "P1", H, T0 + 4 * H)!;
    expect(p.bucketMs).toBe(H);
    expect(p.pnl.map((x) => x.ts)).toEqual([T0 + 1000, T0 + 11 * M + 1000, T0 + 19 * M + 1000, T0 + 29 * M + 1000, T0 + 3 * H]);
    expect(p.pnl.map((x) => x.pnl)).toEqual([0, -300, 400, -10, 0]);
    expect(p.best!.pnl).toBe(400);
    expect(p.worst!.pnl).toBe(-300);
  });

  it("agrees with the drawer's MAE/MFE read over the same marks", () => {
    const db = shortWithMarks([[T0 + M, 1.1012], [T0 + 9 * M, 1.0968], [T0 + 30 * M, 1.1004]]);
    const p = positionPath(db, I, "P1", undefined, T0 + H)!;
    const ex = roundTripDetail(db, I, "P1")!.excursion!;
    expect(ex.mae).toBeCloseTo(p.worst!.pnl, 9);
    expect(ex.mfe).toBeCloseTo(p.best!.pnl, 9);
    expect(ex.marks).toBe(p.marks);
  });

  it("closes the window at the exit: a later mark is not part of the trade", () => {
    const db = shortWithMarks([[T0 + M, 1.0990], [T0 + 10 * M, 1.0980]]);
    ingestEvents(db, I, [deal("2", "OUT", T0 + 20 * M, 1.0985, 150)]);
    mark(db, T0 + 25 * M, 1.05); // a stale poll after the close
    const p = positionPath(db, I, "P1", undefined, T0 + H)!;
    expect(p.status).toBe("closed");
    expect(p.exit).toEqual({ ts: T0 + 20 * M, price: 1.0985 });
    expect(p.marks).toBe(2);
    expect(p.best!.pnl).toBe(200);
  });

  it("is null for an unknown ticket and empty, not zero, without marks", () => {
    const db = shortWithMarks([]);
    expect(positionPath(db, I, "nope")).toBeNull();
    const p = positionPath(db, I, "P1", undefined, T0 + H)!;
    expect(p.candles).toEqual([]);
    expect(p.pnl).toEqual([]);
    expect(p.best).toBeNull();
    expect(p.worst).toBeNull();
    expect(p.last).toBeNull();
    expect(p.marks).toBe(0);
  });

  it("carries the swap of the latest mark", () => {
    const db = shortWithMarks([[T0 + M, 1.0990]]);
    mark(db, T0 + 2 * M, 1.0990, -3.25);
    expect(positionPath(db, I, "P1", undefined, T0 + H)!.last).toEqual({ ts: T0 + 2 * M, price: 1.099, pnl: 100, swap: -3.25 });
  });

  it("picks a candle size that keeps the chart readable and offers the sizes that fit", () => {
    expect(pathBuckets(30 * M)).toEqual({ auto: M, offered: [M, 5 * M, 15 * M] });
    expect(pathBuckets(12 * 24 * H).auto).toBe(4 * H);
    expect(pathBuckets(12 * 24 * H).offered).toEqual([15 * M, 30 * M, H, 4 * H, 24 * H]);
    expect(pathBuckets(0)).toEqual({ auto: M, offered: [M] });
    // a size the window does not offer falls back to the automatic one
    const db = shortWithMarks([[T0 + M, 1.1]]);
    expect(positionPath(db, I, "P1", 24 * H, T0 + 10 * M)!.bucketMs).toBe(M);
  });
});
