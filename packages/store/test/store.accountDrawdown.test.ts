import { describe, it, expect } from "vitest";
import { openDb, accountDrawdown } from "../src/index.js";

const M = 60_000;
const T0 = Date.UTC(2026, 7, 1);

function seed(db: ReturnType<typeof openDb>, broker: string, equities: number[]): void {
  const ins = db.prepare(
    "INSERT INTO account_equity (instance_id, broker, minute_ts, balance, equity, open_profit) VALUES ('i1', ?, ?, ?, ?, 0)",
  );
  equities.forEach((e, i) => ins.run(broker, T0 + i * M, e, e));
}

describe("accountDrawdown", () => {
  it("reports current and max drawdown as percent of the running peak", () => {
    const db = openDb(":memory:");
    // peak 110 -> trough 88 (20% dd) -> recover to 99 (10% below peak)
    seed(db, "ICM", [100, 110, 95, 88, 99]);
    const [row] = accountDrawdown(db, { instanceId: "i1" });
    expect(row).toBeDefined();
    expect(row!.broker).toBe("ICM");
    expect(row!.peakEquity).toBe(110);
    expect(row!.currentEquity).toBe(99);
    expect(row!.maxDdPct).toBeCloseTo(20, 5);
    expect(row!.currentDdPct).toBeCloseTo(10, 5);
    expect(row!.points).toBe(5);
  });

  it("keeps brokers separate and handles a fresh account at its peak", () => {
    const db = openDb(":memory:");
    seed(db, "A", [50, 60]);
    seed(db, "B", [200, 180, 190]);
    const rows = accountDrawdown(db, { instanceId: "i1" });
    const a = rows.find((r) => r.broker === "A")!;
    const b = rows.find((r) => r.broker === "B")!;
    expect(a.currentDdPct).toBeCloseTo(0, 5);
    expect(a.maxDdPct).toBeCloseTo(0, 5);
    expect(b.maxDdPct).toBeCloseTo(10, 5);
    expect(b.currentDdPct).toBeCloseTo(5, 5);
    expect(accountDrawdown(db, { instanceId: "nope" })).toEqual([]);
    // TOTAL row: forward-filled sum across brokers
    const tot = accountDrawdown(db, { instanceId: "i1" }).find((r) => r.broker === "TOTAL")!;
    expect(tot).toBeDefined();
    // minute 0: A=50,B=200 -> 250; minute1: A=60,B=180 -> 240; minute2: A=60(ffill),B=190 -> 250
    expect(tot.peakEquity).toBe(250);
    expect(tot.maxDdPct).toBeCloseTo(4, 5);
    expect(tot.currentDdPct).toBeCloseTo(0, 5);
  });

  it("TOTAL concatenates a relabeled account's disjoint series", () => {
    const db = openDb(":memory:");
    seed(db, "OLD", [100, 120, 96]);   // peak 120, trough 96 -> 20% dd
    const ins = db.prepare(
      "INSERT INTO account_equity (instance_id, broker, minute_ts, balance, equity, open_profit) VALUES ('i1', 'NEW', ?, ?, ?, 0)",
    );
    [108, 114].forEach((e, i) => ins.run(T0 + (10 + i) * M, e, e));
    const tot = accountDrawdown(db, { instanceId: "i1" }).find((r) => r.broker === "TOTAL")!;
    // disjoint series chain into one curve: 100,120,96,108,114 — never summed
    expect(tot.peakEquity).toBe(120);
    expect(tot.currentEquity).toBe(114);
    expect(tot.maxDdPct).toBeCloseTo(20, 5);
    expect(tot.currentDdPct).toBeCloseTo(5, 5);
  });

  it("TOTAL merges a relabel that interleaves with the original label", () => {
    const db = openDb(":memory:");
    const ins = db.prepare(
      "INSERT INTO account_equity (instance_id, broker, minute_ts, balance, equity, open_profit) VALUES ('i1', ?, ?, ?, ?, 0)",
    );
    // ICMARKETS reports, hands over to ICM for a while, then takes back over:
    // one account, date ranges overlapping, no minute reported twice.
    const curve: Array<[string, number]> = [
      ["ICMARKETS", 100], ["ICMARKETS", 120], ["ICM", 110], ["ICM", 96], ["ICMARKETS", 102], ["ICMARKETS", 108],
    ];
    curve.forEach(([b, e], i) => ins.run(b, T0 + i * M, e, e));
    const tot = accountDrawdown(db, { instanceId: "i1" }).find((r) => r.broker === "TOTAL")!;
    expect(tot.peakEquity).toBe(120);
    expect(tot.currentEquity).toBe(108);
    expect(tot.maxDdPct).toBeCloseTo(20, 5);
    expect(tot.currentDdPct).toBeCloseTo(10, 5);
  });

  it("TOTAL merges per-profile copies of one login that take turns reporting", () => {
    const db = openDb(":memory:");
    const ins = db.prepare(
      "INSERT INTO account_equity (instance_id, broker, minute_ts, balance, equity, open_profit) VALUES ('i1', ?, ?, ?, ?, 0)",
    );
    const labels = ["P174", "P1053", "P487"];
    [5000, 4990, 5010, 5005, 4995, 5000].forEach((e, i) => ins.run(labels[i % 3], T0 + i * M, e, e));
    const tot = accountDrawdown(db, { instanceId: "i1" }).find((r) => r.broker === "TOTAL")!;
    expect(tot.peakEquity).toBe(5010);
    expect(tot.currentEquity).toBe(5000);
  });
});
